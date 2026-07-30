import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { win32 } from "node:path";

import { Database } from "bun:sqlite";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const LEGACY_LOCK_FILENAME = "windows-service-mutation.lock";
const SQLITE_LOCK_FILENAME = "windows-service-mutation.sqlite";
const FENCE_KIND = "sqlite-ownership-fence";
const FENCE_MODE = 0o600;
export const WINDOWS_USER_SERVICE_NAMESPACE = "selftune-user-service-v1";
const CanonicalUuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    expected: "a canonical UUID v4",
  }),
);

const ProcessId = Schema.Number.check(
  Schema.makeFilter((pid) => Number.isSafeInteger(pid) && pid > 0, {
    expected: "a positive process identifier",
  }),
);
const LockToken = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{32,128}$/, {
    expected: "a 32-128 character base64url lock token",
  }),
);
const CanonicalIsoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    { expected: "a canonical ISO 8601 UTC timestamp" },
  ),
);
const WindowsSid = Schema.String.check(
  Schema.makeFilter((sid) => /^S-\d(?:-\d+)+$/.test(sid) && sid === sid.toUpperCase(), {
    expected: "a canonical Windows security identifier",
  }),
);

export function canonicalWindowsServiceControlDir(controlDir: string): string {
  if (!win32.isAbsolute(controlDir)) {
    throw new Error("Windows user-service control directory must be absolute.");
  }
  const normalized = win32.normalize(controlDir);
  const withoutTrailingSeparators =
    normalized.length > 3 ? normalized.replace(/\\+$/, "") : normalized;
  return withoutTrailingSeparators.toLocaleLowerCase("en-US");
}

const CanonicalWindowsServiceControlDir = Schema.String.check(
  Schema.makeFilter(
    (path) => {
      try {
        return canonicalWindowsServiceControlDir(path) === path;
      } catch {
        return false;
      }
    },
    { expected: "a canonical absolute Windows user-service control directory" },
  ),
);

class WindowsUserServiceMutationLockScopeModel extends Schema.Class<WindowsUserServiceMutationLockScopeModel>(
  "WindowsUserServiceMutationLockScope",
)({
  controlDir: CanonicalWindowsServiceControlDir,
  namespace: Schema.Literal(WINDOWS_USER_SERVICE_NAMESPACE),
  userSid: WindowsSid,
}) {}

export const WindowsUserServiceMutationLockScopeSchema = WindowsUserServiceMutationLockScopeModel;
export type WindowsUserServiceMutationLockScope =
  typeof WindowsUserServiceMutationLockScopeSchema.Type;

class WindowsLegacyMutationLockPayloadModel extends Schema.Class<WindowsLegacyMutationLockPayloadModel>(
  "WindowsLegacyMutationLockPayload",
)({
  controlDir: CanonicalWindowsServiceControlDir,
  namespace: Schema.Literal(WINDOWS_USER_SERVICE_NAMESPACE),
  pid: ProcessId,
  startedAt: CanonicalIsoTimestamp,
  token: LockToken,
  userSid: WindowsSid,
  version: Schema.Literal(2),
}) {}

class WindowsMutationLockFenceModel extends Schema.Class<WindowsMutationLockFenceModel>(
  "WindowsMutationLockFence",
)({
  controlDir: CanonicalWindowsServiceControlDir,
  kind: Schema.Literal(FENCE_KIND),
  namespace: Schema.Literal(WINDOWS_USER_SERVICE_NAMESPACE),
  userSid: WindowsSid,
  version: Schema.Literal(3),
}) {}

export const WindowsMutationLockFenceSchema = WindowsMutationLockFenceModel;
export type WindowsMutationLockFence = typeof WindowsMutationLockFenceSchema.Type;
export type WindowsServiceLockRefusalCode =
  | "changed-during-inspection"
  | "disappeared"
  | "malformed"
  | "scope-mismatch"
  | "unsafe-file";
export type WindowsServiceLockCompatibilityDiagnostic =
  | { readonly _tag: "Absent"; readonly path: string }
  | { readonly _tag: "FenceReady"; readonly fence: WindowsMutationLockFence; readonly path: string }
  | {
      readonly _tag: "LegacyActiveOrUnverifiable";
      readonly fileIdentity: string;
      readonly generation: string;
      readonly path: string;
      readonly pid: number;
      readonly reason: string;
      readonly startedAt: string;
    }
  | {
      readonly _tag: "LegacyStale";
      readonly fileIdentity: string;
      readonly generation: string;
      readonly path: string;
      readonly pid: number;
      readonly startedAt: string;
    }
  | {
      readonly _tag: "Refused";
      readonly code: WindowsServiceLockRefusalCode;
      readonly path: string;
      readonly reason: string;
    };
export type WindowsServiceLockRepairCandidate = Extract<
  WindowsServiceLockCompatibilityDiagnostic,
  { readonly _tag: "LegacyStale" }
>;

export interface WindowsServiceLockCompatibilityFileSystem {
  readonly inspectFile: (
    path: string,
  ) => Effect.Effect<WindowsServiceLockFileEvidence | null, unknown>;
  readonly linkFileExclusive: (source: string, destination: string) => Effect.Effect<void, unknown>;
  readonly readUtf8File: (path: string) => Effect.Effect<string | null, unknown>;
  readonly removeFile: (path: string) => Effect.Effect<void, unknown>;
  readonly replaceFileAtomic: (source: string, destination: string) => Effect.Effect<void, unknown>;
  readonly writeUtf8FileSyncedExclusive: (
    path: string,
    contents: string,
    mode: number,
  ) => Effect.Effect<void, unknown>;
}

export interface WindowsServiceLockFileEvidence {
  readonly identity: string;
  readonly regular: boolean;
  readonly symbolicLink: boolean;
}

export interface WindowsServiceLockCompatibilityDependencies {
  readonly fileSystem: WindowsServiceLockCompatibilityFileSystem;
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean, unknown>;
  readonly randomUuid: () => string;
  readonly withRepairExclusion: <A, E, R>(
    scope: WindowsUserServiceMutationLockScope,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WindowsServiceLockCompatibilityError, R>;
}

export class WindowsServiceLockCompatibilityError extends Schema.TaggedErrorClass<WindowsServiceLockCompatibilityError>()(
  "WindowsServiceLockCompatibilityError",
  { message: Schema.String, operation: Schema.String },
) {}

export interface WindowsServiceLockCompatibility {
  readonly diagnose: (
    scope: WindowsUserServiceMutationLockScope,
  ) => Effect.Effect<
    WindowsServiceLockCompatibilityDiagnostic,
    WindowsServiceLockCompatibilityError
  >;
  readonly ensureFence: (
    scope: WindowsUserServiceMutationLockScope,
  ) => Effect.Effect<void, WindowsServiceLockCompatibilityError>;
  readonly repairStale: (
    scope: WindowsUserServiceMutationLockScope,
    candidate: WindowsServiceLockRepairCandidate,
  ) => Effect.Effect<void, WindowsServiceLockCompatibilityError>;
}

const LEGACY_KEYS: ReadonlyArray<string> = [
  "controlDir",
  "namespace",
  "pid",
  "startedAt",
  "token",
  "userSid",
  "version",
];
const FENCE_KEYS: ReadonlyArray<string> = ["controlDir", "kind", "namespace", "userSid", "version"];

function failure(operation: string, cause: unknown): WindowsServiceLockCompatibilityError {
  return WindowsServiceLockCompatibilityError.make({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}

function mapFailure<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WindowsServiceLockCompatibilityError, R> {
  return effect.pipe(Effect.mapError((cause) => failure(operation, cause)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(value: unknown, expected: ReadonlyArray<string>): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nodeErrorCode(cause: unknown): string | null {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : null;
}

function parsePayload(
  raw: string,
): WindowsLegacyMutationLockPayloadModel | WindowsMutationLockFence | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version === 2 && hasExactKeys(parsed, LEGACY_KEYS)) {
      return Schema.decodeUnknownSync(WindowsLegacyMutationLockPayloadModel)(parsed);
    }
    if (parsed.version === 3 && hasExactKeys(parsed, FENCE_KEYS)) {
      const fence = Schema.decodeUnknownSync(WindowsMutationLockFenceSchema)(parsed);
      return serializeWindowsMutationLockFence(fence) === raw ? fence : null;
    }
    return null;
  } catch {
    return null;
  }
}

function generation(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function absent(path: string): WindowsServiceLockCompatibilityDiagnostic {
  return { _tag: "Absent", path };
}

function refused(
  path: string,
  code: WindowsServiceLockRefusalCode,
  reason: string,
): WindowsServiceLockCompatibilityDiagnostic {
  return { _tag: "Refused", code, path, reason };
}

function fenceReady(
  path: string,
  fence: WindowsMutationLockFence,
): WindowsServiceLockCompatibilityDiagnostic {
  return { _tag: "FenceReady", fence, path };
}

function scopeMatches(
  payload: { readonly controlDir: string; readonly namespace: string; readonly userSid: string },
  scope: WindowsUserServiceMutationLockScope,
): boolean {
  return (
    payload.controlDir === scope.controlDir &&
    payload.namespace === scope.namespace &&
    payload.userSid === scope.userSid
  );
}

function refusalMessage(
  diagnostic: Exclude<WindowsServiceLockCompatibilityDiagnostic, { _tag: "Absent" | "FenceReady" }>,
): string {
  switch (diagnostic._tag) {
    case "LegacyActiveOrUnverifiable":
      return `A legacy Windows service mutation may still be active (PID ${diagnostic.pid}). Run selftune service doctor and retry after it finishes.`;
    case "LegacyStale":
      return `A stale legacy Windows service mutation lock from PID ${diagnostic.pid} blocks migration. Run selftune service doctor, then selftune service repair-lock.`;
    case "Refused":
      return `The legacy Windows service mutation lock is not safe to migrate: ${diagnostic.reason}. Run selftune service doctor.`;
  }
}

export function windowsLegacyServiceMutationLockPath(controlDir: string): string {
  return win32.join(canonicalWindowsServiceControlDir(controlDir), LEGACY_LOCK_FILENAME);
}

export function windowsServiceMutationSqlitePath(controlDir: string): string {
  return win32.join(canonicalWindowsServiceControlDir(controlDir), SQLITE_LOCK_FILENAME);
}

export function createWindowsMutationLockFence(
  scope: WindowsUserServiceMutationLockScope,
): WindowsMutationLockFence {
  return Schema.decodeUnknownSync(WindowsMutationLockFenceSchema)({
    ...scope,
    kind: FENCE_KIND,
    version: 3,
  });
}

export function serializeWindowsMutationLockFence(fence: WindowsMutationLockFence): string {
  return `${JSON.stringify({
    controlDir: fence.controlDir,
    kind: fence.kind,
    namespace: fence.namespace,
    userSid: fence.userSid,
    version: fence.version,
  })}\n`;
}

export function makeWindowsServiceLockCompatibility(
  dependencies: WindowsServiceLockCompatibilityDependencies,
): WindowsServiceLockCompatibility {
  const decodeScope = (
    scope: WindowsUserServiceMutationLockScope,
  ): Effect.Effect<WindowsUserServiceMutationLockScope, WindowsServiceLockCompatibilityError> =>
    Schema.decodeUnknownEffect(WindowsUserServiceMutationLockScopeSchema)(scope).pipe(
      Effect.mapError((cause) => failure("validate-windows-service-lock-scope", cause)),
    );
  const read = (path: string) =>
    mapFailure(
      "read-windows-service-lock-compatibility",
      dependencies.fileSystem.readUtf8File(path),
    );

  const diagnose = Effect.fn("SelfTuneService.windowsLockCompatibility.diagnose")(function* (
    requestedScope: WindowsUserServiceMutationLockScope,
  ) {
    const scope = yield* decodeScope(requestedScope);
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const firstEvidence = yield* mapFailure(
      "inspect-windows-service-lock-compatibility",
      dependencies.fileSystem.inspectFile(path),
    );
    if (firstEvidence === null) return absent(path);
    if (!firstEvidence.regular || firstEvidence.symbolicLink) {
      return refused(path, "unsafe-file", "the existing path is not a regular non-symbolic file");
    }
    const first = yield* read(path);
    if (first === null) {
      return refused(path, "disappeared", "the existing file disappeared during inspection");
    }
    const payload = parsePayload(first);
    if (payload === null) {
      return refused(path, "malformed", "the existing file is malformed");
    }
    if (!scopeMatches(payload, scope)) {
      return refused(
        path,
        "scope-mismatch",
        "the existing file has a mismatched user-service scope",
      );
    }
    const second = yield* read(path);
    const secondEvidence = yield* mapFailure(
      "reinspect-windows-service-lock-compatibility",
      dependencies.fileSystem.inspectFile(path),
    );
    if (
      secondEvidence === null ||
      !secondEvidence.regular ||
      secondEvidence.symbolicLink ||
      secondEvidence.identity !== firstEvidence.identity ||
      second !== first
    ) {
      return refused(
        path,
        "changed-during-inspection",
        "the existing file changed during inspection",
      );
    }
    if (payload.version === 3) return fenceReady(path, payload);
    const alive = yield* dependencies.isPidAlive(payload.pid).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
    );
    if (alive === false) {
      return {
        _tag: "LegacyStale",
        fileIdentity: firstEvidence.identity,
        generation: generation(first),
        path,
        pid: payload.pid,
        startedAt: payload.startedAt,
      } satisfies WindowsServiceLockCompatibilityDiagnostic;
    }
    return {
      _tag: "LegacyActiveOrUnverifiable",
      fileIdentity: firstEvidence.identity,
      generation: generation(first),
      path,
      pid: payload.pid,
      reason:
        alive === true ? "the recorded PID is present" : "the recorded PID could not be inspected",
      startedAt: payload.startedAt,
    } satisfies WindowsServiceLockCompatibilityDiagnostic;
  });

  const publishFence = Effect.fn("SelfTuneService.windowsLockCompatibility.publishFence")(
    function* (scope: WindowsUserServiceMutationLockScope) {
      const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
      const uuid = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(CanonicalUuid)(dependencies.randomUuid()),
        catch: (cause) => failure("generate-windows-service-lock-fence-temp", cause),
      });
      const tempPath = `${path}.fence-${uuid}.tmp`;
      const contents = serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope));
      return yield* Effect.acquireUseRelease(
        mapFailure(
          "write-windows-service-lock-fence-temp",
          dependencies.fileSystem.writeUtf8FileSyncedExclusive(tempPath, contents, FENCE_MODE),
        ).pipe(Effect.as(tempPath)),
        (source) =>
          dependencies.fileSystem.linkFileExclusive(source, path).pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                nodeErrorCode(cause) === "EEXIST"
                  ? diagnose(scope)
                  : Effect.fail(failure("publish-windows-service-lock-fence", cause)),
              onSuccess: () => diagnose(scope),
            }),
          ),
        (source) =>
          mapFailure(
            "remove-windows-service-lock-fence-temp",
            dependencies.fileSystem.removeFile(source),
          ),
      );
    },
  );

  const replaceStaleWithFence = Effect.fn(
    "SelfTuneService.windowsLockCompatibility.replaceStaleWithFence",
  )(function* (scope: WindowsUserServiceMutationLockScope) {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const uuid = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(CanonicalUuid)(dependencies.randomUuid()),
      catch: (cause) => failure("generate-windows-service-lock-repair-temp", cause),
    });
    const tempPath = `${path}.repair-${uuid}.tmp`;
    const contents = serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope));
    return yield* Effect.acquireUseRelease(
      mapFailure(
        "write-windows-service-lock-repair-temp",
        dependencies.fileSystem.writeUtf8FileSyncedExclusive(tempPath, contents, FENCE_MODE),
      ).pipe(Effect.as(tempPath)),
      (source) =>
        mapFailure(
          "replace-windows-service-lock-with-fence",
          dependencies.fileSystem.replaceFileAtomic(source, path),
        ),
      (source) =>
        mapFailure(
          "remove-windows-service-lock-repair-temp",
          dependencies.fileSystem.removeFile(source),
        ),
    );
  });

  const ensureFence = Effect.fn("SelfTuneService.windowsLockCompatibility.ensureFence")(function* (
    requestedScope: WindowsUserServiceMutationLockScope,
  ) {
    const scope = yield* decodeScope(requestedScope);
    const initial = yield* diagnose(scope);
    const diagnostic = initial._tag === "Absent" ? yield* publishFence(scope) : initial;
    if (diagnostic._tag === "FenceReady") return;
    if (diagnostic._tag === "Absent") {
      return yield* Effect.fail(
        failure("publish-windows-service-lock-fence", "the compatibility fence remained absent"),
      );
    }
    return yield* Effect.fail(
      failure("verify-windows-service-lock-compatibility", refusalMessage(diagnostic)),
    );
  });

  const repairStale = Effect.fn("SelfTuneService.windowsLockCompatibility.repairStale")(function* (
    requestedScope: WindowsUserServiceMutationLockScope,
    candidate: WindowsServiceLockRepairCandidate,
  ) {
    const scope = yield* decodeScope(requestedScope);
    const expectedPath = windowsLegacyServiceMutationLockPath(scope.controlDir);
    if (candidate._tag !== "LegacyStale" || candidate.path !== expectedPath) {
      return yield* Effect.fail(
        failure(
          "validate-windows-service-lock-repair-candidate",
          "Only an exact scoped stale legacy lock diagnosis may authorize repair.",
        ),
      );
    }
    yield* dependencies.withRepairExclusion(
      scope,
      Effect.gen(function* () {
        const current = yield* diagnose(scope);
        if (
          current._tag !== "LegacyStale" ||
          current.path !== candidate.path ||
          current.pid !== candidate.pid ||
          current.startedAt !== candidate.startedAt ||
          current.fileIdentity !== candidate.fileIdentity ||
          current.generation !== candidate.generation
        ) {
          return yield* Effect.fail(
            failure(
              "reprove-windows-service-lock-repair",
              "The stale legacy lock generation changed before repair.",
            ),
          );
        }
        yield* replaceStaleWithFence(scope);
        const repaired = yield* diagnose(scope);
        if (repaired._tag !== "FenceReady") {
          return yield* Effect.fail(
            failure(
              "verify-windows-service-lock-repair",
              "The exact compatibility fence was not present after repair.",
            ),
          );
        }
      }),
    );
  });

  return { diagnose, ensureFence, repairStale };
}

function promiseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}

function makeLiveFileSystem(): WindowsServiceLockCompatibilityFileSystem {
  return {
    inspectFile: (path) =>
      promiseEffect(() =>
        lstat(path, { bigint: true }).then(
          (stats) => ({
            identity: [stats.dev, stats.ino, stats.size, stats.mtimeNs].join(":"),
            regular: stats.isFile(),
            symbolicLink: stats.isSymbolicLink(),
          }),
          (cause: unknown) => (nodeErrorCode(cause) === "ENOENT" ? null : Promise.reject(cause)),
        ),
      ),
    linkFileExclusive: (source, destination) => promiseEffect(() => link(source, destination)),
    readUtf8File: (path) =>
      promiseEffect(() =>
        readFile(path, "utf8").then(
          (contents) => contents,
          (cause: unknown) => (nodeErrorCode(cause) === "ENOENT" ? null : Promise.reject(cause)),
        ),
      ),
    removeFile: (path) =>
      promiseEffect(() =>
        unlink(path).then(
          () => undefined,
          (cause: unknown) =>
            nodeErrorCode(cause) === "ENOENT" ? undefined : Promise.reject(cause),
        ),
      ),
    replaceFileAtomic: (source, destination) => promiseEffect(() => rename(source, destination)),
    writeUtf8FileSyncedExclusive: (path, contents, mode) =>
      Effect.acquireUseRelease(
        promiseEffect(() => open(path, "wx", mode)),
        (file) =>
          Effect.uninterruptible(
            promiseEffect(async () => {
              await file.writeFile(contents, "utf8");
              await file.sync();
            }),
          ),
        (file, useExit) =>
          promiseEffect(() => file.close()).pipe(
            Effect.catchCause((closeCause) =>
              Exit.isFailure(useExit)
                ? Effect.failCause(Cause.combine(useExit.cause, closeCause))
                : Effect.failCause(closeCause),
            ),
          ),
      ),
  };
}

export function makeLiveWindowsServiceLockCompatibility(): WindowsServiceLockCompatibility {
  return makeWindowsServiceLockCompatibility({
    fileSystem: makeLiveFileSystem(),
    isPidAlive: (pid) =>
      Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (cause) {
          return nodeErrorCode(cause) !== "ESRCH";
        }
      }),
    randomUuid: randomUUID,
    withRepairExclusion: (scope, use) => {
      const path = windowsServiceMutationSqlitePath(scope.controlDir);
      return Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const database = new Database(path, { create: true });
            let acquired = false;
            try {
              database.run("PRAGMA busy_timeout = 0");
              database.run("BEGIN IMMEDIATE");
              acquired = true;
              return database;
            } finally {
              if (!acquired) database.close();
            }
          },
          catch: (cause) => failure("acquire-windows-service-lock-repair-exclusion", cause),
        }),
        () => use,
        (database) =>
          Effect.try({
            try: () => {
              try {
                database.run("ROLLBACK");
              } finally {
                database.close();
              }
            },
            catch: (cause) => failure("release-windows-service-lock-repair-exclusion", cause),
          }),
      );
    },
  });
}
