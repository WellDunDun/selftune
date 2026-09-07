import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as Schema from "effect/Schema";

import type { StagedUseOnceWorkspace, UseOnceWorkspacePort } from "./contracts";
import { UseOnceHelperError } from "./errors";

/* oxlint-disable no-await-in-loop -- path traversal and owned cleanup are deliberately sequential. */

const DIRECTORY_PREFIX = "selftune-use-once-";
const MARKER = ".selftune-use-once-owned.json";
const LEASE = ".selftune-use-once-live-lease.json";
const RECOVERY_CLAIM = ".selftune-use-once-recovery-claim.json";
const MARKER_VERSION = 1;
export const STALE_WORKSPACE_TTL_MS = 6 * 60 * 60 * 1000;
export const WORKSPACE_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKSPACE_LEASE_ABANDONMENT_MS = 45_000;
export const WORKSPACE_RECOVERY_OBSERVATION_MS = 20_000;

const WorkspaceId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i));
const WorkspaceInstant = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
    expected: "a valid workspace timestamp",
  }),
);
const MarkerSchema = Schema.Struct({
  schemaVersion: Schema.Literal(MARKER_VERSION),
  instanceId: WorkspaceId,
  createdAt: WorkspaceInstant,
  expiresAt: WorkspaceInstant,
});
const LiveLeaseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  instanceId: WorkspaceId,
  leaseId: WorkspaceId,
  sequence: Schema.Number.check(
    Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0, {
      expected: "a nonnegative safe sequence",
    }),
  ),
  heartbeatAt: WorkspaceInstant,
});
const RecoveryClaimSchema = Schema.Struct({
  ...LiveLeaseSchema.fields,
  recoveryId: WorkspaceId,
  observedAt: WorkspaceInstant,
  expiresAt: WorkspaceInstant,
});
type Marker = typeof MarkerSchema.Type;
type LiveLease = typeof LiveLeaseSchema.Type;
type RecoveryClaim = typeof RecoveryClaimSchema.Type;

export interface UseOnceWorkspaceTiming {
  readonly now: () => Date;
  readonly heartbeatIntervalMs: number;
  readonly leaseAbandonmentMs: number;
  readonly recoveryObservationMs: number;
  readonly startInterval: (
    callback: () => void | Promise<void>,
    milliseconds: number,
  ) => () => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

async function isCurrentUser(path: string): Promise<boolean> {
  const uid = process.getuid?.();
  return uid === undefined || (await stat(path)).uid === uid;
}

async function assertContainedDirectory(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalCandidate = await realpath(candidate);
  const within = relative(canonicalRoot, canonicalCandidate);
  if (
    within.length === 0 ||
    within.startsWith(`..${sep}`) ||
    within === ".." ||
    resolve(canonicalRoot, within) !== canonicalCandidate
  ) {
    throw new UseOnceHelperError("WORKSPACE_UNSAFE", "Temporary workspace escaped its root.");
  }
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || !(await isCurrentUser(candidate))) {
    throw new UseOnceHelperError("WORKSPACE_UNSAFE", "Temporary workspace is not safely owned.");
  }
  return canonicalCandidate;
}

async function readOwnedJson<A>(path: string, schema: Schema.Decoder<A>): Promise<A> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !(await isCurrentUser(path)))
    throw new UseOnceHelperError("WORKSPACE_UNSAFE", "Workspace authority file is unsafe.");
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(await readFile(path, "utf8"), {
    onExcessProperty: "error",
  });
}

async function safeCleanup(
  tempRoot: string,
  directory: string,
  instanceId: string,
  leaseId: string,
  recovery?: {
    readonly recoveryId: string;
    readonly sequence: number;
    readonly heartbeatAt: string;
    readonly now: Date;
  },
): Promise<boolean> {
  if (!basename(directory).startsWith(DIRECTORY_PREFIX)) return false;
  const canonical = await assertContainedDirectory(tempRoot, directory);
  const markerPath = join(canonical, MARKER);
  const marker = await readOwnedJson(markerPath, MarkerSchema).catch(() => null);
  if (marker === null || marker.instanceId !== instanceId) return false;
  const lease = await readOwnedJson(join(canonical, LEASE), LiveLeaseSchema).catch(() => null);
  if (lease === null || lease.instanceId !== instanceId || lease.leaseId !== leaseId) return false;
  if (recovery !== undefined) {
    if (lease.sequence !== recovery.sequence || lease.heartbeatAt !== recovery.heartbeatAt)
      return false;
    const claim = await readOwnedJson(join(canonical, RECOVERY_CLAIM), RecoveryClaimSchema).catch(
      () => null,
    );
    if (
      claim === null ||
      claim.recoveryId !== recovery.recoveryId ||
      claim.instanceId !== instanceId ||
      claim.leaseId !== leaseId ||
      claim.sequence !== recovery.sequence ||
      claim.heartbeatAt !== recovery.heartbeatAt ||
      Date.parse(claim.expiresAt) <= recovery.now.getTime()
    )
      return false;
  }
  await rm(canonical, { recursive: true, force: true });
  return true;
}

async function createDirectoryPath(skillRoot: string, relativeDirectory: string): Promise<void> {
  if (relativeDirectory === "." || relativeDirectory.length === 0) return;
  let current = skillRoot;
  for (const segment of relativeDirectory.split(sep)) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new UseOnceHelperError("WORKSPACE_UNSAFE", "Package path crossed a link.");
    }
    await chmod(current, 0o700);
  }
}

async function writeExclusive(path: string, content: Uint8Array, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function makeOsUseOnceWorkspace(options?: {
  readonly temporaryRoot?: string;
  readonly now?: () => Date;
  readonly heartbeatIntervalMs?: number;
  readonly leaseAbandonmentMs?: number;
  readonly recoveryObservationMs?: number;
  readonly startInterval?: UseOnceWorkspaceTiming["startInterval"];
  readonly sleep?: UseOnceWorkspaceTiming["sleep"];
  readonly beforeRecoveryDelete?: () => Promise<void>;
}): UseOnceWorkspacePort {
  const temporaryRoot = options?.temporaryRoot ?? tmpdir();
  const now = options?.now ?? (() => new Date());
  const timing: UseOnceWorkspaceTiming = {
    now,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? WORKSPACE_HEARTBEAT_INTERVAL_MS,
    leaseAbandonmentMs: options?.leaseAbandonmentMs ?? WORKSPACE_LEASE_ABANDONMENT_MS,
    recoveryObservationMs: options?.recoveryObservationMs ?? WORKSPACE_RECOVERY_OBSERVATION_MS,
    startInterval:
      options?.startInterval ??
      ((callback, milliseconds) => {
        const handle = globalThis.setInterval(callback, milliseconds);
        handle.unref();
        return () => globalThis.clearInterval(handle);
      }),
    sleep:
      options?.sleep ??
      ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))),
  };
  return {
    async recoverStale() {
      const entries = await readdir(temporaryRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
        const directory = join(temporaryRoot, entry.name);
        try {
          const canonical = await assertContainedDirectory(temporaryRoot, directory);
          const marker = await readOwnedJson(join(canonical, MARKER), MarkerSchema);
          const createdAt = Date.parse(marker.createdAt);
          if (
            now().getTime() - createdAt < STALE_WORKSPACE_TTL_MS ||
            Date.parse(marker.expiresAt) > now().getTime()
          )
            continue;
          const observedLease = await readOwnedJson(join(canonical, LEASE), LiveLeaseSchema);
          if (
            observedLease.instanceId !== marker.instanceId ||
            now().getTime() - Date.parse(observedLease.heartbeatAt) < timing.leaseAbandonmentMs
          )
            continue;

          const recoveryId = randomUUID();
          const claimPath = join(canonical, RECOVERY_CLAIM);
          const claim: RecoveryClaim = {
            schemaVersion: 1,
            recoveryId,
            instanceId: marker.instanceId,
            leaseId: observedLease.leaseId,
            sequence: observedLease.sequence,
            heartbeatAt: observedLease.heartbeatAt,
            observedAt: now().toISOString(),
            expiresAt: new Date(
              now().getTime() + timing.recoveryObservationMs + timing.leaseAbandonmentMs,
            ).toISOString(),
          };
          await writeExclusive(claimPath, new TextEncoder().encode(JSON.stringify(claim)), 0o600);
          try {
            await timing.sleep(timing.recoveryObservationMs);
            const confirmedLease = await readOwnedJson(join(canonical, LEASE), LiveLeaseSchema);
            if (
              confirmedLease.instanceId !== observedLease.instanceId ||
              confirmedLease.leaseId !== observedLease.leaseId ||
              confirmedLease.sequence !== observedLease.sequence ||
              confirmedLease.heartbeatAt !== observedLease.heartbeatAt ||
              now().getTime() - Date.parse(confirmedLease.heartbeatAt) < timing.leaseAbandonmentMs
            )
              continue;
            await options?.beforeRecoveryDelete?.();
            await safeCleanup(temporaryRoot, canonical, marker.instanceId, confirmedLease.leaseId, {
              recoveryId,
              sequence: confirmedLease.sequence,
              heartbeatAt: confirmedLease.heartbeatAt,
              now: now(),
            });
          } finally {
            await unlink(claimPath).catch(() => undefined);
          }
        } catch {
          // Unknown, linked, malformed, or raced directories are never deleted.
        }
      }
    },
    async stage(input) {
      const directory = await mkdtemp(join(temporaryRoot, DIRECTORY_PREFIX));
      await chmod(directory, 0o700);
      const instanceId = randomUUID();
      const leaseId = randomUUID();
      const createdAt = now();
      const marker: Marker = {
        schemaVersion: MARKER_VERSION,
        instanceId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + STALE_WORKSPACE_TTL_MS).toISOString(),
      };
      let sequence = 0;
      let stopHeartbeat: (() => void) | undefined;
      let heartbeatPromise: Promise<void> | null = null;
      const leasePath = join(directory, LEASE);
      const leaseBytes = (): Uint8Array =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            instanceId,
            leaseId,
            sequence,
            heartbeatAt: now().toISOString(),
          } satisfies LiveLease),
        );
      const heartbeat = async (): Promise<void> => {
        sequence += 1;
        const temporaryLease = `${leasePath}.${leaseId}.${sequence}.tmp`;
        try {
          await writeExclusive(temporaryLease, leaseBytes(), 0o600);
          await rename(temporaryLease, leasePath);
        } finally {
          await unlink(temporaryLease).catch(() => undefined);
        }
      };
      const requestHeartbeat = (): Promise<void> => {
        if (heartbeatPromise !== null) return heartbeatPromise;
        const activeHeartbeat = heartbeat()
          .catch(() => undefined)
          .finally(() => {
            if (heartbeatPromise === activeHeartbeat) heartbeatPromise = null;
          });
        heartbeatPromise = activeHeartbeat;
        return activeHeartbeat;
      };
      try {
        await writeExclusive(
          join(directory, MARKER),
          new TextEncoder().encode(JSON.stringify(marker)),
          0o600,
        );
        await writeExclusive(leasePath, leaseBytes(), 0o600);
        stopHeartbeat = timing.startInterval(requestHeartbeat, timing.heartbeatIntervalMs);
        const skillDirectory = join(directory, "skill");
        await mkdir(skillDirectory, { mode: 0o700 });
        for (const file of input.files) {
          const target = join(skillDirectory, ...file.path.split("/"));
          const within = relative(skillDirectory, target);
          if (
            within.startsWith(`..${sep}`) ||
            within === ".." ||
            resolve(skillDirectory, within) !== target
          )
            throw new UseOnceHelperError("WORKSPACE_UNSAFE", "Package path escaped staging.");
          await createDirectoryPath(skillDirectory, dirname(within));
          await writeExclusive(target, file.content, 0o600);
        }
        let cleaned = false;
        const staged: StagedUseOnceWorkspace = {
          rootDirectory: directory,
          skillDirectory,
          async cleanup() {
            if (cleaned) return;
            stopHeartbeat?.();
            await heartbeatPromise;
            await safeCleanup(temporaryRoot, directory, instanceId, leaseId);
            cleaned = true;
          },
        };
        return staged;
      } catch (cause) {
        stopHeartbeat?.();
        await heartbeatPromise;
        await safeCleanup(temporaryRoot, directory, instanceId, leaseId).catch(() => undefined);
        if (cause instanceof UseOnceHelperError) throw cause;
        throw new UseOnceHelperError(
          "WORKSPACE_UNSAFE",
          "Could not stage the package safely.",
          cause,
        );
      }
    },
  };
}
