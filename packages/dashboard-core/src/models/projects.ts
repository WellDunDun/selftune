export type ProjectConnectionId = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export interface ProjectSkillOptionModel {
  id: string;
  name: string;
  packagePath: string;
  contentHash: string;
  lifecycle: string;
  revisionChoices?: ReadonlyArray<{
    contentHash: string;
    packagePath: string;
    sourceKind: "installed" | "cached" | "draft" | "remote" | "archived";
    connection: ProjectConnectionId | null;
    scope: "global" | "project" | "admin" | "system" | "library" | "unknown";
    projectRoot: string | null;
    active: boolean;
    modifiedAt: string;
    lastUsedAt: string | null;
    originLabel: string | null;
  }>;
}

export interface ProjectSkillReferenceModel {
  name: string;
  packagePath: string;
  contentHash: string;
}

export interface ProjectSkillSetModel {
  id: string;
  name: string;
  description: string;
  connections: ProjectConnectionId[];
  skills: ProjectSkillReferenceModel[];
  revision: number;
  revisionHash: string;
  updatedAt: string;
  ownerScope?: "personal" | "workspace";
  ownerName?: string | null;
  workspacePolicy?: {
    action: "allow" | "require_approval" | "block" | "require";
    reason: string | null;
  } | null;
}

export type ProjectPlanAction = "create" | "unchanged" | "conflict";

export interface ProjectPlanOperationModel {
  connection: ProjectConnectionId;
  skillName: string;
  targetPath: string;
  action: ProjectPlanAction;
  reason: string;
}

export interface ProjectPlanModel {
  skillSetId: string;
  skillSetName: string;
  projectRoot: string;
  creates: number;
  unchanged: number;
  conflicts: number;
  missingDependencies: number;
  operations: ProjectPlanOperationModel[];
}

export interface ProjectReceiptModel {
  id: string;
  skillSetId: string;
  skillSetName: string;
  projectRoot: string;
  status: "applying" | "applied" | "unchanged" | "rolled_back";
  operationCount: number;
  dependenciesDownloaded: number;
}

export interface ProjectProvisionInput {
  projectRoot: string;
  skillSetIds: string[];
  harnesses: ProjectConnectionId[];
  createReactProject: boolean;
}

export interface ProjectProvisionPlanModel {
  projectRoot: string;
  skillSetIds: string[];
  creates: number;
  unchanged: number;
  conflicts: number;
  missingDependencies: number;
}

export interface ProjectProvisionResultModel {
  projectRoot: string;
  receiptCount: number;
}

export interface ProjectCaptureCandidateModel {
  projectRoot: string;
  name: string;
  connections: ProjectConnectionId[];
  skillCount: number;
  lastUsedAt: string | null;
}

export interface ProjectHarnessModel {
  id: ProjectConnectionId;
  name: string;
  icon: { src: string; fit: "contain" | "cover"; inset: "none" | "sm" };
}

export interface ProjectsInventoryModel {
  skillSets: ProjectSkillSetModel[];
  availableSkills: ProjectSkillOptionModel[];
  receipts: ProjectReceiptModel[];
  captureCandidates?: ProjectCaptureCandidateModel[];
  connectedHarnesses?: ProjectHarnessModel[];
}

export type ProjectSkillSetSuggestionPattern = "workflow" | "co_usage" | "project";
export type ProjectSkillSetSuggestionEvidenceState = "exploratory" | "supported" | "validated";

export interface ProjectSkillSetSuggestionSkillModel {
  name: string;
  packagePath: string;
  role: string;
  sourceId: string | null;
  membershipScore: number;
}

export interface ProjectSkillSetSuggestionModel {
  id: string;
  evidenceFingerprint: string;
  name: string;
  description: string;
  pattern: ProjectSkillSetSuggestionPattern;
  skills: ProjectSkillSetSuggestionSkillModel[];
  connections: ProjectConnectionId[];
  projectRoot: string | null;
  evidenceState: ProjectSkillSetSuggestionEvidenceState;
  confidence: number;
  discoveryOccurrenceCount: number;
  heldOutOccurrenceCount: number;
  discoveryEdgeCoverage: number | null;
  heldOutEdgeCoverage: number | null;
  reason: string;
}

export interface ProjectCatalogSkillSetExpansionSkillModel {
  name: string;
  capability: string;
  role: string;
  whyIncluded: string;
  provenance: "installed" | "catalog";
  source: string | null;
  catalogId: string | null;
  installSpec: string | null;
  downloadUrl: string | null;
  packagePath: string | null;
}

export interface ProjectCatalogSkillSetExpansionModel {
  id: string;
  profileId: "web_full_stack" | "mobile" | "high_rigor_review";
  name: string;
  description: string;
  evidenceState: "exploratory";
  evidenceBasis: "project_context_and_catalog";
  projectRoot: string | null;
  contextScore: number;
  matchedSignalCount: number;
  matchedSignals: string[];
  skills: ProjectCatalogSkillSetExpansionSkillModel[];
  connections: ProjectConnectionId[];
  reason: string;
}

export type ProjectSkillSetOutcomeStatus = "improved" | "inconclusive" | "regressed";
export type ProjectSkillSetOutcomeMetricId =
  | "completionQuality"
  | "errorRate"
  | "triggerCoverage"
  | "tokenCost"
  | "grading";

export interface ProjectSkillSetOutcomeMetricModel {
  before: number | null;
  after: number | null;
}

export interface ProjectSkillSetOutcomeModel {
  id: string;
  skillSetId: string;
  status: ProjectSkillSetOutcomeStatus;
  reason: string;
  beforeSessionCount: number;
  afterSessionCount: number;
  metrics: Record<ProjectSkillSetOutcomeMetricId, ProjectSkillSetOutcomeMetricModel>;
}

/** Bounded aggregate values derived from correlated local trace spans. */
export interface ProjectSkillTraceSignalModel {
  skillName: string;
  invocationCount: number;
  traceCount: number;
  errorTraceCount: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  errorCount: number;
  toolCallCount: number;
}

/** A supported correlation from trace aggregates; never a causal conclusion. */
export interface ProjectSkillExecutionPatternModel {
  id: string;
  kind: "repeated_correlated_errors";
  skillId: string;
  skillName: string;
  traceCount: number;
  matchingTraceCount: number;
  ratio: number;
  evidenceState: "supported";
  causalClaim: false;
  reason: string;
}

/** Local-only dry-run body proposal; deliberately contains no Cloud identifier. */
export interface ProjectTraceCandidateReviewModel {
  draftId: string | null;
  patternId: string;
  cohortFingerprint: string | null;
  targetRevision: string | null;
  readiness: "review_ready" | "not_ready";
  failureReason: string | null;
  evidence: { cohortEntries: number; resolvedEntries: number };
  candidate: {
    body: string;
    rationale: string;
    changedLines: number;
    targetSection: string;
    uncertainty: string[];
  } | null;
}

export interface ProjectSkillSetIntelligenceModel {
  validation: {
    ready: boolean;
    discoverySessions: number;
    heldOutSessions: number;
  };
  calibration: {
    status: "insufficient_evidence" | "calibrated";
    minimumLabeledReviews: number;
    labeledReviews: number;
    appliedMinEvidenceScore: number;
  };
  suggestions: ProjectSkillSetSuggestionModel[];
  catalogExpansions: ProjectCatalogSkillSetExpansionModel[];
  outcomes: ProjectSkillSetOutcomeModel[];
  traceSignals: ProjectSkillTraceSignalModel[];
  executionPatterns: ProjectSkillExecutionPatternModel[];
}

export type ProjectSkillSetSuggestionReviewReasonCode =
  | "accepted_as_suggested"
  | "edited_before_creation"
  | "not_relevant_now"
  | "skills_should_remain_separate"
  | "not_a_real_pattern"
  | "already_have_workflow"
  | "other";

export interface ProjectSkillSetSuggestionReviewInput {
  suggestionId: string;
  evidenceFingerprint: string;
  decision: "accepted" | "edited" | "dismissed";
  reasonCode: ProjectSkillSetSuggestionReviewReasonCode;
  reason?: string | null;
  resultingSkillSetId?: string | null;
  resultingRevisionHash?: string | null;
  editedFields?: string[];
  result?: {
    name: string;
    description: string;
    connections: ProjectConnectionId[];
    skills: string[];
  };
}

export interface ProjectInstalledSkillSetInput {
  name: string;
  packagePath: string;
  provenance?: "installed";
}

export interface ProjectCatalogSkillSetInput {
  name: string;
  provenance: "catalog";
  catalogId: string;
  source: string;
  installSpec: string;
  downloadUrl?: string | null;
}

export type ProjectSkillSetInputSkill = ProjectInstalledSkillSetInput | ProjectCatalogSkillSetInput;

export interface ProjectSkillSetInput {
  name: string;
  description: string;
  connections: ProjectConnectionId[];
  skills: ProjectSkillSetInputSkill[];
}

export interface ProjectSkillSetUpdateInput extends Omit<ProjectSkillSetInput, "skills"> {
  id: string;
  parentRevisionHash: string;
  skills: ProjectInstalledSkillSetInput[];
}

export interface ProjectSkillSetDeriveInput {
  name?: string;
  description?: string;
  connections?: ProjectConnectionId[];
  projectRoot: string;
}

export interface ProjectSkillSetTargetInput {
  skillSetId: string;
  projectRoot: string;
  policyApproval?: boolean;
}

export interface ProjectSkillSetExportInput {
  skillSetId: string;
  projectRoot?: string;
}

export type ProjectSkillSetShareInput =
  | {
      skillSetId: string;
      mode: "reusable_unlisted" | "private_single_claim";
      delivery: "copy_link";
    }
  | {
      skillSetId: string;
      mode: "private_single_claim";
      delivery: "email";
      recipientEmail: string;
    };

export interface ProjectSkillSetShareReceiptModel {
  shareId: string;
  mode: "reusable_unlisted" | "private_single_claim";
  delivery: "copy_link" | "email";
  shareUrl?: string | null;
  expiresAt: string;
}

export interface ProjectConflictResolutionInput extends ProjectSkillSetTargetInput {
  operation: ProjectPlanOperationModel;
}
