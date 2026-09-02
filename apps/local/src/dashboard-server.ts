/**
 * selftune dashboard server — Bun.serve HTTP server for the SPA dashboard,
 * skill report HTML, badges, and action endpoints.
 *
 * Endpoints:
 *   GET  /                     — Serve dashboard SPA shell
 *   GET  /api/v2/events        — SSE stream for live dashboard updates
 *   GET  /api/health           — Dashboard server health probe
 *   GET  /api/v2/doctor        — System health diagnostics (config, logs, hooks, evolution)
 *   GET  /api/v2/overview      — SQLite-backed overview payload
 *   GET  /api/v2/shell         — Compact navigation and Library summary
 *   GET  /api/v2/analytics     — Performance analytics (trends, rankings, heatmap)
 *   GET  /api/v2/skills/:name  — SQLite-backed per-skill report
 *   GET  /api/v2/settings      — Connected harnesses and automation schedule
 *   POST /api/v2/settings/onboarding — Apply human-selected setup choices
 *   POST /api/v2/settings/schedule — Reconcile local automation jobs
 *   POST /api/v2/settings/cloud-account/link/{start,complete} — Link Desktop to Cloud
 *   GET/POST /api/v2/settings/billing/* — Proxy Cloud billing through the local sidecar
 *   GET/PATCH/POST /api/v2/team-collaboration/* — Proxy role-gated Cloud collaboration
 *   POST /api/v2/correction-studies/explicit-corrections — Capture and evaluate a correction
 *   GET  /api/v2/correction-studies/:episodeId — Read durable correction evidence
 *   GET  /api/v2/library          — Canonical local Skill Library snapshot
 *   GET  /api/v2/skill-intelligence — Local skill classifications and evidence-backed set suggestions
 *   POST /api/v2/skill-intelligence/classification — Correct or reset a skill category
 *   POST /api/v2/skill-intelligence/suggestions/review — Review an evidence snapshot
 *   POST /api/v2/library/source-update/preview — Preview a lock-backed upstream update
 *   POST /api/v2/library/source-update/apply — Apply a backed-up upstream update
 *   POST /api/v2/library/source-update/merge/prepare — Stage an agent-assisted three-way merge
 *   POST /api/v2/decisions/:id/approve — Approve a reviewed durable decision
 *   GET  /api/v2/insights         — Unified synthesis and portfolio review queue
 *   POST /api/v2/insights/review  — Record an explicit synthesis decision
 *   POST /api/v2/insights/draft   — Create a draft from an accepted candidate
 *   POST /api/v2/insights/evaluate — Run immutable draft release gates
 *   POST /api/v2/insights/release — Release a passing revision to the Library
 *   GET  /api/v2/correction-studies/signals — Read-only, review-required correction hypotheses
 *   POST /api/v2/trace-candidates/prepare — Prepare a bounded candidate from local trace evidence
 *   POST /api/v2/trace-candidates/evaluate — Run registered managed replay and persist review evidence
 *   GET  /api/v2/skill-sets       — List project Skill Sets and apply receipts
 *   GET  /api/v2/plugins          — Discover installed Claude and Codex plugins
 *   POST /api/v2/plugins/manage   — Run a supported host-native plugin action
 *   POST /api/v2/skill-sets       — Create a content-addressed Skill Set
 *   POST /api/v2/skill-sets/update — Update a Skill Set with optimistic concurrency
 *   DELETE /api/v2/skill-sets/:id — Remove a Skill Set from the local library
 *   POST /api/v2/skill-sets/derive — Capture a project's active skills
 *   POST /api/v2/skill-sets/export — Write a portable project manifest
 *   POST /api/v2/skill-sets/plugin-install/preview — Inspect native host availability
 *   POST /api/v2/skill-sets/plugin-install — Install through Claude or Codex
 *   POST /api/v2/skill-sets/plan  — Preview project materialization
 *   POST /api/v2/skill-sets/apply — Apply a conflict-free Skill Set
 *   POST /api/v2/skill-sets/rollback — Roll back receipt-owned paths
 *   POST /api/v2/settings/remote-library/preview — Inspect sync artifacts
 *   GET  /api/v2/settings/remote-library/status — Inspect sync health and integrity
 *   POST /api/v2/settings/remote-library/{sync,export,restore} — Run explicit backup actions
 *   POST /api/v2/library/{backup,install} — Back up or install one immutable skill revision
 *   GET/POST /api/v2/settings/remote-library/shares — Manage private shares
 *   POST /api/actions/sync         — Import configured harness sessions now
 *   POST /api/actions/create-check — Trigger `selftune create check` for a draft package
 *   POST /api/actions/watch        — Trigger `selftune watch` for a skill
 *   POST /api/actions/evolve       — Trigger `selftune evolve` for a skill
 *   POST /api/actions/rollback     — Trigger `selftune rollback` for a skill
 *   POST /api/actions/watchlist — Persist creator watchlist preferences
 *   POST /api/hooks/:name       — Authenticated Claude Code hook execution/ingest
 *   GET  /badge/:name          — Skill health badge
 *   GET  /report/:name         — Skill health report HTML
 */
/* eslint-disable max-lines -- Legacy server composition is being extracted route by route. */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import type { BlindBenchmarkExecutor } from "@selftune/skill-intelligence/blind-benchmark";

import { getCachedUpdateStatus } from "@selftune/runtime/auto-update";
import { DASHBOARD_ACTION_STREAM_LOG, LOG_DIR } from "@selftune/runtime/constants";
import type { DashboardHostKind } from "@selftune/dashboard-core/host";
import type { HealthResponse } from "@selftune/runtime/dashboard-contract";
import { resolveSelftunePaths } from "@selftune/config";
import {
  getEvaluationSubmissionDraft,
  makeLocalDatabaseLive,
  LocalDatabaseService,
  markEvaluationSubmissionDraftStale,
  markEvaluationSubmissionDraftSubmitted,
} from "@selftune/local-store";
import { EvidenceCohort, EvidenceCohortEntry } from "@selftune/observability/evidence-cohort";
import { LocalTraceImporter } from "@selftune/observability/local-trace-importer";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import { maintainUploadArtifacts } from "@selftune/runtime/alpha-upload/prune";
import {
  createCompatibilityExportWorker,
  type CompatibilityExportWorker,
} from "@selftune/runtime/alpha-upload/worker";
import {
  CloudEvaluationSubmissionClient,
  makeCloudEvaluationSubmissionClientLayer,
} from "@selftune/runtime/evolution/cloud-evaluation-submission-client";
import {
  CloudEvaluationTargetClient,
  makeCloudEvaluationTargetClientLayer,
} from "@selftune/runtime/evolution/cloud-evaluation-target-client";

import { createDashboardAuth } from "./dashboard-auth.js";
import { createDashboardEventHub } from "./dashboard-events.js";
import {
  DashboardOperationError,
  DashboardOperations,
  makeDashboardOperationsLayer,
  type DashboardOperationOverrides,
} from "./dashboard-operations.js";
import { dashboardCorsHeaders as corsHeaders } from "./dashboard-http.js";
import { createDashboardSpa } from "./dashboard-spa.js";
import { handleDashboardApplicationRoute } from "./routes/application.js";
import { createDashboardCoreRoutes, type DashboardCoreRouteOverrides } from "./routes/core.js";
import { createEvaluationDraftSubmissionRoutes } from "./routes/evaluation-draft-submissions.js";
import {
  CorrectionStudyServiceError,
  createCorrectionStudyRoutes,
} from "./routes/correction-studies.js";
import { createTraceCandidateRoutes } from "./routes/trace-candidates.js";
import {
  CorrectionStudyServiceFailure,
  captureExplicitCorrectionStudy,
  lookupCorrectionStudy,
} from "./correction-study-service.js";
import {
  CorrectionSignalCursorError,
  discoverExplicitCorrectionSignalPage,
} from "@selftune/runtime/correction-study/signal-discovery";
import { listCorrectionReviews } from "./correction-review-projection.js";
import { recordLocalCorrectionReviewDecision } from "./correction-review-service.js";
import {
  TraceCandidatePreparation,
  makeTraceCandidatePreparationLayer,
  decodePreparedTraceCandidateDraft,
} from "./trace-candidate-service.js";
import {
  HistoricalSkillImprovement,
  makeHistoricalSkillImprovementLayer,
} from "./historical-skill-improvement-service.js";
import { makeHostHistoricalSkillReplayExecutorFactory } from "./historical-skill-replay-executor.js";
import { projectImproveEvaluationSubmission } from "@selftune/runtime/evolution/improve-evaluation-projector";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";
import { createHookRoutes, type HookRunners } from "./routes/hooks.js";
import { createOtlpRoutes, OtlpInvalidPayloadError } from "./routes/otlp.js";

export interface DashboardRuntimeIdentity {
  readonly configDir: string;
  readonly instanceId: string;
  readonly owner: NonNullable<HealthResponse["runtime_owner"]>;
  readonly serviceInstallationNonce?: string;
  readonly supervision: NonNullable<HealthResponse["runtime_supervision"]>;
  readonly ownerExecutablePath: string;
}

export interface DashboardServerOptions
  extends DashboardOperationOverrides, DashboardCoreRouteOverrides {
  port?: number;
  host?: string;
  spaDir?: string;
  spaProxyUrl?: string;
  openBrowser?: boolean;
  authToken?: string;
  authCookie?: boolean;
  authCookieSecure?: boolean;
  allowedOrigins?: string[];
  hookRunners?: Partial<HookRunners>;
  externalRequestHandler?: (request: Request) => Response | null | Promise<Response | null>;
  runtimeMode?: HealthResponse["process_mode"];
  runtimeIdentity?: DashboardRuntimeIdentity;
  runtimeShutdown?: () => void;
  dashboardHost?: Extract<DashboardHostKind, "local" | "selfhost">;
  dashboardOrigin?: string;
  manageProcessSignals?: boolean;
  /** Test seam for the daemon-owned legacy V2 compatibility export worker. */
  compatibilityExportWorkerFactory?: (
    sqlite: Database,
    configPath: string,
  ) => CompatibilityExportWorker;
  /**
   * Managed replay capability supplied by a concrete harness adapter. The
   * HTTP surface remains fail-closed when no harness owns execution.
   */
  historicalReplayExecutor?: BlindBenchmarkExecutor;
}

interface DashboardSocketData {
  upstreamUrl?: string;
}

const CloudTargetId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
const ExactTargetSelection = Schema.Struct({
  source_id: CloudTargetId,
  snapshot_id: CloudTargetId,
  skill_id: CloudTargetId,
  suite_id: CloudTargetId,
  manifest_digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
});
const exactTargetSelection = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Effect.fail(new Error("Select one exact Cloud evaluation target."));
  }
  const exactKeys = ["source_id", "snapshot_id", "skill_id", "suite_id", "manifest_digest"];
  if (Object.keys(value).length !== exactKeys.length || !exactKeys.every((key) => key in value)) {
    return Effect.fail(new Error("Select one exact Cloud evaluation target."));
  }
  return Schema.decodeUnknownEffect(ExactTargetSelection)(value).pipe(
    Effect.mapError(() => new Error("Select one exact Cloud evaluation target.")),
  );
};

function allowedDashboardOrigins(
  hostname: string,
  port: number,
  additionalOrigins: ReadonlyArray<string> = [],
): Set<string> {
  const origins = new Set<string>([`http://${hostname}:${port}`, ...additionalOrigins]);
  if (hostname === "localhost") {
    origins.add(`http://127.0.0.1:${port}`);
  } else if (hostname === "127.0.0.1") {
    origins.add(`http://localhost:${port}`);
  }
  return origins;
}

function otlpEnabled(
  hostname: string,
  authToken: string | undefined,
  dashboardHost: DashboardHostKind,
) {
  return (
    dashboardHost === "local" &&
    authToken !== undefined &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  );
}

function createLiveCompatibilityExportWorker(
  sqlite: Database,
  configPath: string,
): CompatibilityExportWorker {
  return createCompatibilityExportWorker({
    flush: async ({ signal, batchSize }) => {
      const [configModule, credentialModule, exportModule] = await Promise.all([
        import("@selftune/config"),
        import("@selftune/runtime/auth/cloud-credential"),
        import("@selftune/runtime/alpha-upload/index"),
      ]);
      const config = configModule.loadConfigSync(configPath);
      if (!config?.alpha?.enrolled) {
        return { sent: 0, failed: 0, skipped: 0, skipped_unchanged: 0 };
      }
      const apiKey = credentialModule.resolveCloudCredential(config, {
        configPath,
      });
      if (!apiKey) return { sent: 0, failed: 0, skipped: 0, skipped_unchanged: 0 };
      const summary = await exportModule.flushCompatibilityExport(sqlite, {
        enrolled: true,
        apiKey,
        batchSize,
        signal,
      });
      return { ...summary, skipped_unchanged: 0 };
    },
  });
}

export async function startDashboardServer(options?: DashboardServerOptions): Promise<{
  close: () => Promise<void>;
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
  port: number;
}> {
  const port = options?.port ?? 3141;
  const hostname = options?.host ?? "localhost";
  const openBrowser = options?.openBrowser ?? true;
  const authToken = options?.authToken;
  if (options?.runtimeIdentity && !authToken) {
    throw new TypeError("Runtime identity requires authenticated dashboard health.");
  }
  const runtimeMode = options?.runtimeMode ?? (import.meta.main ? "dev-server" : "test");
  const dashboardHost = options?.dashboardHost ?? "local";
  const storagePaths = resolveSelftunePaths({
    environment: {
      SELFTUNE_CONFIG_DIR: options?.skillSetConfigRoot ?? process.env.SELFTUNE_CONFIG_DIR,
      SELFTUNE_HOME: process.env.SELFTUNE_HOME,
    },
    homeDirectory: homedir(),
  });
  const spa = createDashboardSpa({
    directory: options?.spaDir,
    proxyUrl: options?.spaProxyUrl,
  });
  const auth = createDashboardAuth({
    token: authToken,
    cookie: options?.authCookie,
    cookieSecure: options?.authCookieSecure,
  });
  const localDatabaseLayer = makeLocalDatabaseLive(storagePaths.localDatabasePath);
  const evaluationSubmissionRuntime = ManagedRuntime.make(
    makeCloudEvaluationSubmissionClientLayer({
      configPath: storagePaths.configPath,
    }),
  );
  const evaluationTargetRuntime = ManagedRuntime.make(
    makeCloudEvaluationTargetClientLayer({
      configPath: storagePaths.configPath,
    }),
  );
  const operationsRuntime = ManagedRuntime.make(
    makeDashboardOperationsLayer({
      ...options,
      skillSetConfigRoot: storagePaths.configDir,
    }).pipe(Layer.provideMerge(localDatabaseLayer)),
  );
  const localDatabase = await operationsRuntime
    .runPromise(Effect.map(LocalDatabaseService, ({ sqlite }) => sqlite))
    .catch(async (error: unknown) => {
      await evaluationSubmissionRuntime.dispose();
      await evaluationTargetRuntime.dispose();
      await operationsRuntime.dispose();
      throw error;
    });
  // Candidate preparation opens an analytical store only for the request. The
  // OTLP importer may own its own long-lived store; Desktop must not hold a
  // second independent DuckDB instance for its entire lifetime.
  const prepareTraceCandidate = async (input: unknown) => {
    const { makeDuckDbNodeApiAnalyticalStoreLive } =
      await import("@selftune/observability/duckdb-node-api");
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const preparation = yield* TraceCandidatePreparation;
          return yield* preparation.prepare(input);
        }).pipe(
          Effect.provide(
            Layer.provide(
              makeTraceCandidatePreparationLayer({ sqlite: localDatabase }),
              makeDuckDbNodeApiAnalyticalStoreLive(storagePaths.localAnalyticsPath),
            ),
          ),
        ),
      ),
    );
  };
  const evaluateHistoricalSkill = async (input: unknown) => {
    const { makeDuckDbNodeApiAnalyticalStoreLive } =
      await import("@selftune/observability/duckdb-node-api");
    const preparationLayer = Layer.provide(
      makeTraceCandidatePreparationLayer({ sqlite: localDatabase }),
      makeDuckDbNodeApiAnalyticalStoreLive(storagePaths.localAnalyticsPath),
    );
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const improvement = yield* HistoricalSkillImprovement;
          return yield* improvement.evaluate(input);
        }).pipe(
          Effect.provide(
            Layer.provide(
              makeHistoricalSkillImprovementLayer({
                sqlite: localDatabase,
                ...(options?.historicalReplayExecutor
                  ? { executor: options.historicalReplayExecutor }
                  : { executorFactory: makeHostHistoricalSkillReplayExecutorFactory() }),
              }),
              preparationLayer,
            ),
          ),
        ),
      ),
    );
  };
  const correctionStudyRouteError = (error: unknown): CorrectionStudyServiceError =>
    error instanceof CorrectionStudyServiceFailure
      ? new CorrectionStudyServiceError(error.code, error.message, error.status)
      : new CorrectionStudyServiceError(
          "CORRECTION_STUDY_PERSISTENCE_FAILED",
          error instanceof Error ? error.message : "Correction study operation failed.",
          503,
        );
  const captureExplicitCorrection = async (input: unknown) =>
    Effect.runPromise(captureExplicitCorrectionStudy(localDatabase, input)).catch(
      (error: unknown) => {
        throw correctionStudyRouteError(error);
      },
    );
  const lookupCorrection = async (episodeId: string) =>
    Effect.runPromise(lookupCorrectionStudy(localDatabase, episodeId)).catch((error: unknown) => {
      throw correctionStudyRouteError(error);
    });
  const discoverCorrectionSignals = async (input: {
    readonly limit: number;
    readonly cursor: string | null;
  }) => {
    try {
      return discoverExplicitCorrectionSignalPage(localDatabase, input);
    } catch (error) {
      if (error instanceof CorrectionSignalCursorError) {
        throw new CorrectionStudyServiceError(
          "INVALID_CORRECTION_SIGNAL_QUERY",
          error.message,
          400,
        );
      }
      throw error;
    }
  };
  const loadCurrentDraft = async (draftId: string) => {
    const draft = await Effect.runPromise(getEvaluationSubmissionDraft(localDatabase, draftId));
    if (!draft) throw new Error("The prepared trace candidate no longer exists.");
    if (draft.lifecycle === "submitted" && draft.cloud_run_id) return { draft, payload: null };
    if (draft.lifecycle === "stale")
      throw new Error("This candidate is stale because the local skill changed.");
    const installed = findInstalledSkillPackages(getDefaultSkillSearchDirs()).find(
      (skill) => skill.name === draft.skill_name,
    );
    const revision = installed ? computeSkillVersionHash(installed.skill_path) : undefined;
    if (revision !== draft.skill_revision) {
      await Effect.runPromise(
        markEvaluationSubmissionDraftStale(localDatabase, { draft_id: draftId }),
      );
      throw new Error("This candidate is stale because the local skill revision changed.");
    }
    const payload = await Effect.runPromise(
      decodePreparedTraceCandidateDraft(JSON.parse(draft.payload_json)),
    );
    if (payload.candidate === null) {
      throw new Error("This search receipt has no selected candidate to submit.");
    }
    return { draft, payload };
  };
  const discoverDraftTargets = async (draftId: string) => {
    const loaded = await loadCurrentDraft(draftId);
    if (loaded.draft.lifecycle === "submitted") {
      return {
        draft_id: draftId,
        lifecycle: "submitted" as const,
        run_id: loaded.draft.cloud_run_id,
        targets: [],
        blockers: [],
      };
    }
    const payload = loaded.payload;
    if (!payload) throw new Error("The prepared trace candidate is unavailable.");
    const candidate = payload.candidate;
    if (candidate === null) throw new Error("This search receipt has no selected candidate.");
    const discovery = await evaluationTargetRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudEvaluationTargetClient;
        return yield* client.discover({
          skill_name: loaded.draft.skill_name,
          skill_revision: loaded.draft.skill_revision,
        });
      }),
    );
    const targets = discovery.targets.filter(
      (target) =>
        target.lane === "outcome_task" &&
        !target.verification_only &&
        target.min_repetitions <= target.max_repetitions &&
        target.max_repetitions >= 3 &&
        target.skill_revision === candidate.target_revision,
    );
    return {
      draft_id: draftId,
      lifecycle: "prepared" as const,
      run_id: null,
      targets,
      blockers: discovery.blockers,
    };
  };
  const submitDraftTarget = async (draftId: string, unknownTarget: unknown) => {
    const loaded = await loadCurrentDraft(draftId);
    if (loaded.draft.lifecycle === "submitted" && loaded.draft.cloud_run_id) {
      return {
        run_id: loaded.draft.cloud_run_id,
        status: "scheduled",
        dispatch: "scheduled" as const,
      };
    }
    if (!loaded.payload) throw new Error("The prepared trace candidate is unavailable.");
    if (loaded.payload.schema_version !== 1) {
      throw new Error(
        "Historical task-quality drafts are local replay artifacts and cannot be submitted as correlated-error Cloud evidence.",
      );
    }
    const selection = await Effect.runPromise(exactTargetSelection(unknownTarget));
    const discovered = await discoverDraftTargets(draftId);
    const target = discovered.targets.find(
      (candidate) =>
        candidate.source_id === selection.source_id &&
        candidate.snapshot_id === selection.snapshot_id &&
        candidate.skill_id === selection.skill_id &&
        candidate.suite_id === selection.suite_id &&
        candidate.manifest_digest === selection.manifest_digest,
    );
    if (!target) throw new Error("The selected Cloud target is no longer eligible.");
    const entries = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Array(EvidenceCohortEntry))(loaded.payload.cohort.entries),
    );
    const cohort = EvidenceCohort.make({
      ...loaded.payload.cohort,
      target_skill: { ...loaded.payload.cohort.target_skill, skill_path: "[local-path-redacted]" },
      entries,
    });
    const submission = await Effect.runPromise(
      projectImproveEvaluationSubmission({
        cohort,
        candidate: {
          candidate_kind: "existing_skill_body_mutation",
          proposal_id: loaded.payload.candidate.proposal_id,
          skill_name: cohort.target_skill.skill_name,
          skill_path: "[local-path-redacted]",
          target_revision: loaded.payload.candidate.target_revision,
          cohort_id: cohort.fingerprint,
          cohort_fingerprint: cohort.fingerprint,
          proposed_body: loaded.payload.candidate.proposed_body,
          rationale: loaded.payload.candidate.rationale,
          confidence: 0.5,
          generator_contract_version: "evidence-body-proposal/v1",
          target_section: "local-review",
          scope: "section_local",
          mutation_operation: "refine",
          principle: "Trace-backed review candidate.",
          applicability: "The exact installed skill revision.",
          failure_mode: "Cloud evaluation required.",
          preserved_constraints: [],
          superseded_guidance: [],
          uncertainty: [],
          changed_lines: 0,
        },
        resolved_evidence: loaded.payload.resolved_evidence,
        cloud_source_id: target.source_id,
        cloud_snapshot_id: target.snapshot_id,
        cloud_skill_id: target.skill_id,
        cloud_eval_suite_id: target.suite_id,
        manifest_digest: target.manifest_digest,
        lane: target.lane,
        max_repetitions: Math.max(3, target.min_repetitions),
      }),
    );
    const receipt = await evaluationSubmissionRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudEvaluationSubmissionClient;
        return yield* client.submit(submission);
      }),
    );
    const persisted = await Effect.runPromise(
      markEvaluationSubmissionDraftSubmitted(localDatabase, {
        draft_id: draftId,
        cloud_run_id: receipt.run_id,
      }),
    );
    return {
      run_id: persisted.cloud_run_id ?? receipt.run_id,
      status: receipt.status,
      dispatch: "scheduled" as const,
    };
  };
  // The V2 compatibility export is intentionally daemon-owned. Local sync only
  // stages queue entries; this worker performs credential lookup and HTTP later.
  // Self-host and test/dev process modes never start a cloud-export worker.
  const compatibilityExportWorker =
    runtimeMode === "standalone" && dashboardHost === "local"
      ? (options?.compatibilityExportWorkerFactory ?? createLiveCompatibilityExportWorker)(
          localDatabase,
          storagePaths.configPath,
        )
      : undefined;
  let otlpComposition:
    | {
        otlp: typeof import("@selftune/observability/otlp");
        run: <A, E>(
          effect: Effect.Effect<A, E, LocalTraceImporter>,
          signal: AbortSignal,
        ) => Promise<A>;
      }
    | undefined;
  try {
    if (otlpEnabled(hostname, authToken, dashboardHost)) {
      const [{ makeDuckDbNodeApiAnalyticalStoreLive }, otlp] = await Promise.all([
        import("@selftune/observability/duckdb-node-api"),
        import("@selftune/observability/otlp"),
      ]);
      const localTraceLayer = Layer.provide(
        makeLocalTraceImporterLive(localDatabase),
        makeDuckDbNodeApiAnalyticalStoreLive(storagePaths.localAnalyticsPath),
      );
      const semaphore = Semaphore.makeUnsafe(1);
      const provideLocalTrace = <A, E>(effect: Effect.Effect<A, E, LocalTraceImporter>) =>
        Effect.scoped(effect.pipe(Effect.provide(localTraceLayer)));
      // Initialize and migrate once, but release DuckDB immediately. The
      // dashboard must not pin the cross-process writer lock while idle: sync
      // and ingest commands run as separate SelfTune processes.
      await Effect.runPromise(provideLocalTrace(Effect.map(LocalTraceImporter, () => undefined)));
      otlpComposition = {
        otlp,
        run: (effect, signal) =>
          Effect.runPromise(semaphore.withPermit(provideLocalTrace(effect)), { signal }),
      };
    }
  } catch (error) {
    await evaluationSubmissionRuntime.dispose();
    await evaluationTargetRuntime.dispose();
    await compatibilityExportWorker?.stop();
    await operationsRuntime.dispose();
    throw error;
  }
  compatibilityExportWorker?.start();
  const otlpRoutes = otlpComposition
    ? createOtlpRoutes(async (signal, encoding, body, abortSignal) => {
        try {
          await otlpComposition.run(
            Effect.gen(function* () {
              const normalized = yield* otlpComposition.otlp.normalizeOtlpExport({
                signal,
                encoding,
                payload: body,
              });
              const importer = yield* LocalTraceImporter;
              return yield* importer.importTrace({
                source_kind: "otlp",
                source_revision: normalized.source_revision,
                normalizer_version: "otlp-v1",
                batch: normalized.batch,
              });
            }),
            abortSignal,
          );
        } catch (error) {
          if (
            error instanceof otlpComposition.otlp.OtlpDecodeFailure ||
            (typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              error._tag === "SchemaError")
          ) {
            throw new OtlpInvalidPayloadError();
          }
          throw error;
        }
      })
    : undefined;
  let backgroundRemoteSyncRunning = false;
  const runBackgroundRemoteSync = async (): Promise<void> => {
    if (backgroundRemoteSyncRunning) return;
    backgroundRemoteSyncRunning = true;
    try {
      await operationsRuntime.runPromise(
        Effect.gen(function* () {
          const operations = yield* DashboardOperations;
          return yield* operations.remoteLibrary("sync");
        }),
      );
    } catch (error) {
      if (!(error instanceof DashboardOperationError && error.code === "FILE_NOT_FOUND")) {
        process.stderr.write(
          `SelfTune Sync & Backup background sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    } finally {
      backgroundRemoteSyncRunning = false;
    }
  };
  const backgroundRemoteSyncStartup =
    runtimeMode === "standalone" ? setTimeout(() => void runBackgroundRemoteSync(), 30_000) : null;
  const backgroundRemoteSyncInterval =
    runtimeMode === "standalone"
      ? setInterval(() => void runBackgroundRemoteSync(), 4 * 60 * 60 * 1_000)
      : null;
  backgroundRemoteSyncStartup?.unref();
  backgroundRemoteSyncInterval?.unref();
  let backgroundUploadPruneRunning = false;
  const runBackgroundUploadPrune = async (): Promise<void> => {
    if (backgroundUploadPruneRunning) return;
    backgroundUploadPruneRunning = true;
    try {
      await operationsRuntime.runPromise(
        Effect.gen(function* () {
          const database = yield* LocalDatabaseService;
          return maintainUploadArtifacts(database.sqlite, new Date());
        }),
      );
    } catch (error) {
      process.stderr.write(
        `SelfTune upload artifact pruning failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      backgroundUploadPruneRunning = false;
    }
  };
  const backgroundUploadPruneStartup =
    runtimeMode === "standalone" ? setTimeout(() => void runBackgroundUploadPrune(), 5_000) : null;
  const backgroundUploadPruneInterval =
    runtimeMode === "standalone"
      ? setInterval(() => void runBackgroundUploadPrune(), 24 * 60 * 60 * 1_000)
      : null;
  backgroundUploadPruneStartup?.unref();
  backgroundUploadPruneInterval?.unref();

  // -- SPA serving -------------------------------------------------------------
  if (spa.proxyUrl) {
    console.log(`SPA proxy enabled at ${spa.proxyUrl.toString()}`);
  } else if (spa.directory) {
    console.log(`SPA found at ${spa.directory}, serving as default dashboard`);
  } else {
    if (options?.spaDir) {
      console.warn(`Configured spaDir is missing index.html: ${options.spaDir}`);
    }
    console.warn(
      "SPA build not found. Run `bun run build:dashboard` before using `selftune dashboard`.",
    );
  }

  const eventHub = createDashboardEventHub({
    databasePath: storagePaths.localDatabasePath,
    actionStreamPath:
      process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG || DASHBOARD_ACTION_STREAM_LOG,
  });
  const coreRoutes = createDashboardCoreRoutes({
    ...options,
    database: localDatabase,
    onActionEvent: eventHub.broadcastAction,
    version: spa.version,
  });
  const hookRoutes = createHookRoutes({ runners: options?.hookRunners });
  const traceCandidateRoutes = createTraceCandidateRoutes({
    prepare: prepareTraceCandidate,
    evaluate: evaluateHistoricalSkill,
  });
  const evaluationDraftSubmissionRoutes = createEvaluationDraftSubmissionRoutes({
    discover: discoverDraftTargets,
    submit: submitDraftTarget,
  });
  const correctionStudyRoutes = createCorrectionStudyRoutes({
    captureExplicitCorrection,
    lookup: lookupCorrection,
    discoverSignals: discoverCorrectionSignals,
    recordReviewDecision: async (input) =>
      recordLocalCorrectionReviewDecision(localDatabase, input),
    listReviews: async (limit) => ({ items: listCorrectionReviews(localDatabase, limit) }),
  });
  const proxiedSpaSockets = new Map<unknown, WebSocket>();
  let disposePromise: Promise<void> | undefined;
  const disposeOwnedResources = (): Promise<void> => {
    disposePromise ??= (async () => {
      if (backgroundRemoteSyncStartup) clearTimeout(backgroundRemoteSyncStartup);
      if (backgroundRemoteSyncInterval) clearInterval(backgroundRemoteSyncInterval);
      if (backgroundUploadPruneStartup) clearTimeout(backgroundUploadPruneStartup);
      if (backgroundUploadPruneInterval) clearInterval(backgroundUploadPruneInterval);
      await compatibilityExportWorker?.stop();
      eventHub.stop();
      for (const upstreamSocket of proxiedSpaSockets.values()) {
        try {
          upstreamSocket.close();
        } catch {
          // The upstream socket already closed.
        }
      }
      proxiedSpaSockets.clear();
      await hookRoutes.waitForIdle();
      await evaluationSubmissionRuntime.dispose();
      await evaluationTargetRuntime.dispose();
      await operationsRuntime.dispose();
    })();
    return disposePromise;
  };

  let boundPort = port;

  // -- HTTP request handler ---------------------------------------------------
  let server: ReturnType<typeof bindServer>;
  function bindServer() {
    return Bun.serve<DashboardSocketData>({
      port,
      hostname,
      idleTimeout: 255,
      websocket: {
        open(ws) {
          const upstreamUrl = ws.data?.upstreamUrl;
          if (!upstreamUrl) {
            ws.close(1011, "Missing upstream websocket target");
            return;
          }
          const upstreamSocket = new WebSocket(upstreamUrl);
          proxiedSpaSockets.set(ws, upstreamSocket);
          upstreamSocket.onmessage = (event) => {
            ws.send(event.data);
          };
          upstreamSocket.onclose = (event) => {
            proxiedSpaSockets.delete(ws);
            try {
              ws.close(event.code || 1000, event.reason);
            } catch {
              ws.close();
            }
          };
          upstreamSocket.onerror = () => {
            proxiedSpaSockets.delete(ws);
            ws.close(1011, "Upstream websocket error");
          };
        },
        message(ws, message) {
          const upstreamSocket = proxiedSpaSockets.get(ws);
          if (!upstreamSocket || upstreamSocket.readyState !== WebSocket.OPEN) {
            return;
          }
          upstreamSocket.send(message);
        },
        close(ws) {
          const upstreamSocket = proxiedSpaSockets.get(ws);
          proxiedSpaSockets.delete(ws);
          upstreamSocket?.close();
        },
      },
      async fetch(req) {
        const url = new URL(req.url);
        const allowedOrigins = allowedDashboardOrigins(
          hostname,
          boundPort,
          options?.allowedOrigins,
        );
        const sessionResponse = await auth.handleSessionRoute(req, url, allowedOrigins);
        if (sessionResponse) return sessionResponse;

        const externalResponse = await options?.externalRequestHandler?.(req);
        if (externalResponse) {
          return externalResponse;
        }

        // Extensions own their preflight policy; local dashboard routes retain
        // the existing permissive loopback policy.
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const authFailure = auth.authorize(req, url);
        if (authFailure) return authFailure;

        const otlpResponse = await otlpRoutes?.handle(req, url);
        if (otlpResponse) return otlpResponse;

        const hookResponse = await hookRoutes.handle(req, url);
        if (hookResponse) return hookResponse;

        const correctionStudyResponse = await correctionStudyRoutes.handle(
          req,
          url,
          allowedOrigins,
        );
        if (correctionStudyResponse) return correctionStudyResponse;

        const traceCandidateResponse = await traceCandidateRoutes.handle(req, url, allowedOrigins);
        if (traceCandidateResponse) return traceCandidateResponse;
        const evaluationDraftResponse = await evaluationDraftSubmissionRoutes.handle(
          req,
          url,
          allowedOrigins,
        );
        if (evaluationDraftResponse) return evaluationDraftResponse;

        // ---- GET /api/health ----
        if (url.pathname === "/api/health" && req.method === "GET") {
          const updateStatus = getCachedUpdateStatus();
          const healthResponse: HealthResponse = {
            ok: true,
            service: "selftune-dashboard",
            version: spa.version(),
            latest_version: updateStatus.latestVersion,
            update_available: updateStatus.updateAvailable,
            auto_update_supported: updateStatus.autoUpdateSupported,
            update_hint: updateStatus.updateHint,
            pid: process.pid,
            runtime_instance_id: options?.runtimeIdentity?.instanceId ?? null,
            runtime_owner: options?.runtimeIdentity?.owner ?? null,
            runtime_supervision: options?.runtimeIdentity?.supervision ?? null,
            service_installation_nonce: options?.runtimeIdentity?.serviceInstallationNonce ?? null,
            owner_executable_path: options?.runtimeIdentity?.ownerExecutablePath ?? null,
            spa: spa.available,
            spa_mode: spa.mode,
            spa_build_id: spa.buildId(),
            spa_proxy_url: spa.proxyUrl?.toString() ?? null,
            v2_data_available: coreRoutes.dataAvailable,
            workspace_root: spa.workspaceRoot,
            git_sha: spa.gitSha(),
            db_path: storagePaths.localDatabasePath,
            log_dir: LOG_DIR,
            config_dir: options?.runtimeIdentity?.configDir ?? storagePaths.configDir,
            watcher_mode: eventHub.watcherMode(),
            process_mode: runtimeMode,
            host: hostname,
            port: boundPort,
          };
          return Response.json(healthResponse, { headers: corsHeaders() });
        }

        if (url.pathname === "/api/runtime/shutdown" && req.method === "POST") {
          const runtimeIdentity = options?.runtimeIdentity;
          if (!runtimeIdentity || !options?.runtimeShutdown) {
            return Response.json(
              { error: { code: "RUNTIME_SHUTDOWN_UNAVAILABLE" } },
              { status: 409, headers: corsHeaders() },
            );
          }
          const payload: unknown = await req.json().catch(() => null);
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("runtime_instance_id" in payload) ||
            payload.runtime_instance_id !== runtimeIdentity.instanceId
          ) {
            return Response.json(
              { error: { code: "RUNTIME_INSTANCE_MISMATCH" } },
              { status: 409, headers: corsHeaders() },
            );
          }
          setTimeout(() => options.runtimeShutdown?.(), 0);
          return Response.json({ accepted: true }, { status: 202, headers: corsHeaders() });
        }

        if (url.pathname === "/api/server-profile" && req.method === "GET") {
          const origin = new URL(options?.dashboardOrigin ?? url.origin).origin;
          const profile =
            dashboardHost === "selfhost"
              ? {
                  id: `selfhost:${new URL(origin).host}`,
                  name: "Self-hosted SelfTune",
                  origin,
                  authentication: "cookie",
                }
              : {
                  id: "local:this-mac",
                  name: "This Mac",
                  origin,
                  authentication: "desktop_local",
                };
          return Response.json(
            { schema_version: 1, host: dashboardHost, profile },
            { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
          );
        }

        const upstreamUrl = spa.upgradeTarget(req, url);
        if (upstreamUrl) {
          if (
            server.upgrade(req, {
              data: { upstreamUrl },
            })
          ) {
            return undefined;
          }
          return new Response("WebSocket upgrade failed", {
            status: 502,
            headers: corsHeaders(),
          });
        }

        // ---- GET /api/v2/events ---- SSE stream for live updates
        if (url.pathname === "/api/v2/events" && req.method === "GET") {
          return eventHub.response();
        }

        const applicationResponse = await operationsRuntime.runPromise(
          handleDashboardApplicationRoute(req, url, {
            allowedOrigins,
            onResourcesChanged: eventHub.broadcastUpdate,
            onSkillSetChanged: () => void runBackgroundRemoteSync(),
          }),
        );
        if (applicationResponse) return applicationResponse;

        const spaResponse = await spa.handlePrimaryRequest(req, url);
        if (spaResponse) return spaResponse;

        const coreResponse = await coreRoutes.handle(req, url, allowedOrigins);
        if (coreResponse) return coreResponse;

        // ---- SPA fallback ----
        const spaFallback = await spa.fallback(req, url);
        if (spaFallback) return spaFallback;

        return new Response("Not Found", {
          status: 404,
          headers: corsHeaders(),
        });
      },
    });
  }
  try {
    server = bindServer();
  } catch (error) {
    await disposeOwnedResources();
    throw error;
  }

  boundPort = server.port ?? port;

  if (openBrowser) {
    const url = `http://${hostname}:${boundPort}`;
    console.log(`selftune dashboard server running at ${url}`);
    try {
      const platform = process.platform;
      if (platform === "darwin") {
        Bun.spawn(["open", url]);
      } else if (platform === "linux") {
        Bun.spawn(["xdg-open", url]);
      } else if (platform === "win32") {
        Bun.spawn(["cmd", "/c", "start", "", url]);
      }
    } catch {
      console.log(`Open manually: ${url}`);
    }
  }

  // Graceful shutdown
  let serverStopped = false;
  const close = async (): Promise<void> => {
    if (serverStopped) return disposeOwnedResources();
    serverStopped = true;
    process.removeListener("SIGINT", shutdownHandler);
    process.removeListener("SIGTERM", shutdownHandler);
    try {
      await server.stop();
    } finally {
      await disposeOwnedResources();
    }
  };
  const shutdownHandler = () => void close();

  if (options?.manageProcessSignals !== false) {
    process.once("SIGINT", shutdownHandler);
    process.once("SIGTERM", shutdownHandler);
  }

  return {
    close,
    server,
    stop: () => void close(),
    port: boundPort,
  };
}

// -- Direct execution (bun run dashboard-server.ts --port XXXX) ---------------
if (import.meta.main) {
  const rawPort = process.argv.find((_, i, a) => a[i - 1] === "--port");
  const parsedPort = rawPort === undefined ? 7888 : Number.parseInt(rawPort, 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 7888;
  const hostname = process.argv.find((_, i, a) => a[i - 1] === "--hostname") ?? "127.0.0.1";
  const authToken =
    process.argv.find((_, i, a) => a[i - 1] === "--auth-token") ?? process.env.SELFTUNE_AUTH_TOKEN;
  const spaDir = process.argv.find((_, i, a) => a[i - 1] === "--spa-dir");
  const runtimeModeArg = process.argv.find((_, i, a) => a[i - 1] === "--runtime-mode");
  const runtimeMode =
    runtimeModeArg === "standalone" || runtimeModeArg === "dev-server" || runtimeModeArg === "test"
      ? runtimeModeArg
      : "dev-server";
  const handle = await startDashboardServer({
    port,
    host: hostname,
    authToken,
    spaDir,
    openBrowser: false,
    runtimeMode,
    spaProxyUrl: process.env.SPA_PROXY_URL,
  });
  if (process.argv.includes("--ready-sentinel")) {
    console.log(`SELFTUNE_READY:${handle.port}`);
  }
}
