import * as Schema from "effect/Schema";
import { CandidateSnapshot } from "@selftune/control-plane";
import type { SkillIntelligenceReport } from "@selftune/skill-intelligence";
import type { PortfolioAuditResult } from "./local-management.js";
import type { InsightsResponse } from "./requests.js";

const SkillIntelligenceCalibrationStatusSchema = Schema.Literals([
  "insufficient_evidence",
  "calibrated",
]);

const SkillIntelligenceCalibrationSchema = Schema.Struct({
  algorithm_version: Schema.String,
  status: SkillIntelligenceCalibrationStatusSchema,
  minimum_labeled_reviews: Schema.Number,
  labeled_reviews: Schema.Number,
  positive_labels: Schema.Number,
  negative_labels: Schema.Number,
  total_reviews: Schema.Number,
  acceptance_rate: Schema.Number,
  exact_acceptance_rate: Schema.Number,
  edit_rate: Schema.Number,
  mean_edit_distance: Schema.NullOr(Schema.Number),
  dismissal_reasons: Schema.Struct({
    accepted_as_suggested: Schema.optionalKey(Schema.Number),
    edited_before_creation: Schema.optionalKey(Schema.Number),
    not_relevant_now: Schema.optionalKey(Schema.Number),
    skills_should_remain_separate: Schema.optionalKey(Schema.Number),
    not_a_real_pattern: Schema.optionalKey(Schema.Number),
    already_have_workflow: Schema.optionalKey(Schema.Number),
    other: Schema.optionalKey(Schema.Number),
  }),
  category_corrections: Schema.Number,
  applied_min_evidence_score: Schema.Number,
  balanced_accuracy: Schema.NullOr(Schema.Number),
});

const SkillCategoryIdSchema = Schema.Literals([
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

const SkillClassificationSourceSchema = Schema.Literals(["inferred", "human"]);

const SkillClassificationSchema = Schema.Struct({
  skill_id: Schema.String,
  skill_name: Schema.String,
  category: SkillCategoryIdSchema,
  inferred_category: SkillCategoryIdSchema,
  category_label: Schema.String,
  source: SkillClassificationSourceSchema,
  confidence: Schema.Number,
  reason: Schema.String,
  override_reason: Schema.NullOr(Schema.String),
  overridden_at: Schema.NullOr(Schema.String),
  matched_terms: Schema.mutable(Schema.Array(Schema.String)),
  observed_queries: Schema.Number,
  co_used_with: Schema.mutable(Schema.Array(Schema.String)),
});

const SkillSetSuggestionPatternSchema = Schema.Literals(["workflow", "co_usage", "project"]);

const SkillSetSuggestionSkillSchema = Schema.Struct({
  name: Schema.String,
  package_path: Schema.String,
  category: SkillCategoryIdSchema,
  role: Schema.String,
  source_id: Schema.NullOr(Schema.String),
  membership_score: Schema.Number,
});

const SkillSetHarnessIdSchema = Schema.Literals([
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
]);

const SkillSetSuggestionEvidenceStateSchema = Schema.Literals([
  "exploratory",
  "supported",
  "validated",
]);

const SkillSetSuggestionSchema = Schema.Struct({
  suggestion_id: Schema.String,
  evidence_fingerprint: Schema.String,
  name: Schema.String,
  description: Schema.String,
  pattern: SkillSetSuggestionPatternSchema,
  skills: Schema.mutable(Schema.Array(SkillSetSuggestionSkillSchema)),
  harnesses: Schema.mutable(Schema.Array(SkillSetHarnessIdSchema)),
  project_root: Schema.NullOr(Schema.String),
  evidence_state: SkillSetSuggestionEvidenceStateSchema,
  confidence: Schema.Number,
  occurrence_count: Schema.Number,
  discovery_occurrence_count: Schema.Number,
  held_out_occurrence_count: Schema.Number,
  support: Schema.Number,
  held_out_support: Schema.NullOr(Schema.Number),
  affinity: Schema.NullOr(Schema.Number),
  held_out_affinity: Schema.NullOr(Schema.Number),
  discovery_edge_coverage: Schema.NullOr(Schema.Number),
  held_out_edge_coverage: Schema.NullOr(Schema.Number),
  sequence_consistency: Schema.NullOr(Schema.Number),
  held_out_sequence_consistency: Schema.NullOr(Schema.Number),
  synergy_score: Schema.NullOr(Schema.Number),
  reason: Schema.String,
});

const CatalogExpansionProfileIdSchema = Schema.Literals([
  "web_full_stack",
  "mobile",
  "high_rigor_review",
]);

const CatalogExpansionCapabilityIdSchema = Schema.Literals([
  "architecture",
  "diagnostics",
  "frontend_components",
  "language",
  "mobile_framework",
  "planning",
  "platform",
  "platform_operations",
  "react_quality",
  "rigorous_review",
  "simulator_tooling",
  "testing",
]);

const CatalogExpansionSkillSchema = Schema.Struct({
  name: Schema.String,
  capability: CatalogExpansionCapabilityIdSchema,
  role: Schema.String,
  why_included: Schema.String,
  provenance: Schema.Literals(["installed", "catalog"]),
  source: Schema.NullOr(Schema.String),
  catalog_id: Schema.NullOr(Schema.String),
  install_spec: Schema.NullOr(Schema.String),
  download_url: Schema.NullOr(Schema.String),
  package_path: Schema.NullOr(Schema.String),
});

const CatalogExpansionHarnessIdSchema = Schema.Literals([
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
]);

const CatalogSkillSetExpansionSchema = Schema.Struct({
  expansion_id: Schema.String,
  profile_id: CatalogExpansionProfileIdSchema,
  name: Schema.String,
  description: Schema.String,
  evidence_state: Schema.Literal("exploratory"),
  evidence_basis: Schema.Literal("project_context_and_catalog"),
  project_root: Schema.NullOr(Schema.String),
  context_score: Schema.Number,
  matched_signal_count: Schema.Number,
  matched_signals: Schema.mutable(Schema.Array(Schema.String)),
  skills: Schema.mutable(Schema.Array(CatalogExpansionSkillSchema)),
  harnesses: Schema.mutable(Schema.Array(CatalogExpansionHarnessIdSchema)),
  reason: Schema.String,
});

const SkillSetOutcomeStatusSchema = Schema.Literals(["improved", "inconclusive", "regressed"]);

const SkillSetOutcomeMetricDirectionSchema = Schema.Literals([
  "improved",
  "regressed",
  "stable",
  "unavailable",
]);

const SkillSetOutcomeMetricSchema = Schema.Struct({
  before: Schema.NullOr(Schema.Number),
  after: Schema.NullOr(Schema.Number),
  delta: Schema.NullOr(Schema.Number),
  direction: SkillSetOutcomeMetricDirectionSchema,
  before_samples: Schema.Number,
  after_samples: Schema.Number,
});

const SkillSetOutcomeMetricsSchema = Schema.Struct({
  completion_quality: SkillSetOutcomeMetricSchema,
  error_rate: SkillSetOutcomeMetricSchema,
  trigger_coverage: SkillSetOutcomeMetricSchema,
  token_cost: SkillSetOutcomeMetricSchema,
  grading: SkillSetOutcomeMetricSchema,
});

const SkillSetOutcomeSchema = Schema.Struct({
  outcome_id: Schema.String,
  review_id: Schema.String,
  receipt_id: Schema.String,
  set_id: Schema.String,
  algorithm_version: Schema.String,
  project_root: Schema.String,
  activated_at: Schema.String,
  measured_at: Schema.String,
  status: SkillSetOutcomeStatusSchema,
  reason: Schema.String,
  causal_claim: Schema.Literal(false),
  minimum_sessions: Schema.Number,
  before_session_count: Schema.Number,
  after_session_count: Schema.Number,
  metrics: SkillSetOutcomeMetricsSchema,
});

const SkillTraceSignalSchema = Schema.Struct({
  skill_name: Schema.String,
  invocation_count: Schema.Number,
  trace_count: Schema.Number,
  error_trace_count: Schema.Number,
  duration_ms: Schema.Number,
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  error_count: Schema.Number,
  tool_call_count: Schema.Number,
});

const SkillExecutionPatternSchema = Schema.Struct({
  pattern_id: Schema.String,
  kind: Schema.Literal("repeated_correlated_errors"),
  skill_id: Schema.String,
  skill_name: Schema.String,
  trace_count: Schema.Number,
  matching_trace_count: Schema.Number,
  ratio: Schema.Number,
  evidence_state: Schema.Literal("supported"),
  causal_claim: Schema.Literal(false),
  reason: Schema.String,
});

export const SkillIntelligenceReportSchema: Schema.Codec<SkillIntelligenceReport> = Schema.Struct({
  algorithm_version: Schema.String,
  evidence_version: Schema.Number,
  generated_at: Schema.String,
  sessions_analyzed: Schema.Number,
  installed_skills: Schema.Number,
  classified_skills: Schema.Number,
  thresholds: Schema.Struct({
    min_occurrences: Schema.Number,
    min_affinity: Schema.Number,
    holdout_ratio: Schema.Number,
    min_validation_occurrences: Schema.Number,
    min_evidence_score: Schema.Number,
  }),
  validation: Schema.Struct({
    ready: Schema.Boolean,
    discovery_sessions: Schema.Number,
    held_out_sessions: Schema.Number,
    cutoff_at: Schema.NullOr(Schema.String),
  }),
  feedback: Schema.Struct({
    classification_overrides: Schema.Number,
    suggestion_reviews: Schema.Struct({
      accepted: Schema.Number,
      edited: Schema.Number,
      dismissed: Schema.Number,
    }),
    calibration: SkillIntelligenceCalibrationSchema,
  }),
  classifications: Schema.mutable(Schema.Array(SkillClassificationSchema)),
  suggestions: Schema.mutable(Schema.Array(SkillSetSuggestionSchema)),
  catalog_expansions: Schema.mutable(Schema.Array(CatalogSkillSetExpansionSchema)),
  outcomes: Schema.mutable(Schema.Array(SkillSetOutcomeSchema)),
  trace_signals: Schema.mutable(Schema.Array(SkillTraceSignalSchema)),
  execution_patterns: Schema.mutable(Schema.Array(SkillExecutionPatternSchema)),
});

const InstalledSkillScopeSchema = Schema.Literals([
  "project",
  "global",
  "admin",
  "system",
  "unknown",
]);

const PortfolioClassificationSchema = Schema.Literals([
  "protected",
  "unobserved",
  "under_observed",
  "routing_problem",
  "active",
  "inactive_candidate",
  "consolidation_candidate",
]);

const PortfolioRecommendationSchema = Schema.Literals([
  "keep",
  "measure",
  "repair_routing",
  "review_consolidation",
  "review_quarantine",
]);

const PortfolioAuditEntrySchema = Schema.Struct({
  skill_name: Schema.String,
  skill_path: Schema.String,
  package_path: Schema.String,
  scope: InstalledSkillScopeSchema,
  classification: PortfolioClassificationSchema,
  recommendation: PortfolioRecommendationSchema,
  reason: Schema.String,
  evidence: Schema.Struct({
    trusted_checks: Schema.Number,
    triggered_count: Schema.Number,
    miss_rate: Schema.NullOr(Schema.Number),
    last_seen_at: Schema.NullOr(Schema.String),
    last_invoked_at: Schema.NullOr(Schema.String),
    sessions_since_invocation: Schema.Number,
    inactive_days: Schema.Number,
    package_modified_at: Schema.String,
  }),
});

export const PortfolioAuditResultSchema: Schema.Codec<PortfolioAuditResult> = Schema.Struct({
  generated_at: Schema.String,
  thresholds: Schema.Struct({
    min_sessions: Schema.Number,
    inactive_days: Schema.Number,
    min_checks: Schema.Number,
    routing_miss_rate: Schema.Number,
  }),
  session_count: Schema.Number,
  installed_count: Schema.Number,
  counts: Schema.Struct({
    protected: Schema.Number,
    unobserved: Schema.Number,
    under_observed: Schema.Number,
    routing_problem: Schema.Number,
    active: Schema.Number,
    inactive_candidate: Schema.Number,
    consolidation_candidate: Schema.Number,
  }),
  skills: Schema.mutable(Schema.Array(PortfolioAuditEntrySchema)),
});

export const InsightsResponseSchema: Schema.Codec<InsightsResponse> = Schema.Struct({
  snapshot: CandidateSnapshot,
  portfolio_reviews: Schema.mutable(Schema.Array(PortfolioAuditEntrySchema)),
  counts: Schema.Struct({
    pending: Schema.Number,
    accepted: Schema.Number,
    drafted: Schema.Number,
    snoozed: Schema.Number,
    completed: Schema.Number,
    stale_reviews: Schema.Number,
    routing_reviews: Schema.Number,
  }),
});
