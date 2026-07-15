import { dirname, join, resolve } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SELFTUNE_CONFIG_DIR } from "@selftune/runtime/constants";
import type {
  ApplyOnboardingRequest,
  ApplyOnboardingResponse,
  CreateRemoteLibraryShareRequest,
  CreateSkillSetRequest,
  DeriveSkillSetRequest,
  DesktopSettingsResponse,
  DraftInsightRequest,
  ExportSkillSetRequest,
  InsightsResponse,
  LibrarySnapshot,
  PlanSkillSetRequest,
  PortfolioResponse,
  ReviewInsightRequest,
  RollbackSkillSetRequest,
  SkillSetsResponse,
  SkillSourceUpdatePreview,
  SkillSourceUpdateReceipt,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
  UpdateSkillSetRequest,
} from "@selftune/runtime/dashboard-contract";
import { createControlPlaneRuntime } from "@selftune/runtime/control-plane-runtime";
import {
  loadDesktopSettings,
  updateDesktopSchedule,
  updateRemoteLibrarySettings,
} from "@selftune/runtime/desktop-settings";
import { applyDesktopOnboarding } from "@selftune/runtime/desktop-onboarding";
import {
  draftSynthesisCandidate,
  evaluateSynthesisCandidate,
  releaseSynthesisCandidate,
  reviewSynthesisCandidate,
  scanSynthesisCandidates,
} from "@selftune/runtime/synthesis";
import { loadLibraryCatalog } from "@selftune/runtime/library-catalog";
import {
  applySkillSourceUpdate,
  previewSkillSourceUpdate,
  SkillSourceUpdateFailure,
} from "@selftune/runtime/skill-source-update";
import { resolveInstalledSkillMetadata } from "@selftune/runtime/skill-source-metadata";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import { createRemoteLibraryHandle } from "@selftune/runtime/remote-library-runtime";
import {
  diagnoseRemote,
  exportRemoteLibrary,
  previewRemoteLibrarySync,
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "@selftune/runtime/remote-library-sync";
import {
  actOnRemoteLibraryShare,
  createRemoteLibraryShare,
  listRemoteLibraryShares,
} from "@selftune/runtime/remote-library-sharing";
import {
  listQuarantinedSkills,
  loadPortfolioAudit,
  quarantineSkill,
  restoreQuarantinedSkill,
  type PortfolioAuditResult,
} from "@selftune/runtime/skill-portfolio";
import {
  applySkillSet,
  createSkillSet,
  deriveSkillSetFromProject,
  exportPortableSkillSet,
  listSkillSetReceipts,
  listSkillSets,
  planSkillSet,
  rollbackSkillSet,
  updateSkillSet,
} from "@selftune/runtime/skill-sets";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";

export type RemoteLibraryAction = "status" | "sync" | "export" | "restore";
export type RemoteLibraryShareAction = "list" | "create" | "accept" | "import" | "revoke";

export interface DashboardOperationOverrides {
  portfolioLoader?: () => PortfolioAuditResult;
  libraryLoader?: () => LibrarySnapshot | Promise<LibrarySnapshot>;
  skillSetsLoader?: () => SkillSetsResponse | Promise<SkillSetsResponse>;
  sourceUpdatePreviewer?: (
    skillName: string,
  ) => SkillSourceUpdatePreview | Promise<SkillSourceUpdatePreview>;
  sourceUpdateApplier?: (
    skillName: string,
    strategy: "abort" | "take_upstream",
  ) => SkillSourceUpdateReceipt | Promise<SkillSourceUpdateReceipt>;
  insightsLoader?: () => InsightsResponse | Promise<InsightsResponse>;
  insightReviewer?: (input: ReviewInsightRequest) => unknown | Promise<unknown>;
  insightDrafter?: (input: DraftInsightRequest) => unknown | Promise<unknown>;
  insightEvaluator?: (candidateId: string) => unknown | Promise<unknown>;
  insightReleaser?: (candidateId: string) => unknown | Promise<unknown>;
  remoteLibraryAction?: (action: RemoteLibraryAction) => unknown | Promise<unknown>;
  remoteLibraryShareAction?: (
    action: RemoteLibraryShareAction,
    input?: CreateRemoteLibraryShareRequest | { share_id: string },
  ) => unknown | Promise<unknown>;
  settingsLoader?: () => DesktopSettingsResponse;
  settingsUpdater?: (input: UpdateDesktopScheduleRequest) => DesktopSettingsResponse;
  remoteSettingsUpdater?: (input: UpdateRemoteLibraryRequest) => DesktopSettingsResponse;
  onboardingUpdater?: (input: ApplyOnboardingRequest) => ApplyOnboardingResponse;
  skillSetConfigRoot?: string;
  portfolioSearchDirs?: string[];
  quarantineRoot?: string;
}

export class DashboardOperationError extends Schema.TaggedErrorClass<DashboardOperationError>()(
  "DashboardOperationError",
  {
    operation: Schema.String,
    code: Schema.String,
    message: Schema.String,
    status: Schema.Number,
    suggestion: Schema.optional(Schema.String),
    retryable: Schema.Boolean,
  },
) {}

function operationError(operation: string, cause: unknown): DashboardOperationError {
  if (cause instanceof DashboardOperationError) return cause;
  if (cause instanceof SkillSourceUpdateFailure) {
    const status =
      cause.code === "SKILL_NOT_FOUND"
        ? 404
        : cause.code === "LOCAL_CHANGES" || cause.code === "SOURCE_AMBIGUOUS"
          ? 409
          : 400;
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status,
      retryable: false,
    });
  }
  if (cause instanceof CLIError) {
    return DashboardOperationError.make({
      operation,
      code: cause.code,
      message: cause.message,
      status: cause.code === "FILE_NOT_FOUND" ? 404 : cause.code === "GUARD_BLOCKED" ? 409 : 400,
      ...(cause.suggestion ? { suggestion: cause.suggestion } : {}),
      retryable: cause.retryable,
    });
  }
  return DashboardOperationError.make({
    operation,
    code: "INTERNAL_ERROR",
    message: "The local dashboard operation failed.",
    status: 500,
    retryable: false,
  });
}

function attempt<A>(operation: string, run: () => A | PromiseLike<A>) {
  return Effect.tryPromise({
    try: () => Promise.resolve().then(run),
    catch: (cause) => operationError(operation, cause),
  });
}

export class DashboardOperations extends Context.Service<
  DashboardOperations,
  {
    readonly skillSetsWritable: boolean;
    readonly portfolio: Effect.Effect<PortfolioResponse, DashboardOperationError>;
    readonly library: Effect.Effect<LibrarySnapshot, DashboardOperationError>;
    readonly previewSourceUpdate: (
      skillName: string,
    ) => Effect.Effect<SkillSourceUpdatePreview, DashboardOperationError>;
    readonly applySourceUpdate: (
      skillName: string,
      strategy: "abort" | "take_upstream",
    ) => Effect.Effect<SkillSourceUpdateReceipt, DashboardOperationError>;
    readonly insights: Effect.Effect<InsightsResponse, DashboardOperationError>;
    readonly reviewInsight: (
      input: ReviewInsightRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly draftInsight: (
      input: DraftInsightRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly evaluateInsight: (
      candidateId: string,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly releaseInsight: (
      candidateId: string,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly skillSets: Effect.Effect<SkillSetsResponse, DashboardOperationError>;
    readonly createSkillSet: (
      input: CreateSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly updateSkillSet: (
      input: UpdateSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly deriveSkillSet: (
      input: DeriveSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly exportSkillSet: (
      input: ExportSkillSetRequest,
    ) => Effect.Effect<{ output_path: string }, DashboardOperationError>;
    readonly planSkillSet: (
      input: PlanSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly applySkillSet: (
      input: PlanSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly rollbackSkillSet: (
      input: RollbackSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly settings: Effect.Effect<DesktopSettingsResponse, DashboardOperationError>;
    readonly updateSchedule: (
      input: UpdateDesktopScheduleRequest,
    ) => Effect.Effect<DesktopSettingsResponse, DashboardOperationError>;
    readonly updateRemoteSettings: (
      input: UpdateRemoteLibraryRequest,
    ) => Effect.Effect<DesktopSettingsResponse, DashboardOperationError>;
    readonly applyOnboarding: (
      input: ApplyOnboardingRequest,
    ) => Effect.Effect<ApplyOnboardingResponse, DashboardOperationError>;
    readonly previewRemoteLibrary: (
      preferences?: DesktopSettingsResponse["remote_library"]["preferences"],
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly remoteLibrary: (
      action: RemoteLibraryAction,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly remoteLibraryShare: (
      action: RemoteLibraryShareAction,
      input?: CreateRemoteLibraryShareRequest | { share_id: string },
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly quarantine: (input: {
      skillName: string;
      skillPath?: string;
      confirm: boolean;
    }) => Effect.Effect<unknown, DashboardOperationError>;
    readonly restore: (quarantineId: string) => Effect.Effect<unknown, DashboardOperationError>;
  }
>()("@selftune/local/DashboardOperations") {}

export function makeDashboardOperationsLayer(options: DashboardOperationOverrides = {}) {
  return Layer.effect(
    DashboardOperations,
    Effect.gen(function* () {
      const controlPlane = yield* Effect.acquireRelease(
        Effect.sync(createControlPlaneRuntime),
        (runtime) => Effect.promise(() => runtime.dispose()),
      );
      const getPortfolio = options.portfolioLoader ?? loadPortfolioAudit;
      const getSettings = options.settingsLoader ?? loadDesktopSettings;
      const skillSetOptions = options.skillSetConfigRoot
        ? { configRoot: options.skillSetConfigRoot }
        : {};
      let libraryMetadataRefresh: Promise<void> | null = null;
      let nextLibraryMetadataRefreshAt = 0;

      const scheduleLibraryMetadataRefresh = (): void => {
        const now = Date.now();
        if (libraryMetadataRefresh || now < nextLibraryMetadataRefreshAt) return;
        nextLibraryMetadataRefreshAt = now + 6 * 60 * 60 * 1_000;
        libraryMetadataRefresh = Bun.sleep(1_000)
          .then(() =>
            resolveInstalledSkillMetadata(findInstalledSkillPackages(getDefaultSkillSearchDirs())),
          )
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            libraryMetadataRefresh = null;
          });
      };

      const getLibrary =
        options.libraryLoader ??
        (async () => {
          const snapshot = await loadLibraryCatalog(
            {
              skillSetConfigRoot: options.skillSetConfigRoot,
              sourceMetadata: { updateMode: "cache-first" },
            },
            controlPlane,
          );
          scheduleLibraryMetadataRefresh();
          return snapshot;
        });

      const getInsights =
        options.insightsLoader ??
        (async (): Promise<InsightsResponse> => {
          const snapshot = await scanSynthesisCandidates({
            configRoot: options.skillSetConfigRoot,
          });
          const portfolio = getPortfolio().skills.filter(
            (skill) =>
              skill.recommendation === "review_quarantine" ||
              skill.recommendation === "repair_routing" ||
              skill.recommendation === "review_consolidation",
          );
          return {
            snapshot,
            portfolio_reviews: portfolio,
            counts: {
              pending: snapshot.candidates.filter((item) => item.status === "pending").length,
              accepted: snapshot.candidates.filter((item) => item.status === "accepted").length,
              drafted: snapshot.candidates.filter((item) => item.status === "drafted").length,
              snoozed: snapshot.candidates.filter((item) => item.status === "snoozed").length,
              completed: snapshot.candidates.filter((item) =>
                ["rejected", "drafted", "released"].includes(item.status),
              ).length,
              stale_reviews: portfolio.filter((item) => item.recommendation === "review_quarantine")
                .length,
              routing_reviews: portfolio.filter((item) => item.recommendation === "repair_routing")
                .length,
            },
          };
        });

      const runRemoteLibrary =
        options.remoteLibraryAction ??
        (async (action: RemoteLibraryAction) => {
          const configRoot = resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR);
          const config = loadRemoteLibraryConfig(configRoot);
          const handle = createRemoteLibraryHandle({ baseUrl: config.url, apiKey: config.apiKey });
          try {
            if (action === "status") {
              const [capabilities, head, diagnostics] = await Promise.all([
                handle.capabilities(),
                handle.head(),
                diagnoseRemote(handle),
              ]);
              return { url: config.url, capabilities, head, diagnostics };
            }
            if (action === "sync") {
              return syncRemoteLibrary({ handle, configRoot, preferences: config.preferences });
            }
            if (action === "export") {
              return exportRemoteLibrary({
                handle,
                outputPath: join(configRoot, "exports", `library-${Date.now()}.json`),
              });
            }
            return restoreRemoteLibrary({
              handle,
              targetRoot: join(dirname(configRoot), `selftune-library-restore-${Date.now()}`),
            });
          } finally {
            await handle.dispose();
          }
        });

      const runRemoteLibraryShare =
        options.remoteLibraryShareAction ??
        (async (
          action: RemoteLibraryShareAction,
          input?: CreateRemoteLibraryShareRequest | { share_id: string },
        ) => {
          const configRoot = resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR);
          const config = loadRemoteLibraryConfig(configRoot);
          if (action === "list") return listRemoteLibraryShares(config);
          if (action === "create") {
            if (!input || !("recipient_email" in input)) {
              throw new CLIError("Private share details are required.", "MISSING_FLAG");
            }
            return createRemoteLibraryShare(config, input);
          }
          if (!input || !("share_id" in input)) {
            throw new CLIError("Private share ID is required.", "MISSING_FLAG");
          }
          return actOnRemoteLibraryShare(config, input.share_id, action);
        });

      return DashboardOperations.of({
        skillSetsWritable: !options.skillSetsLoader,
        portfolio: attempt("portfolio.load", () => ({
          audit: getPortfolio(),
          quarantined: listQuarantinedSkills(options.quarantineRoot),
        })),
        library: attempt("library.load", getLibrary),
        previewSourceUpdate: (skillName) =>
          attempt("library.source_update.preview", () =>
            (options.sourceUpdatePreviewer ?? previewSkillSourceUpdate)(skillName),
          ),
        applySourceUpdate: (skillName, strategy) =>
          attempt("library.source_update.apply", () =>
            (options.sourceUpdateApplier ?? applySkillSourceUpdate)(skillName, strategy),
          ),
        insights: attempt("insights.load", getInsights),
        reviewInsight: (input) =>
          attempt("insights.review", () =>
            options.insightReviewer
              ? options.insightReviewer(input)
              : reviewSynthesisCandidate(
                  {
                    candidateId: input.candidate_id,
                    action: input.action,
                    reason: input.reason,
                    snoozedUntil: input.snoozed_until,
                    title: input.title,
                    summary: input.summary,
                  },
                  { configRoot: options.skillSetConfigRoot },
                ),
          ),
        draftInsight: (input) =>
          attempt("insights.draft", () =>
            options.insightDrafter
              ? options.insightDrafter(input)
              : draftSynthesisCandidate(input.candidate_id, input.output_dir, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        evaluateInsight: (candidateId) =>
          attempt("insights.evaluate", () =>
            options.insightEvaluator
              ? options.insightEvaluator(candidateId)
              : evaluateSynthesisCandidate(candidateId, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        releaseInsight: (candidateId) =>
          attempt("insights.release", () =>
            options.insightReleaser
              ? options.insightReleaser(candidateId)
              : releaseSynthesisCandidate(candidateId, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        skillSets: attempt("skill_sets.load", () =>
          options.skillSetsLoader
            ? options.skillSetsLoader()
            : {
                sets: listSkillSets(skillSetOptions),
                receipts: listSkillSetReceipts(skillSetOptions),
              },
        ),
        createSkillSet: (input) =>
          attempt("skill_sets.create", () => createSkillSet(input, skillSetOptions)),
        updateSkillSet: (input) =>
          attempt("skill_sets.update", () =>
            updateSkillSet(
              input.set_id,
              {
                name: input.name,
                description: input.description,
                harnesses: input.harnesses,
                skills: input.skills,
                parent_revision_hash: input.parent_revision_hash,
              },
              skillSetOptions,
            ),
          ),
        deriveSkillSet: (input) =>
          attempt("skill_sets.derive", () => deriveSkillSetFromProject(input, skillSetOptions)),
        exportSkillSet: (input) =>
          attempt("skill_sets.export", () => ({
            output_path: exportPortableSkillSet(input.set_id, input.project_root, skillSetOptions),
          })),
        planSkillSet: (input) =>
          attempt("skill_sets.plan", () => planSkillSet(input, skillSetOptions)),
        applySkillSet: (input) =>
          attempt("skill_sets.apply", () => applySkillSet(input, skillSetOptions)),
        rollbackSkillSet: (input) =>
          attempt("skill_sets.rollback", () => rollbackSkillSet(input.receipt_id, skillSetOptions)),
        settings: attempt("settings.load", getSettings),
        updateSchedule: (input) =>
          attempt("settings.schedule", () =>
            (options.settingsUpdater ?? updateDesktopSchedule)(input),
          ),
        updateRemoteSettings: (input) =>
          attempt("settings.remote_library", () =>
            options.remoteSettingsUpdater
              ? options.remoteSettingsUpdater(input)
              : updateRemoteLibrarySettings(input, { configDir: options.skillSetConfigRoot }),
          ),
        applyOnboarding: (input) =>
          attempt("settings.onboarding", () =>
            (options.onboardingUpdater ?? applyDesktopOnboarding)(input),
          ),
        previewRemoteLibrary: (preferences) =>
          attempt("remote_library.preview", () =>
            previewRemoteLibrarySync({
              configRoot: options.skillSetConfigRoot,
              preferences: preferences ?? getSettings().remote_library.preferences,
            }),
          ),
        remoteLibrary: (action) =>
          attempt(`remote_library.${action}`, () => runRemoteLibrary(action)),
        remoteLibraryShare: (action, input) =>
          attempt(`remote_library.share.${action}`, () => runRemoteLibraryShare(action, input)),
        quarantine: (input) =>
          attempt("portfolio.quarantine", () =>
            quarantineSkill({
              installedSkills: findInstalledSkillPackages(
                options.portfolioSearchDirs ?? getDefaultSkillSearchDirs(),
              ),
              skillName: input.skillName,
              skillPath: input.skillPath,
              dryRun: !input.confirm,
              quarantineRoot: options.quarantineRoot,
            }),
          ),
        restore: (quarantineId) =>
          attempt("portfolio.restore", () =>
            restoreQuarantinedSkill({
              quarantineId,
              quarantineRoot: options.quarantineRoot,
            }),
          ),
      });
    }),
  );
}
