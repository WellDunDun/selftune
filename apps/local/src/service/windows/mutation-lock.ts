import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  canonicalWindowsServiceControlDir,
  makeLiveWindowsServiceLockCompatibility,
  WINDOWS_USER_SERVICE_NAMESPACE,
  WindowsUserServiceMutationLockScopeSchema,
  windowsServiceMutationSqlitePath,
  type WindowsServiceLockCompatibility,
  type WindowsUserServiceMutationLockScope,
} from "./lock-compatibility.js";

export {
  canonicalWindowsServiceControlDir,
  WINDOWS_USER_SERVICE_NAMESPACE,
  WindowsUserServiceMutationLockScopeSchema,
  type WindowsUserServiceMutationLockScope,
};

export interface WindowsUserServiceMutationLockLease extends WindowsUserServiceMutationLockScope {
  readonly path: string;
  readonly token: string;
}

export interface WindowsUserServiceMutationLockDatabase {
  readonly close: () => void;
  readonly run: (sql: string) => unknown;
}

export interface WindowsUserServiceMutationLockDependencies {
  readonly compatibility: WindowsServiceLockCompatibility;
  readonly openDatabase: (path: string) => WindowsUserServiceMutationLockDatabase;
}

export class WindowsServiceMutationLockError extends Schema.TaggedErrorClass<WindowsServiceMutationLockError>()(
  "WindowsServiceMutationLockError",
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export interface WindowsUserServiceMutationLock {
  readonly acquire: (
    scope: WindowsUserServiceMutationLockScope,
  ) => Effect.Effect<WindowsUserServiceMutationLockLease, WindowsServiceMutationLockError>;
  readonly release: (
    lease: WindowsUserServiceMutationLockLease,
  ) => Effect.Effect<void, WindowsServiceMutationLockError>;
  readonly withLock: <A, E, R>(
    scope: WindowsUserServiceMutationLockScope,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WindowsServiceMutationLockError, R>;
}

interface LeaseState {
  readonly database: WindowsUserServiceMutationLockDatabase;
  released: boolean;
}

function failure(operation: string, cause: unknown): WindowsServiceMutationLockError {
  return WindowsServiceMutationLockError.make({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWindowsServiceMutationLockBusy(cause: unknown): boolean {
  const visited = new WeakSet<object>();
  let current = cause;
  while (isRecord(current) && !visited.has(current)) {
    visited.add(current);
    const code = current.code;
    const errno = current.errno;
    if (
      code === "SQLITE_BUSY" ||
      code === "SQLITE_LOCKED" ||
      (typeof code === "string" &&
        (code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED_"))) ||
      errno === 5 ||
      errno === 6
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function windowsUserServiceMutationLockPath(controlDir: string): string {
  return windowsServiceMutationSqlitePath(controlDir);
}

export function makeWindowsUserServiceMutationLock(
  dependencies: WindowsUserServiceMutationLockDependencies,
): WindowsUserServiceMutationLock {
  const leases = new WeakMap<WindowsUserServiceMutationLockLease, LeaseState>();
  const decodeScope = (
    scope: WindowsUserServiceMutationLockScope,
  ): Effect.Effect<WindowsUserServiceMutationLockScope, WindowsServiceMutationLockError> =>
    Schema.decodeUnknownEffect(WindowsUserServiceMutationLockScopeSchema)(scope).pipe(
      Effect.mapError((cause) => failure("validate-user-service-lock-scope", cause)),
    );

  const acquire = Effect.fn("SelfTuneService.windowsUserServiceMutationLock.acquire")(function* (
    requestedScope: WindowsUserServiceMutationLockScope,
  ) {
    const scope = yield* decodeScope(requestedScope);
    yield* dependencies.compatibility
      .ensureFence(scope)
      .pipe(Effect.mapError((cause) => failure(cause.operation, cause.message)));
    const path = windowsUserServiceMutationLockPath(scope.controlDir);
    return yield* Effect.try({
      try: () => {
        const token = randomUUID();
        const database = dependencies.openDatabase(path);
        let acquired = false;
        try {
          database.run("PRAGMA busy_timeout = 0");
          database.run("BEGIN IMMEDIATE");
          const lease: WindowsUserServiceMutationLockLease = {
            ...scope,
            path,
            token,
          };
          leases.set(lease, { database, released: false });
          acquired = true;
          return lease;
        } finally {
          if (!acquired) database.close();
        }
      },
      catch: (cause) =>
        isWindowsServiceMutationLockBusy(cause)
          ? failure(
              "acquire-user-service-mutation-lock",
              "Another Windows service mutation is already in progress.",
            )
          : failure("initialize-user-service-mutation-lock", cause),
    });
  });

  const release = Effect.fn("SelfTuneService.windowsUserServiceMutationLock.release")(function* (
    lease: WindowsUserServiceMutationLockLease,
  ) {
    const state = leases.get(lease);
    if (state === undefined || state.released) return;
    state.released = true;
    leases.delete(lease);
    return yield* Effect.try({
      try: () => {
        try {
          state.database.run("ROLLBACK");
        } finally {
          state.database.close();
        }
      },
      catch: (cause) => failure("release-user-service-mutation-lock", cause),
    });
  });

  const withLock = <A, E, R>(
    scope: WindowsUserServiceMutationLockScope,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WindowsServiceMutationLockError, R> =>
    Effect.acquireUseRelease(acquire(scope), () => use, release);

  return { acquire, release, withLock };
}

export function makeLiveWindowsUserServiceMutationLock(
  compatibility: WindowsServiceLockCompatibility = makeLiveWindowsServiceLockCompatibility(),
): WindowsUserServiceMutationLock {
  return makeWindowsUserServiceMutationLock({
    compatibility,
    openDatabase: (path) => new Database(path, { create: true }),
  });
}
