import type {
  LibraryCategoryUpdateInput,
  LibraryArchiveBatchResult,
  LibraryArchiveInput,
  AnalyticsModel,
  DashboardDecisionModel,
  LibraryInventoryModel,
  LibraryMergeModel,
  LibraryMergeConnectionModel,
  LibraryPrepareMergeInput,
  LibrarySourceUpdateModel,
  LibrarySkillBackupReceiptModel,
  LibraryShareInput,
  LibraryShareReceiptModel,
  LibraryInstallAgent,
  LibrarySkillInstallReceiptModel,
  LibraryUpdateReceiptModel,
  OverviewModel,
  ProjectConflictResolutionInput,
  ProjectPlanModel,
  ProjectProvisionInput,
  ProjectProvisionPlanModel,
  ProjectProvisionResultModel,
  ProjectReceiptModel,
  ProjectSkillSetIntelligenceModel,
  ProjectsInventoryModel,
  ProjectSkillSetSuggestionReviewInput,
  ProjectSkillSetDeriveInput,
  ProjectSkillSetExportInput,
  ProjectSkillSetShareInput,
  ProjectSkillSetShareReceiptModel,
  ProjectSkillSetInput,
  ProjectSkillSetModel,
  ProjectSkillSetTargetInput,
  ProjectSkillSetUpdateInput,
  RuntimeHealthModel,
  RecipientDownloadConsentInput,
  RecipientInstallLaunchModel,
  RecipientInstallConsentInput,
  RecipientShareQueryState,
  RecipientShareModel,
  RecipientUseOnceHandoffModel,
  RecipientUseOnceInput,
  SkillsModel,
  CorrectionStudyReviewInput,
  CorrectionStudyReviewModel,
} from "../models/index";
import type { ComponentType } from "react";
import type {
  DashboardFeatureContributions,
  DashboardFeatureKey,
  DashboardHostKind,
  DashboardPlan,
} from "./capabilities";
import type { ServerProfileController } from "./server-profiles";

export interface DashboardUser {
  id?: string;
  name: string;
  email?: string;
  subtitle?: string;
  image?: string | null;
}

export interface DashboardSessionState {
  status: "loading" | "authenticated" | "anonymous";
  user?: DashboardUser;
}

export interface DashboardHostNavigation {
  upgrade: string;
  billing?: string;
  docs?: string;
  cloudDashboard?: string;
  openUpgrade(): void;
}

export interface DashboardHostAuthentication {
  useSession(): DashboardSessionState;
  signOut?(): Promise<void>;
}

export interface DashboardHostMutations {
  getOverviewWatchlist?(): Promise<string[]>;
  updateOverviewWatchlist?(skills: string[]): Promise<string[]>;
}

export interface DashboardHostQueries {
  fetchOverview(): Promise<OverviewModel>;
  fetchSkills(): Promise<SkillsModel>;
  fetchAnalytics(): Promise<AnalyticsModel>;
  fetchRuntimeHealth?(): Promise<RuntimeHealthModel>;
}

export type DashboardCorrectionStudiesContribution =
  | {
      readonly access: "available";
      list(limit?: number): Promise<readonly CorrectionStudyReviewModel[]>;
      recordDecision(
        input: CorrectionStudyReviewInput,
      ): Promise<{ readonly recorded: true; readonly appliesSkill: false }>;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };

export interface DashboardHostPermissions {
  can(feature: DashboardFeatureKey, action: "read" | "mutate"): boolean;
}

export interface DashboardHostLiveEvent {
  resources: readonly string[];
}

export interface DashboardHostLiveUpdates {
  subscribe(listener: (event: DashboardHostLiveEvent) => void): () => void;
}

export interface DashboardLibraryQueryState {
  data: LibraryInventoryModel | null;
  isLoading: boolean;
  error: string | null;
  refresh(): void | Promise<void>;
}

export type DashboardLibraryAction<TInput, TOutput> =
  | {
      readonly access: "available";
      readonly isPending?: boolean;
      readonly error?: string | null;
      execute(input: TInput): Promise<TOutput>;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };

export type DashboardShareDeliveryMethod = "copy_link" | "email";
export type DashboardShareMode = "reusable_unlisted" | "private_single_claim";

export interface DashboardShareActionCapabilities {
  /**
   * Delivery methods this host can execute now. Omitted means the host supports
   * every delivery method represented by the action input for backwards
   * compatibility with existing Desktop adapters.
   */
  readonly supportedDeliveryMethods?: ReadonlyArray<DashboardShareDeliveryMethod>;
  /**
   * Link modes this host can execute now. Omitted preserves the existing
   * Desktop behavior.
   */
  readonly supportedShareModes?: ReadonlyArray<DashboardShareMode>;
}

export interface DashboardLibraryCreateSurfaceProps {
  onChanged(): void | Promise<void>;
}

export type DashboardLibraryCreateSurface =
  | {
      readonly access: "available";
      readonly Component: ComponentType<DashboardLibraryCreateSurfaceProps>;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };

export interface DashboardLibraryActions {
  updateCategory: DashboardLibraryAction<LibraryCategoryUpdateInput, void>;
  openLocation: DashboardLibraryAction<string, void>;
  backup?: DashboardLibraryAction<string, LibrarySkillBackupReceiptModel>;
  share?: DashboardLibraryAction<LibraryShareInput, LibraryShareReceiptModel> &
    DashboardShareActionCapabilities;
  installTargets?: ReadonlyArray<{ id: LibraryInstallAgent; label: string }>;
  install?: DashboardLibraryAction<
    { skillId: string; targetAgent: LibraryInstallAgent },
    LibrarySkillInstallReceiptModel
  >;
  previewSourceUpdate: DashboardLibraryAction<string, LibrarySourceUpdateModel>;
  applySourceUpdate: DashboardLibraryAction<string, LibraryUpdateReceiptModel>;
  mergeConnections: readonly LibraryMergeConnectionModel[];
  prepareMerge: DashboardLibraryAction<LibraryPrepareMergeInput, LibraryMergeModel>;
  applyMerge: DashboardLibraryAction<string, LibraryUpdateReceiptModel>;
  archive: DashboardLibraryAction<LibraryArchiveInput, void>;
  archiveMany?: DashboardLibraryAction<readonly LibraryArchiveInput[], LibraryArchiveBatchResult>;
  consolidate?: DashboardLibraryAction<string, DashboardDecisionModel>;
  remove: DashboardLibraryAction<string, DashboardDecisionModel>;
  decideRemoval: DashboardLibraryAction<
    { decisionId: string; action: "approve" | "decline" },
    DashboardDecisionModel
  >;
  restore: DashboardLibraryAction<string, void>;
  create: DashboardLibraryCreateSurface;
  primary: ReadonlyArray<{ label: string; href: string }>;
}

export type DashboardLibraryContribution =
  | {
      readonly access: "available";
      useInventory(): DashboardLibraryQueryState;
      useActions(): DashboardLibraryActions;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };

export interface DashboardProjectsQueryState {
  data: ProjectsInventoryModel | null;
  isLoading: boolean;
  error: string | null;
  refresh(): void | Promise<void>;
}

export type DashboardProjectsIntelligenceQueryState =
  | {
      readonly access: "available";
      data: ProjectSkillSetIntelligenceModel | null;
      isLoading: boolean;
      error: string | null;
      refresh(): void | Promise<void>;
    }
  | { readonly access: "unavailable"; readonly reason: string };

export type DashboardProjectsAction<TInput, TOutput> = DashboardLibraryAction<TInput, TOutput>;

export interface DashboardProjectsActions {
  create: DashboardProjectsAction<ProjectSkillSetInput, ProjectSkillSetModel>;
  update: DashboardProjectsAction<ProjectSkillSetUpdateInput, ProjectSkillSetModel>;
  derive: DashboardProjectsAction<ProjectSkillSetDeriveInput, ProjectSkillSetModel>;
  export: DashboardProjectsAction<ProjectSkillSetExportInput, { outputPath: string }> & {
    readonly requiresProjectRoot?: boolean;
    readonly label?: string;
  };
  share?: DashboardProjectsAction<ProjectSkillSetShareInput, ProjectSkillSetShareReceiptModel> &
    DashboardShareActionCapabilities;
  useShareRecipients?(): ReadonlyArray<{
    readonly email: string;
    readonly name: string | null;
    readonly avatarUrl?: string | null;
  }>;
  shareWithWorkspace?: DashboardProjectsAction<string, void>;
  shareGatePreview?: { readonly href: string; readonly label: string };
  remove: DashboardProjectsAction<string, void>;
  plan: DashboardProjectsAction<ProjectSkillSetTargetInput, ProjectPlanModel>;
  apply: DashboardProjectsAction<ProjectSkillSetTargetInput, ProjectReceiptModel>;
  provision?: {
    chooseFolder?: () => Promise<string | null>;
    preview: DashboardProjectsAction<ProjectProvisionInput, ProjectProvisionPlanModel>;
    execute: DashboardProjectsAction<ProjectProvisionInput, ProjectProvisionResultModel>;
  };
  resolveConflict: DashboardProjectsAction<ProjectConflictResolutionInput, DashboardDecisionModel>;
  decideConflict: DashboardProjectsAction<
    { decisionId: string; action: "approve" | "decline" },
    DashboardDecisionModel
  >;
  rollbackConflict: DashboardProjectsAction<string, DashboardDecisionModel>;
  rollback: DashboardProjectsAction<string, ProjectReceiptModel>;
  reviewSuggestion: DashboardProjectsAction<ProjectSkillSetSuggestionReviewInput, void>;
  prepareTraceCandidate?: DashboardProjectsAction<
    string,
    import("../models").ProjectTraceCandidateReviewModel
  >;
  traceCandidateTargets?: DashboardProjectsAction<
    string,
    {
      targets: Array<{
        sourceId: string;
        snapshotId: string;
        skillId: string;
        suiteId: string;
        suiteName: string;
        manifestDigest: string;
      }>;
      blockers: Array<{ code: string; message: string }>;
      runId: string | null;
    }
  >;
  submitTraceCandidateTarget?: DashboardProjectsAction<
    {
      draftId: string;
      sourceId: string;
      snapshotId: string;
      skillId: string;
      suiteId: string;
      manifestDigest: string;
    },
    { runId: string }
  >;
}

export type DashboardProjectsContribution =
  | {
      readonly access: "available";
      useInventory(): DashboardProjectsQueryState;
      useIntelligence(): DashboardProjectsIntelligenceQueryState;
      useActions(): DashboardProjectsActions;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };

export type DashboardRecipientAction<TInput, TOutput> =
  | {
      readonly access: "available";
      execute(input: TInput): Promise<TOutput>;
    }
  | { readonly access: "unavailable"; readonly reason: string };

export interface DashboardRecipientShareActions {
  readonly signIn: { readonly access: "available"; readonly href: string };
  readonly claim: DashboardRecipientAction<void, void>;
  readonly acceptLicense: DashboardRecipientAction<void, void>;
  readonly importToLibrary: DashboardRecipientAction<void, void>;
  readonly download: DashboardRecipientAction<RecipientDownloadConsentInput, void>;
  readonly useOnce: DashboardRecipientAction<RecipientUseOnceInput, RecipientUseOnceHandoffModel>;
  readonly installWithSelfTune: DashboardRecipientAction<
    RecipientInstallConsentInput,
    RecipientInstallLaunchModel
  >;
}

export type DashboardRecipientSharesContribution =
  | {
      readonly access: "available";
      useShare(): RecipientShareQueryState;
      useActions(share: RecipientShareModel | null): DashboardRecipientShareActions;
      openDesktopDeepLink(deepLink: `selftune://${string}`): void;
    }
  | { readonly access: "unavailable"; readonly reason: string };

export interface DashboardDecisionsQueryState {
  data: DashboardDecisionModel[] | null;
  isLoading: boolean;
  error: string | null;
  refresh(): void | Promise<void>;
}

export interface DashboardDecisionsActions {
  decide: DashboardLibraryAction<
    { decisionId: string; action: "approve" | "decline" },
    DashboardDecisionModel
  >;
  rollback: DashboardLibraryAction<string, DashboardDecisionModel>;
}

export type DashboardDecisionsContribution =
  | {
      readonly access: "available";
      useDecisions(): DashboardDecisionsQueryState;
      useActions(): DashboardDecisionsActions;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };

export interface DashboardHostAdapter {
  host: DashboardHostKind;
  plan: DashboardPlan;
  features: DashboardFeatureContributions;
  authentication: DashboardHostAuthentication;
  queries: DashboardHostQueries;
  navigation: DashboardHostNavigation;
  mutations: DashboardHostMutations;
  permissions: DashboardHostPermissions;
  liveUpdates?: DashboardHostLiveUpdates;
  library: DashboardLibraryContribution;
  projects: DashboardProjectsContribution;
  decisions: DashboardDecisionsContribution;
  /** Hosts without a local correction-study store expose this as unavailable. */
  correctionStudies?: DashboardCorrectionStudiesContribution;
  /** Optional during host migration; the shared route fails closed when absent. */
  recipientShares?: DashboardRecipientSharesContribution;
  profiles?: ServerProfileController;
}
