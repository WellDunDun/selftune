import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import {
  canonicalWindowsServiceControlDir,
  WindowsLockCompatibility,
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
  readonly run: (sql: string) => void;
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

const decodeLockFailure = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.Unknown),
    errno: Schema.optionalKey(Schema.Unknown),
    cause: Schema.optionalKey(Schema.Unknown),
  }),
);
const isBusyCode = Schema.is(
  Schema.Union([
    Schema.Literals(["SQLITE_BUSY", "SQLITE_LOCKED"]),
    Schema.String.check(Schema.isPattern(/^SQLITE_(?:BUSY|LOCKED)_/)),
  ]),
);

export function isWindowsServiceMutationLockBusy(cause: unknown): boolean {
  const visited = new WeakSet<object>();
  let current = cause;
  while (Predicate.isObject(current) && !visited.has(current)) {
    visited.add(current);
    const decoded = decodeLockFailure(current);
    if (Option.isNone(decoded)) return false;
    const { code, errno } = decoded.value;
    if (isBusyCode(code) || errno === 5 || errno === 6) {
      return true;
    }
    current = decoded.value.cause;
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
          database.run("BEGIN EXCLUSIVE");
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

export class WindowsMutationLock extends Context.Service<
  WindowsMutationLock,
  WindowsUserServiceMutationLock
>()("SelfTune/WindowsMutationLock") {}

export const WindowsMutationLockLive = Layer.effect(WindowsMutationLock)(
  Effect.gen(function* () {
    return makeLiveWindowsUserServiceMutationLock(yield* WindowsLockCompatibility);
  }),
);

export function makeLiveWindowsUserServiceMutationLock(
  compatibility: WindowsServiceLockCompatibility,
): WindowsUserServiceMutationLock {
  return makeWindowsUserServiceMutationLock({
    compatibility,
    openDatabase: (path) => new Database(path, { create: true }),
  });
}
