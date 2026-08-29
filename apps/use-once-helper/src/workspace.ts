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

interface Marker {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface LiveLease {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly leaseId: string;
  readonly sequence: number;
  readonly heartbeatAt: string;
}

interface RecoveryClaim {
  readonly schemaVersion: 1;
  readonly recoveryId: string;
  readonly instanceId: string;
  readonly leaseId: string;
  readonly sequence: number;
  readonly heartbeatAt: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface UseOnceWorkspaceTiming {
  readonly now: () => Date;
  readonly heartbeatIntervalMs: number;
  readonly leaseAbandonmentMs: number;
  readonly recoveryObservationMs: number;
  readonly setInterval: (callback: () => void | Promise<void>, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function ownedMarker(value: unknown): value is Marker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).toSorted().join(",") === "createdAt,expiresAt,instanceId,schemaVersion" &&
    input.schemaVersion === MARKER_VERSION &&
    typeof input.instanceId === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.instanceId) &&
    typeof input.createdAt === "string" &&
    Number.isFinite(Date.parse(input.createdAt)) &&
    typeof input.expiresAt === "string" &&
    Number.isFinite(Date.parse(input.expiresAt))
  );
}

function liveLease(value: unknown): value is LiveLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).toSorted().join(",") ===
      "heartbeatAt,instanceId,leaseId,schemaVersion,sequence" &&
    input.schemaVersion === 1 &&
    typeof input.instanceId === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.instanceId) &&
    typeof input.leaseId === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.leaseId) &&
    typeof input.sequence === "number" &&
    Number.isSafeInteger(input.sequence) &&
    input.sequence >= 0 &&
    typeof input.heartbeatAt === "string" &&
    Number.isFinite(Date.parse(input.heartbeatAt))
  );
}

function recoveryClaim(value: unknown): value is RecoveryClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).toSorted().join(",") ===
      "expiresAt,heartbeatAt,instanceId,leaseId,observedAt,recoveryId,schemaVersion,sequence" &&
    input.schemaVersion === 1 &&
    typeof input.recoveryId === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.recoveryId) &&
    typeof input.instanceId === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.instanceId) &&
    typeof input.leaseId === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.leaseId) &&
    typeof input.sequence === "number" &&
    Number.isSafeInteger(input.sequence) &&
    input.sequence >= 0 &&
    typeof input.heartbeatAt === "string" &&
    Number.isFinite(Date.parse(input.heartbeatAt)) &&
    typeof input.observedAt === "string" &&
    Number.isFinite(Date.parse(input.observedAt)) &&
    typeof input.expiresAt === "string" &&
    Number.isFinite(Date.parse(input.expiresAt))
  );
}

async function isCurrentUser(path: string): Promise<boolean> {
  if (typeof process.getuid !== "function") return true;
  return (await stat(path)).uid === process.getuid();
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

async function readOwnedJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !(await isCurrentUser(path)))
    throw new UseOnceHelperError("WORKSPACE_UNSAFE", "Workspace authority file is unsafe.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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
  const marker = await readOwnedJson(markerPath).catch(() => null);
  if (!ownedMarker(marker) || marker.instanceId !== instanceId) return false;
  const lease = await readOwnedJson(join(canonical, LEASE)).catch(() => null);
  if (!liveLease(lease) || lease.instanceId !== instanceId || lease.leaseId !== leaseId)
    return false;
  if (recovery !== undefined) {
    if (lease.sequence !== recovery.sequence || lease.heartbeatAt !== recovery.heartbeatAt)
      return false;
    const claim = await readOwnedJson(join(canonical, RECOVERY_CLAIM)).catch(() => null);
    if (
      !recoveryClaim(claim) ||
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
  readonly setInterval?: UseOnceWorkspaceTiming["setInterval"];
  readonly clearInterval?: UseOnceWorkspaceTiming["clearInterval"];
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
    setInterval:
      options?.setInterval ??
      ((callback, milliseconds) => {
        const handle = globalThis.setInterval(callback, milliseconds);
        handle.unref();
        return handle;
      }),
    clearInterval:
      options?.clearInterval ??
      ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>)),
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
          const marker = await readOwnedJson(join(canonical, MARKER));
          if (!ownedMarker(marker)) continue;
          const createdAt = Date.parse(marker.createdAt);
          if (
            now().getTime() - createdAt < STALE_WORKSPACE_TTL_MS ||
            Date.parse(marker.expiresAt) > now().getTime()
          )
            continue;
          const observedLease = await readOwnedJson(join(canonical, LEASE));
          if (
            !liveLease(observedLease) ||
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
            const confirmedLease = await readOwnedJson(join(canonical, LEASE));
            if (
              !liveLease(confirmedLease) ||
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
      let heartbeatHandle: unknown;
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
        heartbeatHandle = timing.setInterval(requestHeartbeat, timing.heartbeatIntervalMs);
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
            timing.clearInterval(heartbeatHandle);
            await heartbeatPromise;
            await safeCleanup(temporaryRoot, directory, instanceId, leaseId);
            cleaned = true;
          },
        };
        return staged;
      } catch (cause) {
        if (heartbeatHandle !== undefined) timing.clearInterval(heartbeatHandle);
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
