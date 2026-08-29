// oxlint-disable max-lines -- The local HTTP application keeps route ordering and shared guards in one auditable boundary.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  adaptLocalSourceMerge,
  buildRunPackage,
  summarizeRunReview,
} from "@selftune/dashboard-core/review/portable";

import type {
  ApplyOnboardingRequest,
  ApplySkillSetRequest,
  CompleteCloudAccountLinkRequest,
  CreateRemoteLibraryShareRequest,
  CreateSkillSetRequest,
  DeriveSkillSetRequest,
  DraftInsightRequest,
  ExportSkillSetRequest,
  PlanSkillSetRequest,
  ReviewInsightRequest,
  ReviewSkillSetSuggestionRequest,
  RollbackSkillSetRequest,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
  UpdateSkillClassificationRequest,
  UpdateSkillSetRequest,
} from "@selftune/runtime/dashboard-contract";
import {
  type DashboardResource,
  insightDecisionResources,
  durableDecisionResources,
  libraryLocationWriteResources,
  projectSkillSetResources,
  sourceMergeDecisionResources,
  sourceUpdateResources,
} from "@selftune/runtime/dashboard-reactivity";

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
import { routeWorkspaceSettings } from "./workspace-settings.js";
import { routeLibraryTransfer } from "./library-transfer.js";
import { ReviewSkillSetSuggestionBody } from "./skill-set-schemas.js";

export interface DashboardApplicationRouteContext {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly onResourcesChanged?: (resources: readonly DashboardResource[]) => void;
  readonly onSkillSetChanged?: () => void;
}

const HarnessId = Schema.Literals(["codex", "claude_code", "cline", "opencode", "openclaw", "pi"]);
const SkillSetHarnessId = Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]);
const HookHarnessId = Schema.Literals(["codex", "claude_code", "cline", "opencode", "pi"]);
const SkillCategoryId = Schema.Literals([
  "software_development",
  "testing_quality",
  "data_ai",
  "research",
  "writing_content",
  "design",
  "product_business",
  "operations_automation",
  "communication",
  "security",
  "agent_tooling",
  "general",
]);
const UpdateSkillClassificationBody = Schema.Struct({
  skill_id: Schema.String,
  skill_name: Schema.String,
  category: Schema.NullOr(SkillCategoryId),
  inferred_category: SkillCategoryId,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const SkillSetSkill = Schema.Struct({ name: Schema.String, package_path: Schema.String });
const CatalogSkillSetSkill = Schema.Struct({
  name: Schema.String,
  catalog_id: Schema.String,
  source: Schema.String,
  install_spec: Schema.String,
  download_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const CreateSkillSetBody = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  harnesses: Schema.Array(SkillSetHarnessId),
  skills: Schema.Array(Schema.Union([SkillSetSkill, CatalogSkillSetSkill])),
});
const UpdateSkillSetBody = Schema.Struct({
  set_id: Schema.String,
  parent_revision_hash: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  harnesses: Schema.Array(SkillSetHarnessId),
  skills: Schema.Array(SkillSetSkill),
});
const DeriveSkillSetBody = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  project_root: Schema.String,
  harnesses: Schema.optional(Schema.Array(SkillSetHarnessId)),
});
const SkillSetProjectBody = Schema.Struct({ set_id: Schema.String, project_root: Schema.String });
const ApplySkillSetBody = Schema.Struct({
  set_id: Schema.String,
  project_root: Schema.String,
  policy_approval: Schema.optional(Schema.Boolean),
});
const PluginExportBody = Schema.Struct({
  set_id: Schema.String,
  target: Schema.Literals(["claude", "openai", "agent-plugins-v1", "dual", "all"]),
});
const PluginInstallPreviewBody = Schema.Struct({ set_id: Schema.String });
const PluginInstallBody = Schema.Struct({
  set_id: Schema.String,
  expected_revision_hash: Schema.String,
  hosts: Schema.Array(Schema.Literals(["claude", "codex"])),
});
const PluginManagementBody = Schema.Struct({
  host: Schema.Literals(["claude", "codex"]),
  plugin_id: Schema.String,
  action: Schema.Literals(["update", "enable", "disable", "remove"]),
});
const SkillSetPackPreviewBody = Schema.Struct({ pack_url: Schema.String });
const SkillSetPackImportBody = Schema.Struct({
  pack_url: Schema.String,
  expected_object_sha256: Schema.String,
});
const ProjectProvisionBody = Schema.Struct({
  project_root: Schema.String,
  set_ids: Schema.Array(Schema.String),
  harnesses: Schema.optional(Schema.Array(SkillSetHarnessId)),
  create_react_project: Schema.optional(Schema.Boolean),
});
const SkillSetRollbackBody = Schema.Struct({ receipt_id: Schema.String });
const SourceUpdatePreviewBody = Schema.Struct({ skill_name: Schema.String });
const SourceUpdateApplyBody = Schema.Struct({
  skill_name: Schema.String,
  strategy: Schema.Literals(["abort", "take_upstream"]),
});
const SourceMergePrepareBody = Schema.Struct({
  skill_name: Schema.String,
  harness_id: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
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
const CompleteCloudAccountLinkBody = Schema.Struct({
  link_id: Schema.String,
  preferences: SyncPreferences,
});
const BillingCheckoutBody = Schema.Struct({
  plan: Schema.Literals(["pro", "team"]),
  seats: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});
const BillingFinalizeBody = Schema.Struct({ session_id: Schema.NonEmptyString });
const TeamRolloutPolicyBody = Schema.Struct({
  policy: Schema.Literals(["manual", "notify", "automatic"]),
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
const PortfolioQuarantineBatchBody = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      skill_name: Schema.String,
      skill_path: Schema.String,
    }),
  ),
});
const PortfolioRestoreBody = Schema.Struct({ quarantine_id: Schema.String });
const RemovalDecisionBody = Schema.Struct({
  skill_name: Schema.String,
  locations: Schema.Array(
    Schema.Struct({
      skill_path: Schema.String,
      connection: Schema.NullOr(Schema.String),
    }),
  ),
});
const ConsolidationDecisionBody = Schema.Struct({
  skill_name: Schema.String,
  canonical_skill_path: Schema.String,
  target_skill_paths: Schema.Array(Schema.String),
});
const SkillSetConflictDecisionBody = Schema.Struct({
  set_id: Schema.String,
  project_root: Schema.String,
});

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
function decodeRouteSegment(
  operation: string,
  value: string,
): Effect.Effect<string, DashboardOperationError> {
  return Effect.try({
    try: () => decodeURIComponent(value),
    catch: () => requestError(operation, "INVALID_FLAG", "The collaboration ID is malformed."),
  }).pipe(
    Effect.flatMap((decoded) =>
      requireNonBlank(operation, decoded, "INVALID_FLAG", "The collaboration ID is required."),
    ),
  );
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
  const resourcesChanged = (resources: readonly DashboardResource[]) =>
    Effect.sync(() => context.onResourcesChanged?.(resources));

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
    const receipt = yield* operations.quarantine({
      skillName: body.skill_name,
      skillPath: body.skill_path,
      confirm: body.confirm === true,
    });
    if (body.confirm === true) yield* resourcesChanged(libraryLocationWriteResources);
    return json(receipt);
  }

  if (url.pathname === "/api/v2/portfolio/quarantine-batch" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "portfolio.quarantine_many",
      request,
      PortfolioQuarantineBatchBody,
      "GUARD_BLOCKED",
      "Bulk quarantine requires at least one skill.",
    );
    if (body.skills.length === 0) {
      return yield* Effect.fail(
        requestError(
          "portfolio.quarantine_many",
          "GUARD_BLOCKED",
          "Bulk quarantine requires at least one skill.",
        ),
      );
    }
    const result = yield* operations.quarantineMany(
      body.skills.map((skill) => ({
        skillName: skill.skill_name,
        skillPath: skill.skill_path,
      })),
    );
    yield* resourcesChanged(libraryLocationWriteResources);
    return json(result);
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
    const receipt = yield* operations.restore(body.quarantine_id);
    yield* resourcesChanged(libraryLocationWriteResources);
    return json(receipt);
  }
  const libraryTransfer = yield* routeLibraryTransfer(
    request,
    url,
    context.allowedOrigins,
    operations,
  );
  if (libraryTransfer) {
    if (libraryTransfer.installed) yield* resourcesChanged(libraryLocationWriteResources);
    return libraryTransfer.response;
  }
  if (url.pathname === "/api/v2/decisions" && request.method === "GET") {
    return json({ decisions: yield* operations.decisions });
  }
  if (url.pathname === "/api/v2/decisions/removals" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "decisions.removal.prepare",
      request,
      RemovalDecisionBody,
      "GUARD_BLOCKED",
      "Removal review requires a skill and at least one location.",
    );
    const decision = yield* operations.prepareRemovalDecision({
      skillName: body.skill_name,
      locations: body.locations.map((location) => ({
        skillPath: location.skill_path,
        connection: location.connection,
      })),
    });
    yield* resourcesChanged(durableDecisionResources.prepare);
    return json(decision);
  }
  if (url.pathname === "/api/v2/decisions/consolidations" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "decisions.consolidation.prepare",
      request,
      ConsolidationDecisionBody,
      "GUARD_BLOCKED",
      "Consolidation review requires a skill, canonical source, and target locations.",
    );
    const decision = yield* operations.prepareConsolidationDecision({
      skillName: body.skill_name,
      canonicalSkillPath: body.canonical_skill_path,
      targetSkillPaths: body.target_skill_paths,
    });
    yield* resourcesChanged(durableDecisionResources.prepare);
    return json(decision);
  }
  if (url.pathname === "/api/v2/decisions/skill-set-conflicts" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "decisions.skill_set.prepare",
      request,
      SkillSetConflictDecisionBody,
      "GUARD_BLOCKED",
      "Skill Set conflict review requires a set and project root.",
    );
    const decision = yield* operations.prepareSkillSetConflictDecision({
      set_id: body.set_id,
      project_root: body.project_root,
    });
    yield* resourcesChanged(durableDecisionResources.prepare);
    return json(decision);
  }
  const durableDecisionReadMatch = url.pathname.match(/^\/api\/v2\/decisions\/([0-9a-f-]{36})$/i);
  const durableDecisionArtifactMatch = url.pathname.match(
    /^\/api\/v2\/decisions\/([0-9a-f-]{36})\/(run-package|summary)$/i,
  );
  if (durableDecisionArtifactMatch && request.method === "GET") {
    const decision = yield* operations.decision(durableDecisionArtifactMatch[1]!);
    if (decision.requested_action !== "apply_source_merge") {
      return yield* Effect.fail(
        requestError(
          "decisions.artifact",
          "UNSUPPORTED_DECISION_ARTIFACT",
          "Run Package artifacts are available for source merge decisions.",
        ),
      );
    }
    const review = adaptLocalSourceMerge(decision);
    return json(
      durableDecisionArtifactMatch[2] === "run-package"
        ? buildRunPackage(review)
        : summarizeRunReview(review),
    );
  }
  if (durableDecisionReadMatch && request.method === "GET") {
    return json(yield* operations.decision(durableDecisionReadMatch[1]!));
  }
  const durableDecisionActionMatch = url.pathname.match(
    /^\/api\/v2\/decisions\/([0-9a-f-]{36})\/(approve|decline|rollback)$/i,
  );
  if (durableDecisionActionMatch && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const approvalId = durableDecisionActionMatch[1]!;
    const action = durableDecisionActionMatch[2]!;
    const decision =
      action === "rollback"
        ? yield* operations.rollbackDecision(approvalId)
        : yield* operations.decideDecision(
            approvalId,
            action === "approve" ? "approve" : "decline",
          );
    yield* resourcesChanged(
      action === "rollback"
        ? durableDecisionResources.rollback
        : action === "approve" && decision.status === "approved"
          ? durableDecisionResources.approve
          : durableDecisionResources.decide,
    );
    return json(decision);
  }

  if (url.pathname === "/api/v2/skill-intelligence" && request.method === "GET") {
    return json(yield* operations.skillIntelligence);
  }

  if (url.pathname === "/api/v2/skill-intelligence/classification" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "skill_intelligence.classification.update",
      request,
      UpdateSkillClassificationBody,
      "INVALID_FEEDBACK",
      "A skill, inferred category, and valid category or null are required.",
    );
    const input: UpdateSkillClassificationRequest = { ...body };
    return json(yield* operations.updateSkillClassification(input));
  }

  if (
    url.pathname === "/api/v2/skill-intelligence/suggestions/review" &&
    request.method === "POST"
  ) {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "skill_intelligence.suggestion.review",
      request,
      ReviewSkillSetSuggestionBody,
      "INVALID_FEEDBACK",
      "A current suggestion, decision, and reason code are required.",
    );
    const validReason =
      (body.decision === "accepted" && body.reason_code === "accepted_as_suggested") ||
      (body.decision === "edited" && body.reason_code === "edited_before_creation") ||
      (body.decision === "dismissed" &&
        body.reason_code !== "accepted_as_suggested" &&
        body.reason_code !== "edited_before_creation");
    if (!validReason) {
      return yield* Effect.fail(
        requestError(
          "skill_intelligence.suggestion.review",
          "INVALID_FEEDBACK",
          "The review reason does not match the decision.",
        ),
      );
    }
    const input: ReviewSkillSetSuggestionRequest = {
      ...body,
      edited_fields: body.edited_fields ? [...body.edited_fields] : undefined,
      result: body.result
        ? {
            ...body.result,
            harnesses: [...body.result.harnesses],
            skills: [...body.result.skills],
          }
        : undefined,
    };
    return json(yield* operations.reviewSkillSetSuggestion(input));
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
      const receipt = yield* operations.applySourceUpdate(body.skill_name, body.strategy);
      yield* resourcesChanged(sourceUpdateResources.apply);
      return json(receipt);
    }
    if (url.pathname === "/api/v2/library/source-update/merge/prepare") {
      const body = yield* decodeBody(
        "library.source_update.merge.prepare",
        request,
        SourceMergePrepareBody,
        "INVALID_FLAG",
        "skill_name and a source-merge-capable connection are required.",
      );
      const preview = yield* operations.prepareSourceMerge(
        body.skill_name,
        body.harness_id,
        body.model ?? null,
      );
      yield* resourcesChanged(sourceMergeDecisionResources.prepare);
      return json(preview);
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
      const candidate = yield* operations.reviewInsight(input);
      yield* resourcesChanged(insightDecisionResources.review);
      return json(candidate);
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
      const draft = yield* operations.draftInsight(input);
      yield* resourcesChanged(insightDecisionResources.draft);
      return json(draft);
    }
    if (url.pathname === "/api/v2/insights/evaluate") {
      const body = yield* decodeBody(
        "insights.evaluate",
        request,
        CandidateBody,
        "MISSING_FLAG",
        "candidate_id is required.",
      );
      const gate = yield* operations.evaluateInsight(body.candidate_id);
      yield* resourcesChanged(insightDecisionResources.evaluate);
      return json(gate);
    }
    if (url.pathname === "/api/v2/insights/release") {
      const body = yield* decodeBody(
        "insights.release",
        request,
        CandidateBody,
        "MISSING_FLAG",
        "candidate_id is required.",
      );
      const release = yield* operations.releaseInsight(body.candidate_id);
      yield* resourcesChanged(insightDecisionResources.release);
      return json(release);
    }
    return new Response("Not found", { status: 404, headers: dashboardCorsHeaders() });
  }

  if (url.pathname === "/api/v2/skill-sets" && request.method === "GET") {
    return json(yield* operations.skillSets);
  }

  if (url.pathname === "/api/v2/plugins" && request.method === "GET") {
    return json(yield* operations.plugins);
  }

  if (url.pathname === "/api/v2/plugins/manage" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "plugins.manage",
      request,
      PluginManagementBody,
      "INVALID_FLAG",
      "host, plugin_id, and a supported plugin action are required.",
    );
    yield* requireNonBlank(
      "plugins.manage",
      body.plugin_id,
      "MISSING_FLAG",
      "plugin_id is required.",
    );
    return json(
      yield* operations.managePlugin({
        host: body.host,
        pluginId: body.plugin_id,
        action: body.action,
      }),
    );
  }

  if (url.pathname === "/api/v2/skill-sets/packs" && request.method === "GET") {
    return json(yield* operations.listSkillSetPacks());
  }

  const skillSetMatch = /^\/api\/v2\/skill-sets\/([^/]+)$/.exec(url.pathname);
  if (skillSetMatch && request.method === "DELETE") {
    if (!operations.skillSetsWritable) return readOnlySkillSetsResponse();
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const result = yield* operations.deleteSkillSet(decodeURIComponent(skillSetMatch[1] ?? ""));
    yield* resourcesChanged(projectSkillSetResources.remove);
    context.onSkillSetChanged?.();
    return json(result);
  }

  const skillSetPackMatch = /^\/api\/v2\/skill-sets\/packs\/([^/]+)$/.exec(url.pathname);
  if (skillSetPackMatch && request.method === "DELETE") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    return json(
      yield* operations.revokeSkillSetPack(decodeURIComponent(skillSetPackMatch[1] ?? "")),
    );
  }

  if (url.pathname.startsWith("/api/v2/skill-sets") && request.method === "POST") {
    if (!operations.skillSetsWritable) return readOnlySkillSetsResponse();
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/v2/skill-sets/packs/preview") {
      const body = yield* decodeBody(
        "skill_sets.pack_preview",
        request,
        SkillSetPackPreviewBody,
        "MISSING_FLAG",
        "pack_url is required.",
      );
      return json(yield* operations.previewSkillSetPack(body.pack_url));
    }
    if (url.pathname === "/api/v2/skill-sets/packs/import") {
      const body = yield* decodeBody(
        "skill_sets.pack_import",
        request,
        SkillSetPackImportBody,
        "MISSING_FLAG",
        "pack_url and expected_object_sha256 are required.",
      );
      const result = yield* operations.importSkillSetPack({
        packUrl: body.pack_url,
        expectedObjectSha256: body.expected_object_sha256,
      });
      yield* resourcesChanged(projectSkillSetResources.create);
      context.onSkillSetChanged?.();
      return json(result);
    }
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
      const manifest = yield* operations.createSkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.create);
      context.onSkillSetChanged?.();
      return json(manifest);
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
      const manifest = yield* operations.updateSkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.update);
      context.onSkillSetChanged?.();
      return json(manifest);
    }
    if (url.pathname === "/api/v2/skill-sets/derive") {
      const body = yield* decodeBody(
        "skill_sets.derive",
        request,
        DeriveSkillSetBody,
        "MISSING_FLAG",
        "project_root is required.",
      );
      const input: DeriveSkillSetRequest = {
        name: body.name,
        description: body.description,
        project_root: body.project_root,
        harnesses: body.harnesses ? [...body.harnesses] : undefined,
      };
      const manifest = yield* operations.deriveSkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.derive);
      context.onSkillSetChanged?.();
      return json(manifest);
    }
    if (url.pathname === "/api/v2/skill-sets/export") {
      const body = yield* decodeBody(
        "skill_sets.export",
        request,
        ApplySkillSetBody,
        "MISSING_FLAG",
        "set_id and project_root are required.",
      );
      const input: ExportSkillSetRequest = { ...body };
      const receipt = yield* operations.exportSkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.export);
      return json(receipt);
    }
    if (url.pathname === "/api/v2/skill-sets/plugin-export") {
      const body = yield* decodeBody(
        "skill_sets.plugin_export",
        request,
        PluginExportBody,
        "MISSING_FLAG",
        "set_id and target are required.",
      );
      return json(yield* operations.exportSkillSetPlugin(body));
    }
    if (url.pathname === "/api/v2/skill-sets/plugin-install/preview") {
      const body = yield* decodeBody(
        "skill_sets.plugin_install_preview",
        request,
        PluginInstallPreviewBody,
        "MISSING_FLAG",
        "set_id is required.",
      );
      return json(yield* operations.previewSkillSetPluginInstall(body.set_id));
    }
    if (url.pathname === "/api/v2/skill-sets/plugin-install") {
      const body = yield* decodeBody(
        "skill_sets.plugin_install",
        request,
        PluginInstallBody,
        "MISSING_FLAG",
        "set_id, expected_revision_hash, and hosts are required.",
      );
      return json(
        yield* operations.installSkillSetPlugin({
          setId: body.set_id,
          expectedRevisionHash: body.expected_revision_hash,
          hosts: body.hosts,
        }),
      );
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
      const plan = yield* operations.planSkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.plan);
      return json(plan);
    }
    if (url.pathname === "/api/v2/skill-sets/project-plan") {
      const body = yield* decodeBody(
        "skill_sets.project_plan",
        request,
        ProjectProvisionBody,
        "MISSING_FLAG",
        "project_root and set_ids are required.",
      );
      return json(
        yield* operations.previewProjectProvision({
          project_root: body.project_root,
          set_ids: body.set_ids,
          harnesses: body.harnesses,
        }),
      );
    }
    if (url.pathname === "/api/v2/skill-sets/project-apply") {
      const body = yield* decodeBody(
        "skill_sets.project_apply",
        request,
        ProjectProvisionBody,
        "MISSING_FLAG",
        "project_root and set_ids are required.",
      );
      const result = yield* operations.applyProjectProvision({
        project_root: body.project_root,
        set_ids: body.set_ids,
        harnesses: body.harnesses,
        create_react_project: body.create_react_project === true,
      });
      yield* resourcesChanged(projectSkillSetResources.apply);
      return json(result);
    }
    if (url.pathname === "/api/v2/skill-sets/apply") {
      const body = yield* decodeBody(
        "skill_sets.apply",
        request,
        ApplySkillSetBody,
        "MISSING_FLAG",
        "set_id and project_root are required.",
      );
      const input: ApplySkillSetRequest = { ...body };
      const receipt = yield* operations.applySkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.apply);
      return json(receipt);
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
      const receipt = yield* operations.rollbackSkillSet(input);
      yield* resourcesChanged(projectSkillSetResources.rollback);
      return json(receipt);
    }
    return json({ error: { code: "NOT_FOUND", message: "Unknown Skill Set operation." } }, 404);
  }
  if (url.pathname === "/api/v2/settings" && request.method === "GET") {
    return json(yield* operations.settings);
  }
  if (url.pathname === "/api/v2/settings/cloud-account/link/start" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    return json(yield* operations.startCloudAccountLink);
  }
  if (
    url.pathname === "/api/v2/settings/cloud-account/link/complete" &&
    request.method === "POST"
  ) {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "settings.cloud_account.complete",
      request,
      CompleteCloudAccountLinkBody,
      "OPERATION_FAILED",
      "Cloud account linking failed.",
    );
    const input: CompleteCloudAccountLinkRequest = {
      link_id: body.link_id,
      preferences: { ...body.preferences },
    };
    return json(yield* operations.completeCloudAccountLink(input));
  }
  if (url.pathname === "/api/v2/settings/billing/status" && request.method === "GET") {
    return json(yield* operations.cloudBilling("status"));
  }
  if (url.pathname === "/api/v2/settings/billing/portal" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    return json(yield* operations.cloudBilling("portal"));
  }
  if (url.pathname === "/api/v2/settings/billing/checkout" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "settings.billing.checkout",
      request,
      BillingCheckoutBody,
      "MISSING_FLAG",
      "Choose a billing plan before checkout.",
    );
    return json(
      yield* operations.cloudBilling("checkout", {
        plan: body.plan,
        ...(body.seats === undefined ? {} : { seats: body.seats }),
      }),
    );
  }
  if (url.pathname === "/api/v2/settings/billing/checkout/finalize" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "settings.billing.finalize",
      request,
      BillingFinalizeBody,
      "MISSING_FLAG",
      "Checkout session details are required.",
    );
    return json(yield* operations.cloudBilling("finalize", { sessionId: body.session_id }));
  }

  if (url.pathname === "/api/v2/team-collaboration/access" && request.method === "GET") {
    return json(yield* operations.teamCollaborationAccess);
  }
  if (url.pathname === "/api/v2/team-collaboration" && request.method === "GET") {
    return json(yield* operations.teamCollaborationSnapshot);
  }
  const collaborationRolloutMatch = url.pathname.match(
    /^\/api\/v2\/team-collaboration\/registry\/([^/]+)\/rollout-policy$/,
  );
  if (collaborationRolloutMatch && request.method === "PATCH") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const entryId = yield* decodeRouteSegment(
      "team_collaboration.rollout_policy.update",
      collaborationRolloutMatch[1] ?? "",
    );
    const body = yield* decodeBody(
      "team_collaboration.rollout_policy.update",
      request,
      TeamRolloutPolicyBody,
      "INVALID_FLAG",
      "Choose manual, notify, or automatic rollout.",
    );
    return json(yield* operations.updateTeamCollaborationRolloutPolicy(entryId, body.policy));
  }
  const collaborationDecisionMatch = url.pathname.match(
    /^\/api\/v2\/team-collaboration\/contributions\/([^/]+)\/(adopt|reject|rollback)$/,
  );
  if (collaborationDecisionMatch && request.method === "POST") {
    const unauthorized = mutationFailure(request, context);
    if (unauthorized) return unauthorized;
    const contributionId = yield* decodeRouteSegment(
      "team_collaboration.contribution.decision",
      collaborationDecisionMatch[1] ?? "",
    );
    const action = collaborationDecisionMatch[2];
    if (action === "adopt" || action === "reject" || action === "rollback") {
      return json(yield* operations.decideTeamCollaborationContribution(contributionId, action));
    }
  }

  if (url.pathname === "/api/v2/settings/remote-library/preview" && request.method === "POST") {
    const unauthorized = mutationFailure(request, context, "A same-origin request is required.");
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "remote_library.preview",
      request,
      RemoteLibraryPreviewBody,
      "OPERATION_FAILED",
      "Sync & Backup preview failed.",
    );
    return json(yield* operations.previewRemoteLibrary(body.preferences));
  }

  if (url.pathname === "/api/v2/settings/remote-library/status" && request.method === "GET") {
    return json(yield* operations.remoteLibrary("status"));
  }
  const workspaceResponse = yield* routeWorkspaceSettings(
    request,
    url,
    context.allowedOrigins,
    operations,
  );
  if (workspaceResponse) return workspaceResponse;

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
      "Sync & Backup update failed.",
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
