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
  LibraryShareMode,
  LibraryShareInput,
  LibraryShareReceiptModel,
  LibraryLicenseDraftTerms,
  LibraryLicenseDraftPreviewModel,
  LibraryInstallAgent,
  LibrarySkillInstallReceiptModel,
  LibraryUpdateReceiptModel,
  OverviewModel,
  PluginInventoryModel,
  PluginManagementInputModel,
  PluginManagementReceiptModel,
  ProjectConflictResolutionInput,
  ProjectAssignedSkillSetInstallInput,
  ProjectAssignedSkillSetInstallPreviewModel,
  ProjectAssignedSkillSetInstallReceiptModel,
  ProjectAssignedSkillSetModel,
  ProjectAssignedSkillSetRollbackInput,
  ProjectAssignedSkillSetRollbackReceiptModel,
  ProjectAssignedSkillSetContributionPreviewModel,
  ProjectAssignedSkillSetContributionSendInput,
  ProjectAssignedSkillSetContributionSendReceiptModel,
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
  ProjectSkillSetPluginInstallInput,
  ProjectSkillSetPluginInstallPreviewModel,
  ProjectSkillSetPluginInstallReceiptModel,
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
  TeamCollaborationSnapshotModel,
  TeamRolloutPolicyModel,
} from "../models/index";
import type { ComponentType } from "react";
import type { DashboardFeatureKey, DashboardHostKind } from "./capabilities";

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

export interface DashboardShareCapabilities {
  readonly linkModes: readonly LibraryShareMode[];
  readonly deliveries: readonly ("copy_link" | "email")[];
}

export type DashboardShareAction<TInput, TOutput> = DashboardLibraryAction<TInput, TOutput> & {
  readonly capabilities?: DashboardShareCapabilities;
};

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
  share?: DashboardShareAction<LibraryShareInput, LibraryShareReceiptModel>;
  previewLicenseDraft?: DashboardLibraryAction<
    { skillId: string; skillSetId?: string; terms: LibraryLicenseDraftTerms },
    LibraryLicenseDraftPreviewModel
  >;
  applyLicenseDraft?: DashboardLibraryAction<
    { skillId: string; skillSetId?: string; previewId: string; terms: LibraryLicenseDraftTerms },
    LibraryLicenseDraftPreviewModel
  >;
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
  moveToLibraryMany?: DashboardLibraryAction<
    readonly LibraryArchiveInput[],
    LibraryArchiveBatchResult
  >;
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

export interface DashboardPluginsQueryState {
  data: PluginInventoryModel | null;
  isLoading: boolean;
  error: string | null;
  refresh(): void | Promise<void>;
}

export interface DashboardPluginsActions {
  manage: DashboardLibraryAction<PluginManagementInputModel, PluginManagementReceiptModel>;
}

export type DashboardPluginsContribution =
  | {
      readonly access: "available";
      useInventory(): DashboardPluginsQueryState;
      useActions(): DashboardPluginsActions;
    }
  | { readonly access: "unavailable"; readonly reason: string };

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
    readonly formats?: ReadonlyArray<{
      readonly id: import("../models").ProjectSkillSetExportFormat;
      readonly label: string;
      readonly description: string;
    }>;
  };
  installPlugin?: {
    preview: DashboardProjectsAction<string, ProjectSkillSetPluginInstallPreviewModel>;
    execute: DashboardProjectsAction<
      ProjectSkillSetPluginInstallInput,
      ProjectSkillSetPluginInstallReceiptModel
    >;
  };
  publishRelease?: {
    preview: DashboardProjectsAction<
      import("../models").ProjectSkillSetPublishPreviewInput,
      import("../models").ProjectSkillSetPublishPreviewModel
    >;
    execute: DashboardProjectsAction<
      import("../models").ProjectSkillSetPublishInput,
      import("../models").ProjectSkillSetReleaseReceiptModel
    >;
  };
  share?: DashboardShareAction<ProjectSkillSetShareInput, ProjectSkillSetShareReceiptModel>;
  importPack?: {
    preview: DashboardProjectsAction<string, import("../models").ProjectSkillSetPackPreviewModel>;
    execute: DashboardProjectsAction<
      { packUrl: string; expectedObjectSha256: string },
      ProjectSkillSetModel
    >;
  };
  usePacks?(): import("../models").ProjectSkillSetPacksQueryState;
  revokePack?: DashboardProjectsAction<string, void>;
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

export interface DashboardAssignedSkillSetsQueryState {
  data: readonly ProjectAssignedSkillSetModel[] | null;
  isLoading: boolean;
  error: string | null;
  refresh(): void | Promise<void>;
}

export interface DashboardAssignedSkillSetsActions {
  previewInstall: DashboardProjectsAction<string, ProjectAssignedSkillSetInstallPreviewModel>;
  install: DashboardProjectsAction<
    ProjectAssignedSkillSetInstallInput,
    ProjectAssignedSkillSetInstallReceiptModel
  >;
  rollback: DashboardProjectsAction<
    ProjectAssignedSkillSetRollbackInput,
    ProjectAssignedSkillSetRollbackReceiptModel
  >;
  contribute?: {
    preview: DashboardProjectsAction<string, ProjectAssignedSkillSetContributionPreviewModel>;
    send: DashboardProjectsAction<
      ProjectAssignedSkillSetContributionSendInput,
      ProjectAssignedSkillSetContributionSendReceiptModel
    >;
  };
}

export type DashboardAssignedSkillSetsContribution =
  | {
      readonly access: "available";
      useAssignments(): DashboardAssignedSkillSetsQueryState;
      useActions(): DashboardAssignedSkillSetsActions;
    }
  | { readonly access: "unavailable"; readonly reason: string };

/** The complete host interface needed by the shared Skill Sets journey. */
export interface DashboardSkillSetsModule {
  readonly projects: DashboardProjectsContribution;
  readonly library: DashboardLibraryContribution;
  readonly assignments?: DashboardAssignedSkillSetsContribution;
}

/** The complete host interface needed by the shared Skills Library journey. */
export interface DashboardSkillsModule {
  readonly host: DashboardHostKind;
  readonly library: DashboardLibraryContribution;
  readonly decisions: DashboardDecisionsContribution;
  readonly correctionStudies?: DashboardCorrectionStudiesContribution;
}

/** The complete host interface needed by the shared Plugins journey. */
export interface DashboardPluginsModule {
  readonly plugins?: DashboardPluginsContribution;
}

/** The complete host interface needed by the shared recipient-share journey. */
export interface DashboardRecipientSharesModule {
  readonly recipientShares?: DashboardRecipientSharesContribution;
}

/** The complete host interface needed by the shared team-collaboration journey. */
export interface DashboardTeamCollaborationModule {
  readonly collaboration?: DashboardTeamCollaborationContribution;
}

/** The optional host interface used by the overview watchlist enhancement. */
export interface DashboardOverviewModule {
  readonly mutations: DashboardHostMutations;
}

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

export interface DashboardTeamCollaborationQueryState {
  data: TeamCollaborationSnapshotModel | null;
  isLoading: boolean;
  error: string | null;
  refresh(): void | Promise<void>;
}

export interface DashboardTeamCollaborationActions {
  updateRolloutPolicy: DashboardLibraryAction<
    { entryId: string; policy: TeamRolloutPolicyModel },
    void
  >;
  adoptContribution: DashboardLibraryAction<string, void>;
  rejectContribution: DashboardLibraryAction<string, void>;
  rollbackContribution: DashboardLibraryAction<string, void>;
}

export type DashboardTeamCollaborationContribution =
  | {
      readonly access: "available";
      useSnapshot(): DashboardTeamCollaborationQueryState;
      useActions(): DashboardTeamCollaborationActions;
    }
  | { readonly access: "upgrade"; readonly href: string }
  | { readonly access: "unavailable"; readonly reason: string };
