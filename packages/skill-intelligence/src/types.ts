import type { SkillIntelligenceCalibration } from "./calibration.js";
import type {
  SkillCategoryId,
  SkillClassificationOverride,
  SkillClassificationSource,
  SkillSetSuggestionReview,
  SkillSetSuggestionReviewDecision,
} from "./contract.js";
import type { SkillSetOutcome } from "./outcomes.js";
import type {
  CatalogExpansionCatalogEntry,
  CatalogExpansionProjectSignals,
  CatalogSkillSetExpansion,
} from "./catalog-expansion.js";
import type { SkillExecutionPattern, SkillTraceSignal } from "./execution-patterns.js";

export type SkillSetHarnessId = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export interface TrustedSkillObservationRow {
  skill_name: string;
  skill_path: string | null;
  session_id: string;
  occurred_at: string | null;
  triggered: number;
  matched_prompt_id: string | null;
  confidence: number | null;
  invocation_mode: string | null;
  query_text: string;
  /** Stable full-query or source-event identity when query_text is a bounded sample. */
  query_fingerprint?: string;
}

/** Session columns consumed by the skill-intelligence report pipeline. */
export interface SkillIntelligenceSessionRow {
  timestamp: string;
  session_id: string;
  cwd: string;
  errors_encountered: number;
  last_user_query: string;
}

export interface SkillIntelligenceSkillObservationGroup {
  observed_count: number;
  triggered_count: number;
  query_texts: ReadonlyArray<string>;
  skill_paths: ReadonlyMap<string, number>;
  distinct_normalized_query_count: number;
}

export interface SkillIntelligenceTriggeredObservationRow {
  skill_name: string;
  skill_path: string | null;
  session_id: string;
  occurred_at: string | null;
  invocation_mode: string | null;
  query_text: string;
}

export interface SkillIntelligenceObservationGroups {
  bySkillId: ReadonlyMap<string, SkillIntelligenceSkillObservationGroup>;
  triggeredObservations: ReadonlyArray<SkillIntelligenceTriggeredObservationRow>;
  orderedBySession: ReadonlyMap<string, ReadonlyArray<SkillIntelligenceTriggeredObservationRow>>;
  idsBySession: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface SessionTelemetryRecord {
  timestamp: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skills_invoked?: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
  source?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface SkillUsageRecord {
  timestamp: string;
  session_id: string;
  skill_name: string;
  skill_path: string;
  query: string;
  triggered: boolean;
  invocation_type?: "explicit" | "implicit" | "inferred" | "contextual";
}

export interface SkillSetManifest {
  skills: ReadonlyArray<{ name: string }>;
}

export interface InstalledSkillPackage {
  name: string;
  skill_path: string;
  package_path: string;
  registry_dir: string;
  modified_at: string;
  skill_scope: "project" | "global" | "admin" | "system" | "unknown";
  skill_project_root?: string;
  skill_registry_dir?: string;
}

export interface DiscoveredWorkflow {
  workflow_id: string;
  skills: string[];
  occurrence_count: number;
  avg_errors: number;
  avg_errors_individual: number;
  synergy_score: number;
  representative_query: string;
  sequence_consistency: number;
  completion_rate: number;
  first_seen: string;
  last_seen: string;
  session_ids: string[];
}

export interface WorkflowDiscoveryReport {
  workflows: DiscoveredWorkflow[];
  total_sessions_analyzed: number;
  generated_at: string;
}

export interface SkillClassification {
  skill_id: string;
  skill_name: string;
  category: SkillCategoryId;
  inferred_category: SkillCategoryId;
  category_label: string;
  source: SkillClassificationSource;
  confidence: number;
  reason: string;
  override_reason: string | null;
  overridden_at: string | null;
  matched_terms: string[];
  observed_queries: number;
  co_used_with: string[];
}

export type SkillSetSuggestionPattern = "workflow" | "co_usage" | "project";
export type SkillSetSuggestionEvidenceState = "exploratory" | "supported" | "validated";

export interface SkillSetSuggestionSkill {
  name: string;
  package_path: string;
  category: SkillCategoryId;
  role: string;
  source_id: string | null;
  membership_score: number;
}

export interface SkillSetSuggestion {
  suggestion_id: string;
  evidence_fingerprint: string;
  name: string;
  description: string;
  pattern: SkillSetSuggestionPattern;
  skills: SkillSetSuggestionSkill[];
  harnesses: SkillSetHarnessId[];
  project_root: string | null;
  evidence_state: SkillSetSuggestionEvidenceState;
  confidence: number;
  occurrence_count: number;
  discovery_occurrence_count: number;
  held_out_occurrence_count: number;
  support: number;
  held_out_support: number | null;
  affinity: number | null;
  held_out_affinity: number | null;
  discovery_edge_coverage: number | null;
  held_out_edge_coverage: number | null;
  sequence_consistency: number | null;
  held_out_sequence_consistency: number | null;
  synergy_score: number | null;
  reason: string;
}

export interface SkillIntelligenceReport {
  algorithm_version: string;
  evidence_version: number;
  generated_at: string;
  sessions_analyzed: number;
  installed_skills: number;
  classified_skills: number;
  thresholds: {
    min_occurrences: number;
    min_affinity: number;
    holdout_ratio: number;
    min_validation_occurrences: number;
    min_evidence_score: number;
  };
  validation: {
    ready: boolean;
    discovery_sessions: number;
    held_out_sessions: number;
    cutoff_at: string | null;
  };
  feedback: {
    classification_overrides: number;
    suggestion_reviews: Record<SkillSetSuggestionReviewDecision, number>;
    calibration: SkillIntelligenceCalibration;
  };
  classifications: SkillClassification[];
  suggestions: SkillSetSuggestion[];
  catalog_expansions: CatalogSkillSetExpansion[];
  outcomes: SkillSetOutcome[];
  trace_signals: SkillTraceSignal[];
  execution_patterns: SkillExecutionPattern[];
}

export interface SkillIntelligenceInstalledSkill extends InstalledSkillPackage {
  content: string;
  harness: SkillSetHarnessId | null;
  active?: boolean;
  source_id?: string | null;
}

export interface AnalyzeSkillIntelligenceInput {
  installedSkills: ReadonlyArray<SkillIntelligenceInstalledSkill>;
  observations?: ReadonlyArray<TrustedSkillObservationRow>;
  observationGroups?: SkillIntelligenceObservationGroups;
  sessions: ReadonlyArray<SkillIntelligenceSessionRow>;
  existingSets?: ReadonlyArray<SkillSetManifest>;
  classificationOverrides?: ReadonlyArray<SkillClassificationOverride>;
  suggestionReviews?: ReadonlyArray<SkillSetSuggestionReview>;
  minOccurrences?: number;
  minAffinity?: number;
  holdoutRatio?: number;
  minValidationOccurrences?: number;
  minEvidenceScore?: number;
  calibration?: SkillIntelligenceCalibration;
  outcomes?: ReadonlyArray<SkillSetOutcome>;
  maxSuggestions?: number;
  catalogEntries?: ReadonlyArray<CatalogExpansionCatalogEntry>;
  projectSignals?: CatalogExpansionProjectSignals;
  traceSignals?: ReadonlyArray<SkillTraceSignal>;
  now?: Date;
}
