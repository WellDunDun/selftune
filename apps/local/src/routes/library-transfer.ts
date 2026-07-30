import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DashboardOperationError, type DashboardOperations } from "../dashboard-operations.js";
import { dashboardCorsHeaders, sameOriginFailure } from "../dashboard-http.js";

const BackupBody = Schema.Struct({ skill_id: Schema.String });
const InstallBody = Schema.Struct({
  skill_id: Schema.String,
  target_agent: Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]),
});
const ShareBody = Schema.Struct({
  skill_id: Schema.String,
  mode: Schema.Literal("reusable_unlisted"),
  delivery: Schema.Literal("copy_link"),
});
const ShareSkillSetBody = Schema.Struct({
  set_id: Schema.String,
  mode: Schema.Literal("reusable_unlisted"),
  delivery: Schema.Literal("copy_link"),
});

function property(target: unknown, key: string): unknown {
  return typeof target === "object" && target !== null ? Reflect.get(target, key) : undefined;
}

function matchingSkillRevisionCount(value: unknown, artifactId: string): number {
  if (!Array.isArray(value)) return 0;
  return value.filter(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      Reflect.get(candidate, "artifactId") === artifactId &&
      Reflect.get(candidate, "artifactType") === "skill_revision",
  ).length;
}

export function backedArtifact(value: unknown, skillId: string) {
  const subject = property(value, "subject");
  const snapshot = property(value, "snapshot");
  const rawSnapshotId = property(snapshot, "snapshotId");
  const rawSubjectSkillId = property(subject, "skillId");
  const rawSubjectSnapshotId = property(subject, "snapshotId");
  const rawSubjectArtifactId = property(subject, "artifactId");
  const snapshotId = typeof rawSnapshotId === "string" ? rawSnapshotId : null;
  const subjectSkillId = typeof rawSubjectSkillId === "string" ? rawSubjectSkillId : null;
  const subjectSnapshotId = typeof rawSubjectSnapshotId === "string" ? rawSubjectSnapshotId : null;
  const subjectArtifactId = typeof rawSubjectArtifactId === "string" ? rawSubjectArtifactId : null;
  const artifactParts = subjectArtifactId?.split("/") ?? [];
  if (
    subjectSkillId !== skillId ||
    subjectSnapshotId !== snapshotId ||
    artifactParts.length !== 3 ||
    artifactParts[0] !== "backup-skill" ||
    artifactParts[1]?.length === 0 ||
    artifactParts[2]?.length === 0
  ) {
    return null;
  }
  const rawArtifacts = property(snapshot, "artifacts");
  const rawSyncedArtifacts = property(value, "syncedArtifacts");
  return snapshotId &&
    subjectArtifactId &&
    matchingSkillRevisionCount(rawArtifacts, subjectArtifactId) === 1 &&
    matchingSkillRevisionCount(rawSyncedArtifacts, subjectArtifactId) === 1
    ? { snapshotId, artifactId: subjectArtifactId }
    : null;
}

function invalidBody(operation: string, message: string): DashboardOperationError {
  return DashboardOperationError.make({
    operation,
    code: "MISSING_FLAG",
    message,
    status: 400,
    retryable: false,
  });
}

const decode = Effect.fn("DashboardApplication.decodeLibraryTransfer")(function* <
  S extends Schema.Top,
>(request: Request, operation: string, schema: S, message: string) {
  const input = yield* Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => invalidBody(operation, message),
  });
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => invalidBody(operation, message)),
  );
});

export const routeLibraryTransfer = Effect.fn("DashboardApplication.routeLibraryTransfer")(
  function* (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
    operations: DashboardOperations["Service"],
  ) {
    if (url.pathname === "/api/v2/library" && request.method === "GET") {
      return {
        response: Response.json(yield* operations.library, {
          headers: dashboardCorsHeaders(),
        }),
        installed: false,
      };
    }
    if (request.method !== "POST") return null;
    if (
      ![
        "/api/v2/library/backup",
        "/api/v2/library/install",
        "/api/v2/library/share",
        "/api/v2/skill-sets/share",
      ].includes(url.pathname)
    ) {
      return null;
    }
    const unauthorized = sameOriginFailure(request, allowedOrigins);
    if (unauthorized) return { response: unauthorized, installed: false };
    if (url.pathname === "/api/v2/skill-sets/share") {
      const body = yield* decode(
        request,
        "skill_sets.share",
        ShareSkillSetBody,
        "set_id and share details are required.",
      );
      return {
        response: Response.json(
          yield* operations.remoteLibraryShare("create", {
            skillSetId: body.set_id,
            mode: body.mode,
            delivery: body.delivery,
          }),
          { headers: dashboardCorsHeaders() },
        ),
        installed: false,
      };
    }
    if (url.pathname === "/api/v2/library/backup") {
      const body = yield* decode(
        request,
        "library.skill.backup",
        BackupBody,
        "skill_id is required.",
      );
      return {
        response: Response.json(yield* operations.backupLibrarySkill(body.skill_id), {
          headers: dashboardCorsHeaders(),
        }),
        installed: false,
      };
    }
    if (url.pathname === "/api/v2/library/share") {
      const body = yield* decode(
        request,
        "library.skill.share",
        ShareBody,
        "Share details are required.",
      );
      const backup = yield* operations.backupLibrarySkill(body.skill_id);
      const artifact = backedArtifact(backup, body.skill_id);
      if (!artifact) {
        return yield* invalidBody(
          "library.skill.share",
          "The backed-up skill artifact could not be resolved.",
        );
      }
      return {
        response: Response.json(
          yield* operations.remoteLibraryShare("create", {
            skillId: body.skill_id,
            ...artifact,
            mode: body.mode,
            delivery: body.delivery,
          }),
          { headers: dashboardCorsHeaders() },
        ),
        installed: false,
      };
    }
    const body = yield* decode(
      request,
      "library.skill.install",
      InstallBody,
      "skill_id and target_agent are required.",
    );
    return {
      response: Response.json(
        yield* operations.installLibrarySkill(body.skill_id, body.target_agent),
        { headers: dashboardCorsHeaders() },
      ),
      installed: true,
    };
  },
);
