import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ApplyOnboardingRequest,
  CreateRemoteLibraryShareRequest,
  CreateSkillSetRequest,
  DeriveSkillSetRequest,
  DraftInsightRequest,
  ExportSkillSetRequest,
  PlanSkillSetRequest,
  ReviewInsightRequest,
  RollbackSkillSetRequest,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
  UpdateSkillSetRequest,
} from "@selftune/runtime/dashboard-contract";

import {
  DashboardOperationError,
  DashboardOperations,
  type RemoteLibraryAction,
  type RemoteLibraryShareAction,
} from "../dashboard-operations.js";
import {
  dashboardCorsHeaders,
  dashboardOperationErrorResponse,
  sameOriginFailure,
} from "../dashboard-http.js";

export interface DashboardApplicationRouteContext {
  readonly allowedOrigins: ReadonlySet<string>;
}

const HarnessId = Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]);
const HookHarnessId = Schema.Literals(["codex", "claude_code", "opencode", "pi"]);
const SkillSetSkill = Schema.Struct({ name: Schema.String, package_path: Schema.String });
const CreateSkillSetBody = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  harnesses: Schema.Array(HarnessId),
  skills: Schema.Array(SkillSetSkill),
});
const UpdateSkillSetBody = Schema.Struct({
  set_id: Schema.String,
  parent_revision_hash: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  harnesses: Schema.Array(HarnessId),
  skills: Schema.Array(SkillSetSkill),
});
const DeriveSkillSetBody = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  project_root: Schema.String,
  harnesses: Schema.Array(HarnessId),
});
const SkillSetProjectBody = Schema.Struct({ set_id: Schema.String, project_root: Schema.String });
const SkillSetRollbackBody = Schema.Struct({ receipt_id: Schema.String });
const SourceUpdatePreviewBody = Schema.Struct({ skill_name: Schema.String });
const SourceUpdateApplyBody = Schema.Struct({
  skill_name: Schema.String,
  strategy: Schema.Literals(["abort", "take_upstream"]),
});
const ReviewInsightBody = Schema.Struct({
  candidate_id: Schema.String,
  action: Schema.Literals(["accept", "reject", "snooze", "edit"]),
  reason: Schema.String,
  snoozed_until: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
});
const DraftInsightBody = Schema.Struct({
  candidate_id: Schema.String,
  output_dir: Schema.optional(Schema.String),
});
const CandidateBody = Schema.Struct({ candidate_id: Schema.String });
const ScheduleBody = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(["selftune-sync", "selftune-status", "selftune-orchestrate"]),
      enabled: Schema.Boolean,
      schedule: Schema.String,
    }),
  ),
});
const SyncPreferences = Schema.Struct({
  releasedSkills: Schema.Boolean,
  drafts: Schema.Boolean,
  skillSets: Schema.Boolean,
  metadata: Schema.Boolean,
  decisionHistory: Schema.Boolean,
});
const RemoteLibrarySettingsBody = Schema.Struct({
  url: Schema.String,
  api_key: Schema.optional(Schema.String),
  preferences: SyncPreferences,
});
const RemoteLibraryPreviewBody = Schema.Struct({
  preferences: Schema.optional(SyncPreferences),
});
const OnboardingBody = Schema.Struct({
  import_sources: Schema.Array(HarnessId),
  hook_harnesses: Schema.Array(HookHarnessId),
  features: Schema.Struct({
    observability: Schema.Boolean,
    health_recommendations: Schema.Boolean,
    autonomous_improvement: Schema.Boolean,
  }),
});
const CreateShareBody = Schema.Struct({
  snapshot_id: Schema.String,
  artifact_id: Schema.String,
  recipient_email: Schema.String,
  expires_at: Schema.optional(Schema.NullOr(Schema.String)),
});
const PortfolioQuarantineBody = Schema.Struct({
  skill_name: Schema.String,
  skill_path: Schema.optional(Schema.String),
  confirm: Schema.optional(Schema.Boolean),
});
const PortfolioRestoreBody = Schema.Struct({ quarantine_id: Schema.String });

function requestError(operation: string, code: string, message: string): DashboardOperationError {
  return DashboardOperationError.make({
    operation,
    code,
    message,
    status: 400,
    retryable: false,
  });
}

const decodeBody = Effect.fn("DashboardApplication.decodeBody")(function* <S extends Schema.Top>(
  operation: string,
  request: Request,
  schema: S,
  code: string,
  message: string,
) {
  const input = yield* Effect.tryPromise({
    try: (): Promise<unknown> => request.json(),
    catch: () => requestError(operation, code, message),
  });
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => requestError(operation, code, message)),
  );
});

function requireNonBlank(
  operation: string,
  value: string,
  code: string,
  message: string,
): Effect.Effect<string, DashboardOperationError> {
  return value.trim() ? Effect.succeed(value) : Effect.fail(requestError(operation, code, message));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: dashboardCorsHeaders() });
}

function readOnlySkillSetsResponse(): Response {
  return Response.json(
    {
      error: {
        code: "READ_ONLY_HOST",
        message: "Skill Sets are read-only on this dashboard host.",
      },
    },
    { status: 405, headers: { ...dashboardCorsHeaders(), Allow: "GET" } },
  );
}

function mutationFailure(
  request: Request,
  context: DashboardApplicationRouteContext,
  message?: string,
): Response | null {
  return sameOriginFailure(request, context.allowedOrigins, message);
}

const routeApplicationRequest = Effect.fn("DashboardApplication.route")(function* (
  request: Request,
  url: URL,
  context: DashboardApplicationRouteContext,
) {
  const operations = yield* DashboardOperations;

  if (url.pathname === "/api/v2/portfolio" && request.method === "GET") {
    return json(yield* operations.portfolio);
  }

  if (url.pathname === "/api/v2/portfolio/quarantine" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "portfolio.quarantine",
      request,
      PortfolioQuarantineBody,
      "GUARD_BLOCKED",
      "Quarantine requires a skill_name.",
    );
    yield* requireNonBlank(
      "portfolio.quarantine",
      body.skill_name,
      "GUARD_BLOCKED",
      "Quarantine requires a skill_name.",
    );
    return json(
      yield* operations.quarantine({
        skillName: body.skill_name,
        skillPath: body.skill_path,
        confirm: body.confirm === true,
      }),
    );
  }

  if (url.pathname === "/api/v2/portfolio/restore" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "portfolio.restore",
      request,
      PortfolioRestoreBody,
      "MISSING_FLAG",
      "quarantine_id is required.",
    );
    return json(yield* operations.restore(body.quarantine_id));
  }

  if (url.pathname === "/api/v2/library" && request.method === "GET") {
    return json(yield* operations.library);
  }

  if (url.pathname.startsWith("/api/v2/library/source-update/") && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/v2/library/source-update/preview") {
      const body = yield* decodeBody(
        "library.source_update.preview",
        request,
        SourceUpdatePreviewBody,
        "MISSING_FLAG",
        "skill_name is required.",
      );
      yield* requireNonBlank(
        "library.source_update.preview",
        body.skill_name,
        "MISSING_FLAG",
        "skill_name is required.",
      );
      return json(yield* operations.previewSourceUpdate(body.skill_name));
    }
    if (url.pathname === "/api/v2/library/source-update/apply") {
      const body = yield* decodeBody(
        "library.source_update.apply",
        request,
        SourceUpdateApplyBody,
        "INVALID_FLAG",
        "skill_name and a strategy of abort or take_upstream are required.",
      );
      return json(yield* operations.applySourceUpdate(body.skill_name, body.strategy));
    }
    return new Response("Not found", { status: 404, headers: dashboardCorsHeaders() });
  }

  if (url.pathname === "/api/v2/insights" && request.method === "GET") {
    return json(yield* operations.insights);
  }

  if (url.pathname.startsWith("/api/v2/insights/") && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/v2/insights/review") {
      const body = yield* decodeBody(
        "insights.review",
        request,
        ReviewInsightBody,
        "MISSING_FLAG",
        "candidate_id, action, and reason are required.",
      );
      yield* requireNonBlank(
        "insights.review",
        body.reason,
        "MISSING_FLAG",
        "candidate_id, action, and reason are required.",
      );
      const input: ReviewInsightRequest = {
        candidate_id: body.candidate_id,
        action: body.action,
        reason: body.reason,
        snoozed_until: body.snoozed_until,
        title: body.title,
        summary: body.summary,
      };
      return json(yield* operations.reviewInsight(input));
    }
    if (url.pathname === "/api/v2/insights/draft") {
      const body = yield* decodeBody(
        "insights.draft",
        request,
        DraftInsightBody,
        "MISSING_FLAG",
        "candidate_id is required.",
      );
      const input: DraftInsightRequest = {
        candidate_id: body.candidate_id,
        output_dir: body.output_dir,
      };
      return json(yield* operations.draftInsight(input));
    }
    if (url.pathname === "/api/v2/insights/evaluate") {
      const body = yield* decodeBody(
        "insights.evaluate",
        request,
        CandidateBody,
        "MISSING_FLAG",
        "candidate_id is required.",
      );
      return json(yield* operations.evaluateInsight(body.candidate_id));
    }
    if (url.pathname === "/api/v2/insights/release") {
      const body = yield* decodeBody(
        "insights.release",
        request,
        CandidateBody,
        "MISSING_FLAG",
        "candidate_id is required.",
      );
      return json(yield* operations.releaseInsight(body.candidate_id));
    }
    return new Response("Not found", { status: 404, headers: dashboardCorsHeaders() });
  }

  if (url.pathname === "/api/v2/skill-sets" && request.method === "GET") {
    return json(yield* operations.skillSets);
  }

  if (url.pathname.startsWith("/api/v2/skill-sets") && request.method === "POST") {
    if (!operations.skillSetsWritable) return readOnlySkillSetsResponse();
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/v2/skill-sets") {
      const body = yield* decodeBody(
        "skill_sets.create",
        request,
        CreateSkillSetBody,
        "MISSING_FLAG",
        "name, harnesses, and skills are required.",
      );
      const input: CreateSkillSetRequest = {
        name: body.name,
        description: body.description,
        harnesses: [...body.harnesses],
        skills: body.skills.map((skill) => ({ ...skill })),
      };
      return json(yield* operations.createSkillSet(input));
    }
    if (url.pathname === "/api/v2/skill-sets/update") {
      const body = yield* decodeBody(
        "skill_sets.update",
        request,
        UpdateSkillSetBody,
        "MISSING_FLAG",
        "set_id, parent_revision_hash, name, harnesses, and skills are required.",
      );
      const input: UpdateSkillSetRequest = {
        set_id: body.set_id,
        parent_revision_hash: body.parent_revision_hash,
        name: body.name,
        description: body.description,
        harnesses: [...body.harnesses],
        skills: body.skills.map((skill) => ({ ...skill })),
      };
      return json(yield* operations.updateSkillSet(input));
    }
    if (url.pathname === "/api/v2/skill-sets/derive") {
      const body = yield* decodeBody(
        "skill_sets.derive",
        request,
        DeriveSkillSetBody,
        "MISSING_FLAG",
        "name, project_root, and harnesses are required.",
      );
      const input: DeriveSkillSetRequest = {
        name: body.name,
        description: body.description,
        project_root: body.project_root,
        harnesses: [...body.harnesses],
      };
      return json(yield* operations.deriveSkillSet(input));
    }
    if (url.pathname === "/api/v2/skill-sets/export") {
      const body = yield* decodeBody(
        "skill_sets.export",
        request,
        SkillSetProjectBody,
        "MISSING_FLAG",
        "set_id and project_root are required.",
      );
      const input: ExportSkillSetRequest = { ...body };
      return json(yield* operations.exportSkillSet(input));
    }
    if (url.pathname === "/api/v2/skill-sets/plan") {
      const body = yield* decodeBody(
        "skill_sets.plan",
        request,
        SkillSetProjectBody,
        "MISSING_FLAG",
        "set_id and project_root are required.",
      );
      const input: PlanSkillSetRequest = { ...body };
      return json(yield* operations.planSkillSet(input));
    }
    if (url.pathname === "/api/v2/skill-sets/apply") {
      const body = yield* decodeBody(
        "skill_sets.apply",
        request,
        SkillSetProjectBody,
        "MISSING_FLAG",
        "set_id and project_root are required.",
      );
      const input: PlanSkillSetRequest = { ...body };
      return json(yield* operations.applySkillSet(input));
    }
    if (url.pathname === "/api/v2/skill-sets/rollback") {
      const body = yield* decodeBody(
        "skill_sets.rollback",
        request,
        SkillSetRollbackBody,
        "MISSING_FLAG",
        "receipt_id is required.",
      );
      const input: RollbackSkillSetRequest = { ...body };
      return json(yield* operations.rollbackSkillSet(input));
    }
    return json({ error: { code: "NOT_FOUND", message: "Unknown Skill Set operation." } }, 404);
  }

  if (url.pathname === "/api/v2/settings" && request.method === "GET") {
    return json(yield* operations.settings);
  }

  if (url.pathname === "/api/v2/settings/remote-library/preview" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context, "A same-origin request is required.");
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "remote_library.preview",
      request,
      RemoteLibraryPreviewBody,
      "OPERATION_FAILED",
      "Remote Library preview failed.",
    );
    return json(yield* operations.previewRemoteLibrary(body.preferences));
  }

  if (url.pathname === "/api/v2/settings/remote-library/status" && request.method === "GET") {
    return json(yield* operations.remoteLibrary("status"));
  }

  if (url.pathname === "/api/v2/settings/remote-library/shares" && request.method === "GET") {
    return json(yield* operations.remoteLibraryShare("list"));
  }

  if (
    url.pathname.startsWith("/api/v2/settings/remote-library/shares") &&
    request.method === "POST"
  ) {
    const unauthorized = mutationFailure(request, context, "A same-origin request is required.");
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/v2/settings/remote-library/shares") {
      const body = yield* decodeBody(
        "remote_library.share.create",
        request,
        CreateShareBody,
        "MISSING_FLAG",
        "Private share details are required.",
      );
      const input: CreateRemoteLibraryShareRequest = { ...body };
      return json(yield* operations.remoteLibraryShare("create", input));
    }
    const match = url.pathname.match(
      /^\/api\/v2\/settings\/remote-library\/shares\/([^/]+)\/(accept|import|revoke)$/,
    );
    if (match) {
      const action = match[2];
      if (action === "accept" || action === "import" || action === "revoke") {
        const shareAction: RemoteLibraryShareAction = action;
        const shareId = yield* Effect.try({
          try: () => decodeURIComponent(match[1] ?? ""),
          catch: () =>
            requestError(
              "remote_library.share.action",
              "INVALID_FLAG",
              "Private share ID is malformed.",
            ),
        });
        return json(
          yield* operations.remoteLibraryShare(shareAction, {
            share_id: shareId,
          }),
        );
      }
    }
    return json({ error: { code: "NOT_FOUND", message: "Unknown private share action." } }, 404);
  }

  if (url.pathname.startsWith("/api/v2/settings/remote-library/") && request.method === "POST") {
    const action = url.pathname.split("/").at(-1);
    if (action === "sync" || action === "export" || action === "restore") {
      const unauthorized = mutationFailure(request, context, "A same-origin request is required.");
      if (unauthorized) return unauthorized;
      const remoteAction: RemoteLibraryAction = action;
      return json(yield* operations.remoteLibrary(remoteAction));
    }
  }

  if (url.pathname === "/api/v2/settings/schedule" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "settings.schedule",
      request,
      ScheduleBody,
      "OPERATION_FAILED",
      "Schedule update failed.",
    );
    const input: UpdateDesktopScheduleRequest = {
      jobs: body.jobs.map((job) => ({ ...job })),
    };
    return json(yield* operations.updateSchedule(input));
  }

  if (url.pathname === "/api/v2/settings/remote-library" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "settings.remote_library",
      request,
      RemoteLibrarySettingsBody,
      "OPERATION_FAILED",
      "Remote Library update failed.",
    );
    const input: UpdateRemoteLibraryRequest = {
      url: body.url,
      api_key: body.api_key,
      preferences: { ...body.preferences },
    };
    return json(yield* operations.updateRemoteSettings(input));
  }

  if (url.pathname === "/api/v2/settings/onboarding" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "settings.onboarding",
      request,
      OnboardingBody,
      "OPERATION_FAILED",
      "Onboarding failed.",
    );
    const input: ApplyOnboardingRequest = {
      import_sources: [...body.import_sources],
      hook_harnesses: [...body.hook_harnesses],
      features: { ...body.features },
    };
    return json(yield* operations.applyOnboarding(input));
  }

  return null;
});

export function handleDashboardApplicationRoute(
  request: Request,
  url: URL,
  context: DashboardApplicationRouteContext,
) {
  return routeApplicationRequest(request, url, context).pipe(
    Effect.catch((error) => Effect.succeed(dashboardOperationErrorResponse(error))),
  );
}
