import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

import { Duration, Effect, Exit, FileSystem, Option } from "effect";
import { PlatformError } from "effect/PlatformError";

import type { RegistryProgramFailure } from "./program-support.js";
import { operationError } from "./program-types.js";
import {
  decodeRegistryState,
  isRegistryStateValidationFailure,
  parseRegistryState,
  type RegistryStateEntry,
  registryStateValidationError,
} from "./registry-state.js";

const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

interface LockOwner {
  readonly acquiredAt: number;
  readonly hostname: string;
  readonly nonce: string;
  readonly pid: number;
}

export type RegistryStateDecision<A> =
  | {
      readonly _tag: "Commit";
      readonly state: ReadonlyArray<RegistryStateEntry>;
      readonly value: A;
    }
  | { readonly _tag: "NoChange"; readonly value: A };

export function commitRegistryState<A>(
  state: ReadonlyArray<RegistryStateEntry>,
  value: A,
): RegistryStateDecision<A> {
  return { _tag: "Commit", state, value };
}

export function keepRegistryState<A>(value: A): RegistryStateDecision<A> {
  return { _tag: "NoChange", value };
}

export function registryStateEntriesMatch(
  left: RegistryStateEntry | undefined,
  right: RegistryStateEntry | undefined,
): boolean {
  return (
    left?.entryId === right?.entryId &&
    left?.name === right?.name &&
    left?.versionHash === right?.versionHash &&
    left?.installPath === right?.installPath
  );
}

export function upsertRegistryStateEntry(
  state: ReadonlyArray<RegistryStateEntry>,
  entry: RegistryStateEntry,
): RegistryStateEntry[] {
  return [...state.filter((item) => item.entryId !== entry.entryId), entry];
}

export interface RegistryStateStore {
  readonly load: () => Effect.Effect<RegistryStateEntry[], RegistryProgramFailure>;
  readonly withTransaction: <A, E>(
    use: (latest: RegistryStateEntry[]) => Effect.Effect<RegistryStateDecision<A>, E>,
  ) => Effect.Effect<A, E | RegistryProgramFailure>;
}

export interface RegistryStateStoreOptions {
  readonly configDirectory: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly lockRetryMs?: number;
  readonly lockStaleMs?: number;
  readonly lockTimeoutMs?: number;
  readonly now?: () => number;
  readonly ownerHostname?: string;
  readonly ownerPid?: number;
  readonly randomNonce?: () => string;
}

function hasSystemTag(error: PlatformError, tag: PlatformError["reason"]["_tag"]): boolean {
  return error.reason._tag === tag;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function decodeLockOwner(source: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(source);
    if (
      typeof value !== "object" ||
      value === null ||
      !("acquiredAt" in value) ||
      !("hostname" in value) ||
      !("nonce" in value) ||
      !("pid" in value) ||
      typeof value.acquiredAt !== "number" ||
      typeof value.hostname !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.pid !== "number"
    ) {
      return null;
    }
    return {
      acquiredAt: value.acquiredAt,
      hostname: value.hostname,
      nonce: value.nonce,
      pid: value.pid,
    };
  } catch {
    return null;
  }
}

export function makeRegistryStateStore(
  options: RegistryStateStoreOptions,
): Effect.Effect<RegistryStateStore, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const statePath = join(options.configDirectory, "registry-state.json");
    const lockPath = `${statePath}.lock`;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    const ownerHostname = options.ownerHostname ?? hostname();
    const ownerPid = options.ownerPid ?? process.pid;
    const randomNonce = options.randomNonce ?? randomUUID;

    const load = Effect.fn("selftune.registry.state.load")(function* () {
      const source = yield* fs.readFileString(statePath).pipe(
        Effect.catchIf(
          (error) => hasSystemTag(error, "NotFound"),
          () => Effect.succeed(null),
        ),
        Effect.mapError((cause) => operationError("load-state", cause)),
      );
      if (source === null) return [];
      return yield* Effect.try({
        try: () => parseRegistryState(source),
        catch: (cause) =>
          isRegistryStateValidationFailure(cause) ? cause : registryStateValidationError(cause),
      });
    });

    const recoverStaleLock = Effect.fn("selftune.registry.state.recoverLock")(function* () {
      const snapshot = yield* Effect.all({
        source: fs.readFileString(lockPath),
        stat: fs.stat(lockPath),
      }).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => hasSystemTag(error, "NotFound"),
          () => Effect.succeed(Option.none()),
        ),
        Effect.mapError((cause) => operationError("state-lock", cause)),
      );
      if (Option.isNone(snapshot)) return;

      const owner = decodeLockOwner(snapshot.value.source);
      const modifiedAt = Option.getOrElse(snapshot.value.stat.mtime, () => new Date(0)).getTime();
      if (now() - modifiedAt < lockStaleMs) return;
      if (owner?.hostname === ownerHostname && isProcessAlive(owner.pid)) return;

      const tombstone = `${lockPath}.stale-${randomNonce()}`;
      const moved = yield* fs.rename(lockPath, tombstone).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => hasSystemTag(error, "NotFound"),
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => operationError("state-lock-recovery", cause)),
      );
      if (moved) {
        yield* fs
          .remove(tombstone, { force: true })
          .pipe(Effect.mapError((cause) => operationError("state-lock-recovery", cause)));
      }
    });

    const acquireLock = (deadline: number): Effect.Effect<LockOwner, RegistryProgramFailure> =>
      Effect.gen(function* () {
        const owner: LockOwner = {
          acquiredAt: now(),
          hostname: ownerHostname,
          nonce: randomNonce(),
          pid: ownerPid,
        };
        const acquired = yield* fs
          .writeFileString(lockPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => hasSystemTag(error, "AlreadyExists"),
              () => Effect.succeed(false),
            ),
            Effect.mapError((cause) => operationError("state-lock", cause)),
          );
        if (acquired) return owner;

        yield* recoverStaleLock();
        if (now() >= deadline) {
          return yield* operationError(
            "state-lock",
            new Error(`Timed out waiting for registry state lock '${lockPath}'`),
          );
        }
        yield* Effect.sleep(Duration.millis(lockRetryMs));
        return yield* acquireLock(deadline);
      });

    const releaseLock = (owner: LockOwner): Effect.Effect<void, RegistryProgramFailure> =>
      Effect.gen(function* () {
        const source = yield* fs.readFileString(lockPath).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => hasSystemTag(error, "NotFound"),
            () => Effect.succeed(Option.none()),
          ),
          Effect.mapError((cause) => operationError("state-unlock", cause)),
        );
        if (Option.isNone(source)) return;
        const currentOwner = decodeLockOwner(source.value);
        if (currentOwner?.nonce !== owner.nonce) {
          return yield* operationError(
            "state-unlock",
            new Error(`Registry state lock ownership changed for '${lockPath}'`),
          );
        }
        yield* fs
          .remove(lockPath, { force: true })
          .pipe(Effect.mapError((cause) => operationError("state-unlock", cause)));
      });

    const writeAtomically = Effect.fn("selftune.registry.state.writeAtomically")(function* (
      state: ReadonlyArray<RegistryStateEntry>,
    ) {
      const normalized = yield* Effect.try({
        try: () => decodeRegistryState(state),
        catch: (cause) =>
          isRegistryStateValidationFailure(cause) ? cause : registryStateValidationError(cause),
      });
      const temporaryPath = join(
        options.configDirectory,
        `.registry-state-${ownerPid}-${randomNonce()}.tmp`,
      );
      yield* Effect.acquireUseRelease(
        Effect.succeed(temporaryPath),
        (path) =>
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(path, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(JSON.stringify(normalized, null, 2)));
              yield* file.sync;
            }),
          ).pipe(
            Effect.andThen(fs.rename(path, statePath)),
            Effect.mapError((cause) => operationError("save-state", cause)),
          ),
        (path) => fs.remove(path, { force: true }).pipe(Effect.ignore),
      );
    });

    const withTransaction: RegistryStateStore["withTransaction"] = (use) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(options.configDirectory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((cause) => operationError("state-lock", cause)));
        return yield* Effect.acquireUseRelease(
          acquireLock(now() + lockTimeoutMs),
          () =>
            Effect.gen(function* () {
              const latest = yield* load();
              const decision = yield* use(latest);
              if (decision._tag === "Commit") yield* writeAtomically(decision.state);
              return decision.value;
            }),
          (owner, exit) =>
            Exit.isFailure(exit) ? releaseLock(owner).pipe(Effect.ignore) : releaseLock(owner),
        );
      });

    return { load, withTransaction };
  });
}
