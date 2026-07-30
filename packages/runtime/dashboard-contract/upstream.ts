export type { SkillSetRemoteApplyResult } from "../skill-set-remote-apply.js";
export type { SkillSetManifest, SkillSetPlan, SkillSetReceipt } from "@selftune/library";
export type {
  SkillIntelligenceCalibration,
  SkillIntelligenceCalibrationStatus,
} from "@selftune/skill-intelligence/calibration";
export type {
  SkillCategoryId,
  SkillClassification,
  SkillClassificationOverride,
  SkillClassificationSource,
  SkillIntelligenceReport,
  SkillSetSuggestion,
  SkillSetSuggestionEvidenceState,
  SkillSetSuggestionPattern,
  SkillSetSuggestionReview,
  SkillSetSuggestionReviewDecision,
  SkillSetSuggestionReviewReasonCode,
  SkillSetSuggestionSkill,
} from "@selftune/skill-intelligence";
export type {
  SkillSetOutcome,
  SkillSetOutcomeMetric,
  SkillSetOutcomeMetricDirection,
  SkillSetOutcomeMetrics,
  SkillSetOutcomeStatus,
} from "@selftune/skill-intelligence/outcomes";
export type {
  SetSkillClassificationOverrideInput,
  SkillClassificationOverrideReceipt,
} from "../skill-intelligence/feedback.js";
export type {
  SkillSourceMergePreview,
  SkillSourceUpdatePreview,
  SkillSourceUpdateReceipt,
} from "@selftune/source-management/contracts";
export type {
  SourceMergeDecision,
  SourceMergeDecisionAuditEntry,
  SourceMergeDecisionStatus,
} from "../source-merge-decisions.js";
export type {
  SkillConsolidationDecision,
  SkillConsolidationDecisionAuditEntry,
  SkillConsolidationDecisionStatus,
  SkillConsolidationReceipt,
  SkillConsolidationTarget,
} from "../consolidation-decisions.js";
export type {
  RemovalDecision,
  RemovalDecisionAuditEntry,
  RemovalDecisionLocation,
  RemovalDecisionStatus,
} from "../removal-decisions.js";
export type {
  SkillSetConflictDecision,
  SkillSetConflictDecisionAuditEntry,
  SkillSetConflictDecisionStatus,
  SkillSetConflictImpact,
  SkillSetConflictRecoveryReceipt,
} from "../skill-set-conflict-decisions.js";

export type DurableDashboardDecision =
  | import("../source-merge-decisions.js").SourceMergeDecision
  | import("../removal-decisions.js").RemovalDecision
  | import("../consolidation-decisions.js").SkillConsolidationDecision
  | import("../skill-set-conflict-decisions.js").SkillSetConflictDecision;
