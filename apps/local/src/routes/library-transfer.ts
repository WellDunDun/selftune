import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DashboardOperationError, type DashboardOperations } from "../dashboard-operations.js";
import { dashboardCorsHeaders, sameOriginFailure } from "../dashboard-http.js";

const BackupBody = Schema.Struct({ skill_id: Schema.String });
const InstallBody = Schema.Struct({
  skill_id: Schema.String,
  target_agent: Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]),
});
const ShareBody = Schema.Union([
  Schema.Struct({
    skill_id: Schema.String,
    mode: Schema.Literals(["reusable_unlisted", "private_single_claim"]),
    delivery: Schema.Literal("copy_link"),
  }),
  Schema.Struct({
    skill_id: Schema.String,
    mode: Schema.Literal("private_single_claim"),
    delivery: Schema.Literal("email"),
    recipient_email: Schema.String,
  }),
]);
const ShareSkillSetBody = Schema.Union([
  Schema.Struct({
    set_id: Schema.String,
    mode: Schema.Literals(["reusable_unlisted", "private_single_claim"]),
    delivery: Schema.Literal("copy_link"),
  }),
  Schema.Struct({
    set_id: Schema.String,
    mode: Schema.Literal("private_single_claim"),
    delivery: Schema.Literal("email"),
    recipient_email: Schema.String,
  }),
]);
const LicenseDraftTermsBody = Schema.Struct({
  copyright_holder: Schema.String,
  licensed_organization: Schema.String,
  year: Schema.Number,
});
const PreviewLicenseBody = Schema.Struct({
  skill_id: Schema.String,
  terms: LicenseDraftTermsBody,
});
const ApplyLicenseBody = Schema.Struct({
  skill_id: Schema.String,
  preview_id: Schema.String,
  terms: LicenseDraftTermsBody,
});

function licenseTerms(body: typeof LicenseDraftTermsBody.Type) {
  return {
    copyrightHolder: body.copyright_holder,
    licensedOrganization: body.licensed_organization,
    year: body.year,
  };
}

export function backedArtifact(value: unknown, skillId: string) {
  const root =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const snapshot =
    typeof root?.snapshot === "object" && root.snapshot !== null
      ? (root.snapshot as Record<string, unknown>)
      : null;
  const snapshotId = typeof snapshot?.snapshotId === "string" ? snapshot.snapshotId : null;
  const artifacts = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
  const artifact = artifacts.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const id = Reflect.get(candidate, "artifactId");
    const type = Reflect.get(candidate, "artifactType");
    return (
      type === "skill_revision" && typeof id === "string" && id.startsWith(`skill/${skillId}/`)
    );
  });
  const artifactId =
    artifact && typeof artifact === "object" ? Reflect.get(artifact, "artifactId") : null;
  return snapshotId && typeof artifactId === "string" ? { snapshotId, artifactId } : null;
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
        "/api/v2/library/license/preview",
        "/api/v2/library/license/apply",
        "/api/v2/skill-sets/share",
      ].includes(url.pathname)
    ) {
      return null;
    }
    const unauthorized = sameOriginFailure(request, allowedOrigins);
    if (unauthorized) return { response: unauthorized, installed: false };
    if (url.pathname === "/api/v2/library/license/preview") {
      const body = yield* decode(
        request,
        "library.license.preview",
        PreviewLicenseBody,
        "skill_id and license terms are required.",
      );
      return {
        response: Response.json(
          yield* operations.previewLicenseDraft(body.skill_id, licenseTerms(body.terms)),
          { headers: dashboardCorsHeaders() },
        ),
        installed: false,
      };
    }
    if (url.pathname === "/api/v2/library/license/apply") {
      const body = yield* decode(
        request,
        "library.license.apply",
        ApplyLicenseBody,
        "skill_id, preview_id, and license terms are required.",
      );
      return {
        response: Response.json(
          yield* operations.applyLicenseDraft(
            body.skill_id,
            body.preview_id,
            licenseTerms(body.terms),
          ),
          { headers: dashboardCorsHeaders() },
        ),
        installed: false,
      };
    }
    if (url.pathname === "/api/v2/skill-sets/share") {
      const body = yield* decode(
        request,
        "skill_sets.share",
        ShareSkillSetBody,
        "set_id and share details are required.",
      );
      const input =
        body.delivery === "email"
          ? {
              skillSetId: body.set_id,
              mode: "private_single_claim" as const,
              delivery: "email" as const,
              recipientEmail: body.recipient_email,
            }
          : {
              skillSetId: body.set_id,
              mode: body.mode,
              delivery: "copy_link" as const,
            };
      return {
        response: Response.json(yield* operations.remoteLibraryShare("create", input), {
          headers: dashboardCorsHeaders(),
        }),
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
      const input =
        body.delivery === "email"
          ? {
              skillId: body.skill_id,
              ...artifact,
              mode: "private_single_claim" as const,
              delivery: "email" as const,
              recipientEmail: body.recipient_email,
            }
          : {
              skillId: body.skill_id,
              ...artifact,
              mode: body.mode,
              delivery: "copy_link" as const,
            };
      return {
        response: Response.json(yield* operations.remoteLibraryShare("create", input), {
          headers: dashboardCorsHeaders(),
        }),
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
