import {
  previewSkillSetLicenseDraft,
  applySkillSetLicenseDraft,
} from "@selftune/runtime/skill-set-license-draft";
import { resolve } from "node:path";

import * as Context from "effect/Context";
/* eslint-disable max-lines -- local dashboard operations are a legacy composition boundary */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type {
  PluginInventoryModel,
  PluginManagementInputModel,
  PluginManagementReceiptModel,
  TeamCollaborationSnapshotModel,
  TeamRolloutPolicyModel,
} from "@selftune/dashboard-core/models";
import type {
  HostedSkillSetReleaseReceipt,
  SkillSetDependencyResolutionInput,
  SkillSetPackPreview,
} from "@selftune/control-plane";
import { LocalDatabaseService } from "@selftune/local-store";
import { SELFTUNE_CONFIG_DIR } from "@selftune/runtime/constants";
import {
  applyDesktopOnboarding,
  loadDesktopSettingsWithMigration,
} from "@selftune/orchestration/desktop-onboarding";
import type {
  ApplyOnboardingRequest,
  DesktopBillingCheckoutFinalizeRequest,
  DesktopBillingCheckoutFinalizeResult,
  DesktopBillingCheckoutRequest,
  DesktopBillingSession,
  DesktopBillingStatus,
  ApplyOnboardingResponse,
  ApplySkillSetRequest,
  CreateRemoteLibraryShareRequest,
  CompleteCloudAccountLinkRequest,
  CompleteCloudAccountLinkResponse,
  CreateSkillSetRequest,
  DeriveSkillSetRequest,
  DesktopSettingsResponse,
  DurableDashboardDecision,
  DraftInsightRequest,
  ExportSkillSetRequest,
  InsightsResponse,
  LibrarySnapshot,
  PlanSkillSetRequest,
  PortfolioQuarantineBatchResult,
  PortfolioResponse,
  ReviewInsightRequest,
  ReviewSkillSetSuggestionRequest,
  RollbackSkillSetRequest,
  SkillClassificationOverrideReceipt,
  SkillIntelligenceReport,
  SkillSetsResponse,
  SkillSetSuggestionReview,
  SkillSourceMergePreview,
  SourceMergeDecision,
  StartCloudAccountLinkResponse,
  SkillSourceUpdatePreview,
  SkillSourceUpdateReceipt,
  UpdateDesktopScheduleRequest,
  UpdateRemoteLibraryRequest,
  UpdateSkillClassificationRequest,
  UpdateSkillSetRequest,
} from "@selftune/runtime/dashboard-contract";
import {
  makeNodeInstallerMaterializationFileSystem,
  makeSqliteInstallerExclusiveCommitLock,
  makeSqliteInstallerReceiptAuthority,
} from "@selftune/runtime/installer";
import {
  makeNodeInstallerOsObservationAuthority,
  makeTeamSkillSetAssignmentRuntime,
  type TeamAssignmentInstallChoice,
  type TeamAssignmentInstallInput,
  type TeamAssignmentInstallPreview,
  type TeamAssignmentInstallReceipt,
  type TeamAssignmentListItem,
  type TeamAssignmentRollbackInput,
  type TeamAssignmentRollbackReceipt,
} from "@selftune/runtime/team-assignment";
import {
  makeTeamSkillSetContributionRuntime,
  type TeamContributionPreview,
  type TeamContributionPreviewInput,
} from "@selftune/runtime/team-contribution";
import {
  loadDesktopSettings,
  updateDesktopSchedule,
  updateRemoteLibrarySettings,
} from "@selftune/runtime/desktop-settings";
import {
  draftSynthesisCandidate,
  evaluateSynthesisCandidate,
  releaseSynthesisCandidate,
  reviewSynthesisCandidate,
} from "@selftune/runtime/synthesis";
import {
  applySkillSourceUpdate,
  previewSkillSourceUpdate,
} from "@selftune/runtime/skill-source-update";
import {
  decideSourceMerge,
  getSourceMergeDecision,
  listSourceMergeDecisions,
  prepareSourceMergeDecision,
} from "@selftune/runtime/source-merge-decisions";
import {
  decideRemoval,
  listRemovalDecisions,
  prepareRemovalDecision,
} from "@selftune/runtime/removal-decisions";
import {
  decideSkillConsolidation,
  listSkillConsolidationDecisions,
  prepareSkillConsolidationDecision,
  rollbackSkillConsolidationDecision,
} from "@selftune/runtime/consolidation-decisions";
import {
  decideSkillSetConflict,
  listSkillSetConflictDecisions,
  prepareSkillSetConflictDecision,
  rollbackSkillSetConflictDecision,
} from "@selftune/runtime/skill-set-conflict-decisions";
import { applySkillSetWithRemoteDependencies } from "@selftune/runtime/skill-set-remote-apply";
import {
  applyProjectConfiguration,
  initializeReactProject,
  planProjectConfiguration,
} from "@selftune/runtime/project-provisioning";
import {
  CatalogSkillResolutionProgress,
  createSkillSetWithCatalogResolution,
  type CatalogSkillPackageResolver,
} from "@selftune/runtime/skill-sets/catalog-resolution";
import { makeSkillsShCatalogPackageResolver } from "@selftune/runtime/skill-sets/skills-sh-catalog-resolver";
import {
  reviewSkillSetSuggestion,
  setSkillClassificationOverride,
} from "@selftune/runtime/skill-intelligence/feedback";
import { previewRemoteLibrarySync } from "@selftune/runtime/remote-library-sync";
import {
  applyLicenseDraft as applyLocalLicenseDraft,
  previewLicenseDraft as previewLocalLicenseDraft,
  type LicenseDraftPreview,
  type LicenseDraftTerms,
} from "@selftune/runtime/license-draft";
import {
  listQuarantinedSkills,
  quarantineSkill,
  restoreQuarantinedSkill,
} from "@selftune/runtime/skill-portfolio";
import { quarantinePortfolioBatch } from "@selftune/runtime/skill-portfolio/on-demand-batch";
import {
  createSkillSet,
  captureSkillSetFromProject,
  deleteSkillSet,
  exportPortableSkillSet,
  exportSkillSetPluginArchive,
  listSkillSetReceipts,
  listSkillSets,
  planSkillSet,
  rollbackSkillSet,
  updateSkillSet,
} from "@selftune/library";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";
import { installBackedLibrarySkill } from "@selftune/runtime/remote-library/install-backed-skill";
import type { CreateSkillShareGrantRequest } from "@selftune/library/remote/types";
import {
  localHarnessSettingsEnvironment,
  resolveSourceMergeInvocation,
} from "./harness-registry.js";
import { CloudAccountLinkService, makeCloudAccountLinkLayer } from "./cloud-account-link.js";
import { CloudBillingService, makeCloudBillingLayer } from "./cloud-billing.js";
import {
  HostedStateService,
  makeHostedStateLayer,
  type HostedSkillSetPublishPreview,
  type PublishHostedSkillSetInput,
} from "./hosted-state.js";
import {
  CloudTeamCollaborationService,
  makeCloudTeamCollaborationLayer,
  type TeamCollaborationAccessModel,
  type TeamContributionDecisionResultModel,
  type TeamRolloutPolicyResultModel,
} from "./cloud-team-collaboration.js";
import { makeDashboardLibraryLayer } from "./library-report.js";

import {
  RemoteLibraryService,
  makeRemoteLibraryLayer,
  type RemoteLibraryAction,
  type RemoteLibraryShareAction,
  type RemoteWorkspaceAction,
  type RemoteWorkspaceInput,
} from "./remote-library-operations.js";
import {
  PortfolioAuditCache,
  SkillIntelligenceCache,
  InsightsCache,
  LibraryCache,
  makeDashboardReportCachesLayer,
  type DashboardReportCacheOptions,
} from "./report-caches.js";
import { attempt, DashboardOperationError, operationError } from "./dashboard-operation-errors.js";
import { importSkillSetPack, previewSkillSetPack } from "./skill-set-pack-import.js";
import {
  installSkillSetPlugin,
  previewSkillSetPluginInstall,
  type NativePluginHost,
  type SkillSetPluginInstallPreview,
  type SkillSetPluginInstallReceipt,
} from "./skill-set-plugin-install.js";
import { discoverPluginInventory, managePluginInstallation } from "./plugin-inventory.js";

export { DashboardOperationError } from "./dashboard-operation-errors.js";

export type {
  RemoteLibraryAction,
  RemoteLibraryShareAction,
  RemoteWorkspaceAction,
} from "./remote-library-operations.js";
export type CloudBillingAction = "status" | "checkout" | "portal" | "finalize";
type OverrideResult<A> = A | Promise<A>;
type TeamContributionOperations = ReturnType<typeof makeTeamSkillSetContributionRuntime>;
type TeamContributionSubmitResult = Awaited<ReturnType<TeamContributionOperations["submit"]>>;
type TeamContributionSyncResult = Awaited<ReturnType<TeamContributionOperations["flush"]>>;
type InsightReviewResult = Awaited<ReturnType<typeof reviewSynthesisCandidate>>;
type InsightDraftResult = Awaited<ReturnType<typeof draftSynthesisCandidate>>;
type InsightEvaluationResult = Awaited<ReturnType<typeof evaluateSynthesisCandidate>>;
type InsightReleaseResult = Awaited<ReturnType<typeof releaseSynthesisCandidate>>;
type HostedSyncResult = Awaited<ReturnType<HostedStateService["Service"]["sync"]>>;
type RemoteLibraryResult =
  | Awaited<ReturnType<RemoteLibraryService["Service"]["run"]>>
  | HostedSyncResult
  | { readonly url: string; readonly mode: "privacy_safe_manifest" };
type LibraryBackupResult =
  | Awaited<ReturnType<RemoteLibraryService["Service"]["backupSkill"]>>
  | HostedSyncResult;
type LibraryInstallResult = Awaited<ReturnType<typeof installBackedLibrarySkill>>;
type LibraryShareResult =
  | Awaited<ReturnType<RemoteLibraryService["Service"]["share"]>>
  | Awaited<ReturnType<HostedStateService["Service"]["share"]>>;
export interface DashboardOperationOverrides extends DashboardReportCacheOptions {
  skillClassificationUpdater?: (
    input: UpdateSkillClassificationRequest,
  ) => SkillClassificationOverrideReceipt | Promise<SkillClassificationOverrideReceipt>;
  skillSetSuggestionReviewer?: (
    input: ReviewSkillSetSuggestionRequest,
  ) => SkillSetSuggestionReview | Promise<SkillSetSuggestionReview>;
  skillSetsLoader?: () => SkillSetsResponse | Promise<SkillSetsResponse>;
  pluginInventoryLoader?: () => PluginInventoryModel | Promise<PluginInventoryModel>;
  pluginManager?: (
    input: PluginManagementInputModel,
  ) => PluginManagementReceiptModel | Promise<PluginManagementReceiptModel>;
  skillSetPluginPreviewer?: (
    setId: string,
  ) => SkillSetPluginInstallPreview | Promise<SkillSetPluginInstallPreview>;
  skillSetPluginInstaller?: (input: {
    readonly setId: string;
    readonly expectedRevisionHash: string;
    readonly hosts: ReadonlyArray<NativePluginHost>;
  }) => SkillSetPluginInstallReceipt | Promise<SkillSetPluginInstallReceipt>;
  skillSetPublishPreviewer?: (
    setId: string,
    dependencyResolution: SkillSetDependencyResolutionInput,
  ) => HostedSkillSetPublishPreview | Promise<HostedSkillSetPublishPreview>;
  skillSetPublisher?: (
    input: PublishHostedSkillSetInput,
  ) => HostedSkillSetReleaseReceipt | Promise<HostedSkillSetReleaseReceipt>;
  assignedSkillSetsLoader?: () =>
    | ReadonlyArray<TeamAssignmentListItem>
    | Promise<ReadonlyArray<TeamAssignmentListItem>>;
  assignedSkillSetPreviewer?: (
    input: TeamAssignmentInstallChoice,
  ) => TeamAssignmentInstallPreview | Promise<TeamAssignmentInstallPreview>;
  assignedSkillSetInstaller?: (
    input: TeamAssignmentInstallInput,
  ) => TeamAssignmentInstallReceipt | Promise<TeamAssignmentInstallReceipt>;
  assignedSkillSetRollback?: (
    input: TeamAssignmentRollbackInput,
  ) => TeamAssignmentRollbackReceipt | Promise<TeamAssignmentRollbackReceipt>;
  teamContributionPreviewer?: (
    input: TeamContributionPreviewInput,
  ) => TeamContributionPreview | Promise<TeamContributionPreview>;
  teamContributionSubmitter?: (input: {
    readonly previewToken: string;
    readonly confirmSubmit: boolean;
  }) => OverrideResult<TeamContributionSubmitResult>;
  teamContributionSyncer?: () => OverrideResult<TeamContributionSyncResult>;
  sourceUpdatePreviewer?: (
    skillName: string,
  ) => SkillSourceUpdatePreview | Promise<SkillSourceUpdatePreview>;
  sourceUpdateApplier?: (
    skillName: string,
    strategy: "abort" | "take_upstream",
  ) => SkillSourceUpdateReceipt | Promise<SkillSourceUpdateReceipt>;
  sourceMergePreparer?: (
    skillName: string,
    harnessId: string,
    model: string | null,
  ) => SkillSourceMergePreview | Promise<SkillSourceMergePreview>;
  sourceMergeApplier?: (
    mergeId: string,
  ) => SkillSourceUpdateReceipt | Promise<SkillSourceUpdateReceipt>;
  sourceMergeDecisionLoader?: () => SourceMergeDecision[] | Promise<SourceMergeDecision[]>;
  sourceMergeDecisionDecider?: (
    approvalId: string,
    action: "approve" | "decline",
  ) => SourceMergeDecision | Promise<SourceMergeDecision>;
  durableDecisionLoader?: () => DurableDashboardDecision[] | Promise<DurableDashboardDecision[]>;
  durableDecisionDecider?: (
    approvalId: string,
    action: "approve" | "decline",
  ) => DurableDashboardDecision | Promise<DurableDashboardDecision>;
  insightReviewer?: (input: ReviewInsightRequest) => OverrideResult<InsightReviewResult>;
  insightDrafter?: (input: DraftInsightRequest) => OverrideResult<InsightDraftResult>;
  insightEvaluator?: (candidateId: string) => OverrideResult<InsightEvaluationResult>;
  insightReleaser?: (candidateId: string) => OverrideResult<InsightReleaseResult>;
  remoteLibraryAction?: (action: RemoteLibraryAction) => OverrideResult<RemoteLibraryResult>;
  remoteLibrarySkillBackup?: (skillId: string) => OverrideResult<LibraryBackupResult>;
  remoteLibrarySkillInstall?: (
    skillId: string,
    targetAgent: "codex" | "claude_code" | "opencode" | "openclaw" | "pi",
  ) => OverrideResult<LibraryInstallResult>;
  cloudAccountLinkStarter?: () =>
    | StartCloudAccountLinkResponse
    | Promise<StartCloudAccountLinkResponse>;
  cloudAccountLinkCompleter?: (
    input: CompleteCloudAccountLinkRequest,
  ) => CompleteCloudAccountLinkResponse | Promise<CompleteCloudAccountLinkResponse>;
  cloudBillingAction?: (
    action: CloudBillingAction,
    input?: DesktopBillingCheckoutRequest | DesktopBillingCheckoutFinalizeRequest,
  ) =>
    | DesktopBillingStatus
    | DesktopBillingSession
    | DesktopBillingCheckoutFinalizeResult
    | Promise<DesktopBillingStatus | DesktopBillingSession | DesktopBillingCheckoutFinalizeResult>;
  teamCollaborationAccessLoader?: () =>
    | TeamCollaborationAccessModel
    | Promise<TeamCollaborationAccessModel>;
  teamCollaborationSnapshotLoader?: () =>
    | TeamCollaborationSnapshotModel
    | Promise<TeamCollaborationSnapshotModel>;
  teamCollaborationRolloutPolicyUpdater?: (
    entryId: string,
    policy: TeamRolloutPolicyModel,
  ) => TeamRolloutPolicyResultModel | Promise<TeamRolloutPolicyResultModel>;
  teamCollaborationContributionDecider?: (
    contributionId: string,
    action: "adopt" | "reject" | "rollback",
  ) => TeamContributionDecisionResultModel | Promise<TeamContributionDecisionResultModel>;
  remoteLibraryShareAction?: (
    action: RemoteLibraryShareAction,
    input?: CreateRemoteLibraryShareRequest | CreateSkillShareGrantRequest | { share_id: string },
  ) => OverrideResult<LibraryShareResult>;
  settingsLoader?: () => DesktopSettingsResponse;
  settingsUpdater?: (input: UpdateDesktopScheduleRequest) => DesktopSettingsResponse;
  remoteSettingsUpdater?: (input: UpdateRemoteLibraryRequest) => DesktopSettingsResponse;
  onboardingUpdater?: (
    input: ApplyOnboardingRequest,
  ) => ApplyOnboardingResponse | Promise<ApplyOnboardingResponse>;
  catalogSkillPackageResolver?: CatalogSkillPackageResolver;
  catalogSkillResolutionProgress?: (progress: CatalogSkillResolutionProgress) => void;
}

export { dashboardReportDependencyVersion } from "./report-version.js";

type HeavyReport = "portfolio" | "skillIntelligence" | "insights" | "library";
type ReportInvalidationScope = "all" | "skillIntelligence" | "insights";

export function reportInvalidationTargets(scope: ReportInvalidationScope): readonly HeavyReport[] {
  if (scope === "skillIntelligence") return ["skillIntelligence"];
  if (scope === "insights") return ["insights"];
  return ["portfolio", "skillIntelligence", "insights", "library"];
}
export class DashboardOperations extends Context.Service<
  DashboardOperations,
  {
    readonly skillSetsWritable: boolean;
    readonly portfolio: Effect.Effect<PortfolioResponse, DashboardOperationError>;
    readonly library: Effect.Effect<LibrarySnapshot, DashboardOperationError>;
    readonly skillIntelligence: Effect.Effect<SkillIntelligenceReport, DashboardOperationError>;
    readonly updateSkillClassification: (
      input: UpdateSkillClassificationRequest,
    ) => Effect.Effect<SkillClassificationOverrideReceipt, DashboardOperationError>;
    readonly reviewSkillSetSuggestion: (
      input: ReviewSkillSetSuggestionRequest,
    ) => Effect.Effect<SkillSetSuggestionReview, DashboardOperationError>;
    readonly previewSourceUpdate: (
      skillName: string,
    ) => Effect.Effect<SkillSourceUpdatePreview, DashboardOperationError>;
    readonly applySourceUpdate: (
      skillName: string,
      strategy: "abort" | "take_upstream",
    ) => Effect.Effect<SkillSourceUpdateReceipt, DashboardOperationError>;
    readonly prepareSourceMerge: (
      skillName: string,
      harnessId: string,
      model: string | null,
    ) => Effect.Effect<SkillSourceMergePreview | SourceMergeDecision, DashboardOperationError>;
    readonly sourceMergeDecisions: Effect.Effect<SourceMergeDecision[], DashboardOperationError>;
    readonly sourceMergeDecision: (
      approvalId: string,
    ) => Effect.Effect<SourceMergeDecision, DashboardOperationError>;
    readonly decideSourceMerge: (
      approvalId: string,
      action: "approve" | "decline",
    ) => Effect.Effect<SourceMergeDecision, DashboardOperationError>;
    readonly decisions: Effect.Effect<DurableDashboardDecision[], DashboardOperationError>;
    readonly decision: (
      approvalId: string,
    ) => Effect.Effect<DurableDashboardDecision, DashboardOperationError>;
    readonly prepareRemovalDecision: (input: {
      skillName: string;
      locations: Array<{ skillPath: string; connection: string | null }>;
    }) => Effect.Effect<DurableDashboardDecision, DashboardOperationError>;
    readonly prepareConsolidationDecision: (input: {
      skillName: string;
      canonicalSkillPath: string;
      targetSkillPaths: readonly string[];
    }) => Effect.Effect<DurableDashboardDecision, DashboardOperationError>;
    readonly prepareSkillSetConflictDecision: (
      input: PlanSkillSetRequest,
    ) => Effect.Effect<DurableDashboardDecision, DashboardOperationError>;
    readonly decideDecision: (
      approvalId: string,
      action: "approve" | "decline",
    ) => Effect.Effect<DurableDashboardDecision, DashboardOperationError>;
    readonly rollbackDecision: (
      approvalId: string,
    ) => Effect.Effect<DurableDashboardDecision, DashboardOperationError>;
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
    readonly plugins: Effect.Effect<PluginInventoryModel, DashboardOperationError>;
    readonly managePlugin: (
      input: PluginManagementInputModel,
    ) => Effect.Effect<PluginManagementReceiptModel, DashboardOperationError>;
    readonly createSkillSet: (
      input: CreateSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly updateSkillSet: (
      input: UpdateSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly deleteSkillSet: (
      setId: string,
    ) => Effect.Effect<{ readonly deleted: true }, DashboardOperationError>;
    readonly deriveSkillSet: (
      input: DeriveSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly exportSkillSet: (
      input: ExportSkillSetRequest,
    ) => Effect.Effect<{ output_path: string }, DashboardOperationError>;
    readonly exportSkillSetPlugin: (input: {
      readonly set_id: string;
      readonly target: "claude" | "openai" | "agent-plugins-v1" | "dual" | "all";
    }) => Effect.Effect<
      { readonly filename: string; readonly content_base64: string },
      DashboardOperationError
    >;
    readonly previewSkillSetPluginInstall: (
      setId: string,
    ) => Effect.Effect<SkillSetPluginInstallPreview, DashboardOperationError>;
    readonly installSkillSetPlugin: (input: {
      readonly setId: string;
      readonly expectedRevisionHash: string;
      readonly hosts: ReadonlyArray<NativePluginHost>;
    }) => Effect.Effect<SkillSetPluginInstallReceipt, DashboardOperationError>;
    readonly previewSkillSetPublish: (
      setId: string,
      dependencyResolution: SkillSetDependencyResolutionInput,
    ) => Effect.Effect<HostedSkillSetPublishPreview, DashboardOperationError>;
    readonly publishSkillSet: (
      input: PublishHostedSkillSetInput,
    ) => Effect.Effect<HostedSkillSetReleaseReceipt, DashboardOperationError>;
    readonly assignedSkillSets: Effect.Effect<
      ReadonlyArray<TeamAssignmentListItem>,
      DashboardOperationError
    >;
    readonly previewAssignedSkillSet: (
      input: TeamAssignmentInstallChoice,
    ) => Effect.Effect<TeamAssignmentInstallPreview, DashboardOperationError>;
    readonly installAssignedSkillSet: (
      input: TeamAssignmentInstallInput,
    ) => Effect.Effect<TeamAssignmentInstallReceipt, DashboardOperationError>;
    readonly rollbackAssignedSkillSet: (
      input: TeamAssignmentRollbackInput,
    ) => Effect.Effect<TeamAssignmentRollbackReceipt, DashboardOperationError>;
    readonly previewTeamContribution: (
      input: TeamContributionPreviewInput,
    ) => Effect.Effect<TeamContributionPreview, DashboardOperationError>;
    readonly submitTeamContribution: (input: {
      readonly previewToken: string;
      readonly confirmSubmit: boolean;
    }) => Effect.Effect<unknown, DashboardOperationError>;
    readonly syncTeamContributions: Effect.Effect<unknown, DashboardOperationError>;
    readonly previewSkillSetPack: (
      packUrl: string,
    ) => Effect.Effect<
      { readonly packUrl: string; readonly preview: SkillSetPackPreview },
      DashboardOperationError
    >;
    readonly importSkillSetPack: (input: {
      readonly packUrl: string;
      readonly expectedObjectSha256: string;
    }) => Effect.Effect<
      {
        readonly manifest: import("@selftune/library").SkillSetManifest;
        readonly sourceRevisionSha256: string;
        readonly objectSha256: string;
      },
      DashboardOperationError
    >;
    readonly listSkillSetPacks: () => Effect.Effect<
      import("@selftune/control-plane").SkillSetPackManagementList,
      DashboardOperationError
    >;
    readonly revokeSkillSetPack: (
      packId: string,
    ) => Effect.Effect<
      { readonly packId: string; readonly status: "revoked" },
      DashboardOperationError
    >;
    readonly planSkillSet: (
      input: PlanSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly applySkillSet: (
      input: ApplySkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly previewProjectProvision: (input: {
      project_root: string;
      set_ids: readonly string[];
      harnesses?: readonly string[];
    }) => Effect.Effect<unknown, DashboardOperationError>;
    readonly applyProjectProvision: (input: {
      project_root: string;
      set_ids: readonly string[];
      harnesses?: readonly string[];
      create_react_project: boolean;
    }) => Effect.Effect<unknown, DashboardOperationError>;
    readonly rollbackSkillSet: (
      input: RollbackSkillSetRequest,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly settings: Effect.Effect<DesktopSettingsResponse, DashboardOperationError>;
    readonly startCloudAccountLink: Effect.Effect<
      StartCloudAccountLinkResponse,
      DashboardOperationError
    >;
    readonly completeCloudAccountLink: (
      input: CompleteCloudAccountLinkRequest,
    ) => Effect.Effect<CompleteCloudAccountLinkResponse, DashboardOperationError>;
    readonly cloudBilling: (
      action: CloudBillingAction,
      input?: DesktopBillingCheckoutRequest | DesktopBillingCheckoutFinalizeRequest,
    ) => Effect.Effect<
      DesktopBillingStatus | DesktopBillingSession | DesktopBillingCheckoutFinalizeResult,
      DashboardOperationError
    >;
    readonly teamCollaborationAccess: Effect.Effect<
      TeamCollaborationAccessModel,
      DashboardOperationError
    >;
    readonly teamCollaborationSnapshot: Effect.Effect<
      TeamCollaborationSnapshotModel,
      DashboardOperationError
    >;
    readonly updateTeamCollaborationRolloutPolicy: (
      entryId: string,
      policy: TeamRolloutPolicyModel,
    ) => Effect.Effect<TeamRolloutPolicyResultModel, DashboardOperationError>;
    readonly decideTeamCollaborationContribution: (
      contributionId: string,
      action: "adopt" | "reject" | "rollback",
    ) => Effect.Effect<TeamContributionDecisionResultModel, DashboardOperationError>;
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
    readonly backupLibrarySkill: (
      skillId: string,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly installLibrarySkill: (
      skillId: string,
      targetAgent: "codex" | "claude_code" | "opencode" | "openclaw" | "pi",
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly previewLicenseDraft: (
      skillId: string,
      terms: LicenseDraftTerms,
      skillSetId?: string,
    ) => Effect.Effect<LicenseDraftPreview, DashboardOperationError>;
    readonly applyLicenseDraft: (
      skillId: string,
      previewId: string,
      terms: LicenseDraftTerms,
      skillSetId?: string,
    ) => Effect.Effect<LicenseDraftPreview, DashboardOperationError>;
    readonly remoteLibraryShare: (
      action: RemoteLibraryShareAction,
      input?: CreateRemoteLibraryShareRequest | CreateSkillShareGrantRequest | { share_id: string },
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly workspace: (
      action: RemoteWorkspaceAction,
      input?: RemoteWorkspaceInput,
    ) => Effect.Effect<unknown, DashboardOperationError>;
    readonly quarantine: (input: {
      skillName: string;
      skillPath?: string;
      confirm: boolean;
    }) => Effect.Effect<unknown, DashboardOperationError>;
    readonly quarantineMany: (
      inputs: readonly {
        skillName: string;
        skillPath: string;
        keepSearchable?: boolean;
        expectedContentHash?: string;
      }[],
    ) => Effect.Effect<PortfolioQuarantineBatchResult, DashboardOperationError>;
    readonly restore: (quarantineId: string) => Effect.Effect<unknown, DashboardOperationError>;
  }
>()("@selftune/local/DashboardOperations") {}

export function makeDashboardOperationsLayer(options: DashboardOperationOverrides = {}) {
  const configRoot = resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR);
  const harnessSettings = localHarnessSettingsEnvironment();
  const getSettings = options.settingsLoader ?? (() => loadDesktopSettings(harnessSettings));
  const getMigratedSettings =
    options.settingsLoader ??
    (() =>
      loadDesktopSettingsWithMigration({
        ...harnessSettings,
        configDir: options.skillSetConfigRoot,
      }));
  const libraryLayer = makeDashboardLibraryLayer(options.skillSetConfigRoot, options.libraryLoader);
  const hostedLayer = makeHostedStateLayer(configRoot).pipe(Layer.provideMerge(libraryLayer));
  const accountLinkLayer = makeCloudAccountLinkLayer({
    configRoot,
    loadSettings: getMigratedSettings,
    startOverride: options.cloudAccountLinkStarter,
    completeOverride: options.cloudAccountLinkCompleter,
  }).pipe(Layer.provideMerge(hostedLayer));
  const dependencies = Layer.mergeAll(
    accountLinkLayer,
    makeCloudBillingLayer(configRoot),
    makeCloudTeamCollaborationLayer(configRoot),
    makeRemoteLibraryLayer(configRoot),
    makeDashboardReportCachesLayer(options),
  );
  return Layer.effect(
    DashboardOperations,
    Effect.gen(function* () {
      const localDatabase = yield* Effect.serviceOption(LocalDatabaseService);
      const reportDatabase = Option.getOrUndefined(localDatabase)?.sqlite;
      const portfolioAudit = yield* PortfolioAuditCache;
      const skillIntelligenceReport = yield* SkillIntelligenceCache;
      const insightsReport = yield* InsightsCache;
      const libraryReport = yield* LibraryCache;
      const skillSetOptions = options.skillSetConfigRoot
        ? { configRoot: options.skillSetConfigRoot }
        : {};
      const overrideMergePreviews = new Map<string, SkillSourceMergePreview>();

      const overrideDecision = async (
        approvalId: string,
        action: "approve" | "decline",
      ): Promise<SourceMergeDecision> => {
        const preview = overrideMergePreviews.get(approvalId);
        if (!preview) throw new Error("Source merge decision was not found.");
        const at = new Date().toISOString();
        const receipt =
          action === "approve" && options.sourceMergeApplier
            ? await options.sourceMergeApplier(approvalId)
            : null;
        return {
          schema_version: 1,
          approval_id: approvalId,
          merge_id: approvalId,
          requested_action: "apply_source_merge",
          status: action === "approve" ? "approved" : "declined",
          skill_name: preview.skill_name,
          source: preview.source,
          harness_id: preview.agent,
          agent: preview.agent,
          model: preview.model,
          installed_hash: preview.installed_hash,
          latest_hash: preview.latest_hash,
          upstream_diff: preview.upstream_diff,
          targets: preview.targets.map((target) => ({
            ...target,
            local_fingerprint: "override",
            candidate_fingerprint: "override",
          })),
          created_at: preview.created_at,
          updated_at: at,
          expires_at: at,
          decided_at: at,
          receipt,
          failure: null,
          audit: [
            { event: "prepared", at: preview.created_at, reason: null },
            {
              event: action === "approve" ? "approved" : "declined",
              at,
              reason: "Dashboard operation override.",
            },
          ],
        };
      };

      const reportCaches = {
        portfolio: portfolioAudit,
        skillIntelligence: skillIntelligenceReport,
        insights: insightsReport,
        library: libraryReport,
      };
      const invalidateReports = (scope: ReportInvalidationScope) =>
        Effect.forEach(
          reportInvalidationTargets(scope),
          (report) => reportCaches[report].invalidate,
          {
            discard: true,
          },
        );
      const invalidating = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        scope: ReportInvalidationScope = "all",
      ) => Effect.tap(effect, () => invalidateReports(scope));
      const invalidatingAttempt = <A>(
        operation: string,
        run: () => A | PromiseLike<A>,
        scope: ReportInvalidationScope = "all",
      ) => invalidating(attempt(operation, run), scope);

      const configuredRemoteLibrary = yield* RemoteLibraryService;
      const configuredCloudBilling = yield* CloudBillingService;
      const configuredHostedState = yield* HostedStateService;
      const configuredAssignedSkillSets = reportDatabase
        ? (() => {
            const sqlite = makeSqliteInstallerReceiptAuthority(reportDatabase);
            return makeTeamSkillSetAssignmentRuntime({
              configRoot: options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR,
              hosted: configuredHostedState,
              planning: {
                os: makeNodeInstallerOsObservationAuthority({
                  configDirectory: options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR,
                }),
                receipts: sqlite.planning,
                commitLock: makeSqliteInstallerExclusiveCommitLock(reportDatabase),
              },
              materialization: {
                filesystem: makeNodeInstallerMaterializationFileSystem(),
                receipts: sqlite.durable,
                now: () => new Date().toISOString(),
              },
            });
          })()
        : null;
      const requireAssignedSkillSets = () => {
        if (!configuredAssignedSkillSets)
          throw new Error("The local install receipt database is unavailable.");
        return configuredAssignedSkillSets;
      };
      const configuredTeamContributions = configuredAssignedSkillSets
        ? makeTeamSkillSetContributionRuntime({
            configRoot: options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR,
            loadCurrentAssignment: configuredAssignedSkillSets.contributionContext,
            hosted: configuredHostedState,
          })
        : null;
      const requireTeamContributions = () => {
        if (!configuredTeamContributions)
          throw new Error("The local install receipt database is unavailable.");
        return configuredTeamContributions;
      };
      const requireCloudPublishConnection = async () => {
        if (!(await configuredHostedState.isCloudConnection()))
          throw new Error(
            "Publishing a Skill Set release requires a linked SelfTune Cloud workspace.",
          );
      };
      const configuredTeamCollaboration = yield* CloudTeamCollaborationService;
      const runRemoteLibrary: NonNullable<DashboardOperationOverrides["remoteLibraryAction"]> =
        options.remoteLibraryAction ??
        (async (action) => {
          if (!(await configuredHostedState.isCloudConnection()))
            return configuredRemoteLibrary.run(action);
          if (action === "sync") return configuredHostedState.sync();
          if (action === "status")
            return {
              url: "https://cloud.selftune.dev",
              mode: "privacy_safe_manifest",
            };
          throw new Error(
            "SelfTune Cloud does not store a library backup. Export and restore remain local.",
          );
        });

      const cloudAccountLink = yield* CloudAccountLinkService;

      const runRemoteLibraryShare =
        options.remoteLibraryShareAction ??
        (async (action, input) =>
          action === "create" &&
          input &&
          "mode" in input &&
          (await configuredHostedState.isCloudConnection())
            ? configuredHostedState.share(input)
            : configuredRemoteLibrary.share(action, input));

      return DashboardOperations.of({
        skillSetsWritable: !options.skillSetsLoader,
        portfolio: Effect.flatMap(portfolioAudit.read, (audit) =>
          attempt("portfolio.load", () => ({
            audit,
            quarantined: listQuarantinedSkills(options.quarantineRoot),
          })),
        ),
        library: libraryReport.read,
        skillIntelligence: skillIntelligenceReport.read,
        updateSkillClassification: (input) =>
          invalidatingAttempt(
            "skill_intelligence.classification.update",
            () => (options.skillClassificationUpdater ?? setSkillClassificationOverride)(input),
            "skillIntelligence",
          ),
        reviewSkillSetSuggestion: (input) =>
          invalidatingAttempt(
            "skill_intelligence.suggestion.review",
            () => (options.skillSetSuggestionReviewer ?? reviewSkillSetSuggestion)(input),
            "skillIntelligence",
          ),
        previewSourceUpdate: (skillName) =>
          attempt("library.source_update.preview", () =>
            (options.sourceUpdatePreviewer ?? previewSkillSourceUpdate)(skillName),
          ),
        applySourceUpdate: (skillName, strategy) =>
          invalidatingAttempt("library.source_update.apply", () =>
            (options.sourceUpdateApplier ?? applySkillSourceUpdate)(skillName, strategy),
          ),
        prepareSourceMerge: (skillName, harnessId, model) =>
          attempt("library.source_update.merge.prepare", () => {
            if (options.sourceMergePreparer) {
              return Promise.resolve(options.sourceMergePreparer(skillName, harnessId, model)).then(
                (preview) => {
                  overrideMergePreviews.set(preview.merge_id, preview);
                  return preview;
                },
              );
            }
            const invocation = resolveSourceMergeInvocation(harnessId, model);
            return prepareSourceMergeDecision(
              {
                skillName,
                harnessId,
                agent: invocation.agent,
                model: invocation.model ?? null,
              },
              { configRoot: options.skillSetConfigRoot },
            ).then((result) => result.decision);
          }),
        sourceMergeDecisions: attempt("library.source_update.merge.decisions", () =>
          options.sourceMergeDecisionLoader
            ? options.sourceMergeDecisionLoader()
            : listSourceMergeDecisions({
                configRoot: options.skillSetConfigRoot,
              }),
        ),
        sourceMergeDecision: (approvalId) =>
          attempt("library.source_update.merge.decision", () =>
            options.sourceMergeDecisionLoader
              ? Promise.resolve(options.sourceMergeDecisionLoader()).then((decisions) => {
                  const decision = decisions.find((item) => item.approval_id === approvalId);
                  if (!decision) throw new Error("Source merge decision was not found.");
                  return decision;
                })
              : getSourceMergeDecision(approvalId, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        decideSourceMerge: (approvalId, action) =>
          invalidatingAttempt("library.source_update.merge.decide", () =>
            options.sourceMergeDecisionDecider
              ? options.sourceMergeDecisionDecider(approvalId, action)
              : options.sourceMergeApplier
                ? overrideDecision(approvalId, action)
                : decideSourceMerge(approvalId, action, {
                    configRoot: options.skillSetConfigRoot,
                  }),
          ),
        decisions: attempt("decisions.list", () =>
          options.durableDecisionLoader
            ? options.durableDecisionLoader()
            : [
                ...listSourceMergeDecisions({
                  configRoot: options.skillSetConfigRoot,
                }),
                ...listRemovalDecisions({
                  configRoot: options.skillSetConfigRoot,
                  quarantineRoot: options.quarantineRoot,
                  searchDirs: options.portfolioSearchDirs,
                }),
                ...listSkillConsolidationDecisions({
                  configRoot: options.skillSetConfigRoot,
                  quarantineRoot: options.quarantineRoot,
                  searchDirs: options.portfolioSearchDirs,
                }),
                ...listSkillSetConflictDecisions(skillSetOptions),
              ].toSorted((left, right) => right.updated_at.localeCompare(left.updated_at)),
        ),
        decision: (approvalId) =>
          attempt("decisions.read", async () => {
            const decisions = options.durableDecisionLoader
              ? await options.durableDecisionLoader()
              : [
                  ...listSourceMergeDecisions({
                    configRoot: options.skillSetConfigRoot,
                  }),
                  ...listRemovalDecisions({
                    configRoot: options.skillSetConfigRoot,
                    quarantineRoot: options.quarantineRoot,
                    searchDirs: options.portfolioSearchDirs,
                  }),
                  ...listSkillConsolidationDecisions({
                    configRoot: options.skillSetConfigRoot,
                    quarantineRoot: options.quarantineRoot,
                    searchDirs: options.portfolioSearchDirs,
                  }),
                  ...listSkillSetConflictDecisions(skillSetOptions),
                ];
            const decision = decisions.find((item) => item.approval_id === approvalId);
            if (!decision) throw new Error("Decision was not found.");
            return decision;
          }),
        prepareRemovalDecision: (input) =>
          attempt("decisions.removal.prepare", () =>
            prepareRemovalDecision(input, {
              configRoot: options.skillSetConfigRoot,
              quarantineRoot: options.quarantineRoot,
              searchDirs: options.portfolioSearchDirs,
            }),
          ),
        prepareConsolidationDecision: (input) =>
          attempt("decisions.consolidation.prepare", () =>
            prepareSkillConsolidationDecision(input, {
              configRoot: options.skillSetConfigRoot,
              quarantineRoot: options.quarantineRoot,
              searchDirs: options.portfolioSearchDirs,
            }),
          ),
        prepareSkillSetConflictDecision: (input) =>
          attempt("decisions.skill_set.prepare", () =>
            prepareSkillSetConflictDecision(
              { skillSetId: input.set_id, projectRoot: input.project_root },
              skillSetOptions,
            ),
          ),
        decideDecision: (approvalId, action) =>
          invalidatingAttempt("decisions.decide", async () => {
            if (options.durableDecisionDecider) {
              return options.durableDecisionDecider(approvalId, action);
            }
            if (overrideMergePreviews.has(approvalId)) {
              return overrideDecision(approvalId, action);
            }
            const sourceMergeDecision = listSourceMergeDecisions({
              configRoot: options.skillSetConfigRoot,
            }).find((decision) => decision.approval_id === approvalId);
            if (sourceMergeDecision) {
              return decideSourceMerge(approvalId, action, {
                configRoot: options.skillSetConfigRoot,
              });
            }
            const removalDecision = listRemovalDecisions({
              configRoot: options.skillSetConfigRoot,
              quarantineRoot: options.quarantineRoot,
              searchDirs: options.portfolioSearchDirs,
            }).find((decision) => decision.approval_id === approvalId);
            if (removalDecision) {
              return decideRemoval(approvalId, action, {
                configRoot: options.skillSetConfigRoot,
                quarantineRoot: options.quarantineRoot,
                searchDirs: options.portfolioSearchDirs,
              });
            }
            const consolidationDecision = listSkillConsolidationDecisions({
              configRoot: options.skillSetConfigRoot,
              quarantineRoot: options.quarantineRoot,
              searchDirs: options.portfolioSearchDirs,
            }).find((decision) => decision.approval_id === approvalId);
            if (consolidationDecision) {
              return decideSkillConsolidation(approvalId, action, {
                configRoot: options.skillSetConfigRoot,
                quarantineRoot: options.quarantineRoot,
                searchDirs: options.portfolioSearchDirs,
              });
            }
            const conflictDecision = listSkillSetConflictDecisions(skillSetOptions).find(
              (decision) => decision.approval_id === approvalId,
            );
            if (conflictDecision) {
              return decideSkillSetConflict(approvalId, action, skillSetOptions);
            }
            throw new Error("Decision was not found.");
          }),
        rollbackDecision: (approvalId) =>
          invalidatingAttempt("decisions.rollback", () => {
            const consolidation = listSkillConsolidationDecisions({
              configRoot: options.skillSetConfigRoot,
              quarantineRoot: options.quarantineRoot,
              searchDirs: options.portfolioSearchDirs,
            }).find((decision) => decision.approval_id === approvalId);
            return consolidation
              ? rollbackSkillConsolidationDecision(approvalId, {
                  configRoot: options.skillSetConfigRoot,
                  quarantineRoot: options.quarantineRoot,
                  searchDirs: options.portfolioSearchDirs,
                })
              : rollbackSkillSetConflictDecision(approvalId, skillSetOptions);
          }),
        insights: insightsReport.read,
        reviewInsight: (input) =>
          invalidatingAttempt(
            "insights.review",
            () =>
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
            "insights",
          ),
        draftInsight: (input) =>
          invalidatingAttempt("insights.draft", () =>
            options.insightDrafter
              ? options.insightDrafter(input)
              : draftSynthesisCandidate(input.candidate_id, input.output_dir, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        evaluateInsight: (candidateId) =>
          invalidatingAttempt("insights.evaluate", () =>
            options.insightEvaluator
              ? options.insightEvaluator(candidateId)
              : evaluateSynthesisCandidate(candidateId, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        releaseInsight: (candidateId) =>
          invalidatingAttempt("insights.release", () =>
            options.insightReleaser
              ? options.insightReleaser(candidateId)
              : releaseSynthesisCandidate(candidateId, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        skillSets: attempt("skill_sets.load", () =>
          options.skillSetsLoader
            ? options.skillSetsLoader()
            : configuredRemoteLibrary
                .policies()
                .then(({ policies }) => ({
                  sets: listSkillSets(skillSetOptions),
                  receipts: listSkillSetReceipts(skillSetOptions),
                  workspace_policies: policies,
                }))
                .catch(() => ({
                  sets: listSkillSets(skillSetOptions),
                  receipts: listSkillSetReceipts(skillSetOptions),
                })),
        ),
        plugins: attempt("plugins.load", () =>
          options.pluginInventoryLoader
            ? options.pluginInventoryLoader()
            : discoverPluginInventory({
                configRoot: options.skillSetConfigRoot,
              }),
        ),
        managePlugin: (input) =>
          attempt("plugins.manage", () =>
            options.pluginManager
              ? options.pluginManager(input)
              : managePluginInstallation(input, {
                  configRoot: options.skillSetConfigRoot,
                }),
          ),
        createSkillSet: (input) =>
          createSkillSetWithCatalogResolution(input, {
            resolver:
              options.catalogSkillPackageResolver ??
              makeSkillsShCatalogPackageResolver({
                configRoot: options.skillSetConfigRoot,
              }),
            onProgress: options.catalogSkillResolutionProgress,
            create: (resolved) => createSkillSet(resolved, skillSetOptions),
          }).pipe(
            Effect.mapError((cause) => operationError("skill_sets.create", cause)),
            invalidating,
          ),
        updateSkillSet: (input) =>
          invalidatingAttempt("skill_sets.update", () =>
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
        deleteSkillSet: (setId) =>
          invalidatingAttempt("skill_sets.delete", () => deleteSkillSet(setId, skillSetOptions)),
        deriveSkillSet: (input) =>
          attempt("skill_sets.derive", () => captureSkillSetFromProject(input, skillSetOptions)),
        exportSkillSet: (input) =>
          attempt("skill_sets.export", () => ({
            output_path: exportPortableSkillSet(input.set_id, input.project_root, skillSetOptions),
          })),
        exportSkillSetPlugin: (input) =>
          attempt("skill_sets.plugin_export", () =>
            exportSkillSetPluginArchive(input.set_id, input.target, skillSetOptions),
          ),
        previewSkillSetPluginInstall: (setId) =>
          attempt("skill_sets.plugin_install_preview", () =>
            options.skillSetPluginPreviewer
              ? options.skillSetPluginPreviewer(setId)
              : previewSkillSetPluginInstall(setId, skillSetOptions),
          ),
        installSkillSetPlugin: (input) =>
          attempt("skill_sets.plugin_install", () =>
            options.skillSetPluginInstaller
              ? options.skillSetPluginInstaller(input)
              : installSkillSetPlugin(input, skillSetOptions),
          ),
        previewSkillSetPublish: (setId, dependencyResolution) =>
          attempt("skill_sets.publish_preview", () =>
            options.skillSetPublishPreviewer
              ? options.skillSetPublishPreviewer(setId, dependencyResolution)
              : (async () => {
                  await requireCloudPublishConnection();
                  return configuredHostedState.previewSkillSetPublish(setId, dependencyResolution);
                })(),
          ),
        publishSkillSet: (input) =>
          attempt("skill_sets.publish", () =>
            options.skillSetPublisher
              ? options.skillSetPublisher(input)
              : (async () => {
                  await requireCloudPublishConnection();
                  return configuredHostedState.publishSkillSet(input);
                })(),
          ),
        assignedSkillSets: attempt("skill_sets.assignments.list", () =>
          options.assignedSkillSetsLoader
            ? options.assignedSkillSetsLoader()
            : requireAssignedSkillSets().listAssignments(),
        ),
        previewAssignedSkillSet: (input) =>
          attempt("skill_sets.assignments.preview", () =>
            options.assignedSkillSetPreviewer
              ? options.assignedSkillSetPreviewer(input)
              : requireAssignedSkillSets().previewInstall(input),
          ),
        installAssignedSkillSet: (input) =>
          attempt("skill_sets.assignments.install", () =>
            options.assignedSkillSetInstaller
              ? options.assignedSkillSetInstaller(input)
              : requireAssignedSkillSets().install(input),
          ),
        rollbackAssignedSkillSet: (input) =>
          attempt("skill_sets.assignments.rollback", () =>
            options.assignedSkillSetRollback
              ? options.assignedSkillSetRollback(input)
              : requireAssignedSkillSets().rollback(input),
          ),
        previewTeamContribution: (input) =>
          attempt("skill_sets.contributions.preview", () =>
            options.teamContributionPreviewer
              ? options.teamContributionPreviewer(input)
              : requireTeamContributions().preview(input),
          ),
        submitTeamContribution: (input) =>
          attempt("skill_sets.contributions.submit", () =>
            options.teamContributionSubmitter
              ? options.teamContributionSubmitter(input)
              : requireTeamContributions().submit(input),
          ),
        syncTeamContributions: attempt("skill_sets.contributions.sync", () =>
          options.teamContributionSyncer
            ? options.teamContributionSyncer()
            : requireTeamContributions().flush(),
        ),
        previewSkillSetPack: (packUrl) =>
          attempt("skill_sets.pack_preview", () =>
            previewSkillSetPack(
              packUrl,
              resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR),
            ),
          ),
        importSkillSetPack: (input) =>
          invalidatingAttempt("skill_sets.pack_import", () =>
            importSkillSetPack({
              packUrl: input.packUrl,
              expectedObjectSha256: input.expectedObjectSha256,
              configRoot: resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR),
            }),
          ),
        listSkillSetPacks: () =>
          attempt("skill_sets.packs_list", () => configuredRemoteLibrary.listPacks()),
        revokeSkillSetPack: (packId) =>
          attempt("skill_sets.pack_revoke", () => configuredRemoteLibrary.revokePack(packId)),
        planSkillSet: (input) =>
          attempt("skill_sets.plan", () => planSkillSet(input, skillSetOptions)),
        applySkillSet: (input) =>
          invalidatingAttempt("skill_sets.apply", () =>
            applySkillSetWithRemoteDependencies(input, skillSetOptions),
          ),
        previewProjectProvision: (input) =>
          attempt("skill_sets.project_plan", () =>
            planProjectConfiguration(
              {
                projectRoot: input.project_root,
                skillSetIds: input.set_ids,
                harnesses: input.harnesses,
              },
              skillSetOptions,
            ),
          ),
        applyProjectProvision: (input) =>
          invalidatingAttempt("skill_sets.project_apply", async () => {
            const result = input.create_react_project
              ? await initializeReactProject(
                  {
                    projectRoot: input.project_root,
                    skillSetIds: input.set_ids,
                    harnesses: input.harnesses,
                  },
                  skillSetOptions,
                )
              : await applyProjectConfiguration(
                  {
                    projectRoot: input.project_root,
                    skillSetIds: input.set_ids,
                    harnesses: input.harnesses,
                  },
                  skillSetOptions,
                );
            return {
              project_root: result.plan.projectRoot,
              receipt_count: result.receipts.length,
            };
          }),
        rollbackSkillSet: (input) =>
          invalidatingAttempt("skill_sets.rollback", () =>
            rollbackSkillSet(input.receipt_id, skillSetOptions),
          ),
        settings: attempt("settings.load", getMigratedSettings),
        startCloudAccountLink: attempt("settings.cloud_account.start", cloudAccountLink.start),
        completeCloudAccountLink: (input) =>
          attempt("settings.cloud_account.complete", () => cloudAccountLink.complete(input)),
        cloudBilling: (action, input) =>
          attempt(`settings.billing.${action}`, () => {
            if (options.cloudBillingAction) return options.cloudBillingAction(action, input);
            if (action === "status") return configuredCloudBilling.status();
            if (action === "portal") return configuredCloudBilling.portal();
            if (action === "checkout") {
              if (!input || !("plan" in input)) {
                throw new Error("Billing checkout details are required.");
              }
              return configuredCloudBilling.checkout(input);
            }
            if (!input || !("sessionId" in input)) {
              throw new Error("Checkout session details are required.");
            }
            return configuredCloudBilling.finalize(input);
          }),
        teamCollaborationAccess: attempt("team_collaboration.access", () =>
          options.teamCollaborationAccessLoader
            ? options.teamCollaborationAccessLoader()
            : configuredTeamCollaboration.access(),
        ),
        teamCollaborationSnapshot: attempt("team_collaboration.snapshot", () =>
          options.teamCollaborationSnapshotLoader
            ? options.teamCollaborationSnapshotLoader()
            : configuredTeamCollaboration.snapshot(),
        ),
        updateTeamCollaborationRolloutPolicy: (entryId, policy) =>
          attempt("team_collaboration.rollout_policy.update", () =>
            options.teamCollaborationRolloutPolicyUpdater
              ? options.teamCollaborationRolloutPolicyUpdater(entryId, policy)
              : configuredTeamCollaboration.updateRolloutPolicy(entryId, policy),
          ),
        decideTeamCollaborationContribution: (contributionId, action) =>
          attempt(`team_collaboration.contribution.${action}`, () =>
            options.teamCollaborationContributionDecider
              ? options.teamCollaborationContributionDecider(contributionId, action)
              : configuredTeamCollaboration.decide(contributionId, action),
          ),
        updateSchedule: (input) =>
          attempt("settings.schedule", () =>
            options.settingsUpdater
              ? options.settingsUpdater(input)
              : updateDesktopSchedule(input, harnessSettings),
          ),
        updateRemoteSettings: (input) =>
          attempt("settings.remote_library", () =>
            options.remoteSettingsUpdater
              ? options.remoteSettingsUpdater(input)
              : updateRemoteLibrarySettings(input, {
                  ...harnessSettings,
                  configDir: options.skillSetConfigRoot,
                }),
          ),
        applyOnboarding: (input) =>
          attempt("settings.onboarding", () =>
            options.onboardingUpdater
              ? options.onboardingUpdater(input)
              : applyDesktopOnboarding(input, {
                  ...harnessSettings,
                  configDir: options.skillSetConfigRoot,
                }),
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
        backupLibrarySkill: (skillId) =>
          attempt("remote_library.skill.backup", () =>
            options.remoteLibrarySkillBackup
              ? options.remoteLibrarySkillBackup(skillId)
              : (async () =>
                  (await configuredHostedState.isCloudConnection())
                    ? configuredHostedState.sync()
                    : configuredRemoteLibrary.backupSkill(skillId))(),
          ),
        installLibrarySkill: (skillId, targetAgent) =>
          attempt("remote_library.skill.install", () =>
            options.remoteLibrarySkillInstall
              ? options.remoteLibrarySkillInstall(skillId, targetAgent)
              : installBackedLibrarySkill(
                  { skillId, targetAgent },
                  {
                    configRoot: options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR,
                  },
                ),
          ),
        previewLicenseDraft: (skillId, terms, skillSetId) =>
          skillSetId !== undefined
            ? attempt("library.license.preview", () =>
                previewSkillSetLicenseDraft(skillSetId, skillId, terms, {
                  configRoot: options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR,
                }),
              )
            : Effect.flatMap(libraryReport.read, (snapshot) =>
                attempt("library.license.preview", () => {
                  const skill = snapshot.skills.find((candidate) => candidate.skillId === skillId);
                  const location =
                    skill?.locations.find((candidate) => candidate.active) ?? skill?.locations[0];
                  if (!location)
                    throw new Error("Refresh the Library and select this skill again.");
                  return previewLocalLicenseDraft(location.packagePath, terms);
                }),
              ),
        applyLicenseDraft: (skillId, previewId, terms, skillSetId) =>
          skillSetId !== undefined
            ? invalidatingAttempt("library.license.apply", () =>
                applySkillSetLicenseDraft(skillSetId, skillId, previewId, terms, {
                  configRoot: options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR,
                }),
              )
            : Effect.flatMap(libraryReport.read, (snapshot) =>
                invalidatingAttempt("library.license.apply", () => {
                  const skill = snapshot.skills.find((candidate) => candidate.skillId === skillId);
                  const location =
                    skill?.locations.find((candidate) => candidate.active) ?? skill?.locations[0];
                  if (!location)
                    throw new Error("Refresh the Library and select this skill again.");
                  return applyLocalLicenseDraft({
                    skillPath: location.packagePath,
                    previewId,
                    terms,
                  });
                }),
              ),
        remoteLibraryShare: (action, input) =>
          attempt(`remote_library.share.${action}`, () => runRemoteLibraryShare(action, input)),
        workspace: (action, input) =>
          attempt(`workspace.${action}`, () => configuredRemoteLibrary.workspace(action, input)),
        quarantine: (input) =>
          invalidatingAttempt("portfolio.quarantine", () =>
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
        quarantineMany: (inputs) =>
          invalidatingAttempt("portfolio.quarantine_many", () => {
            const installedSkills = findInstalledSkillPackages(
              options.portfolioSearchDirs ?? getDefaultSkillSearchDirs(),
            );
            return quarantinePortfolioBatch(inputs, {
              installedSkills,
              quarantineRoot: options.quarantineRoot,
              configRoot: options.skillSetConfigRoot,
            });
          }),
        restore: (quarantineId) =>
          invalidatingAttempt("portfolio.restore", () =>
            restoreQuarantinedSkill({
              quarantineId,
              quarantineRoot: options.quarantineRoot,
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(dependencies));
}
