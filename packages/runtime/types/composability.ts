import * as Schema from "effect/Schema";

/** A pair of skills that co-occur in sessions. */
export interface CoOccurrencePair {
  skill_a: string;
  skill_b: string;
  co_occurrence_count: number;
  conflict_detected: boolean;
  conflict_reason?: string;
}

/** Report on skill composability / conflicts. */
export interface ComposabilityReport {
  pairs: CoOccurrencePair[];
  total_sessions_analyzed: number;
  conflict_count: number;
  generated_at: string;
}

/** A task from the SkillsBench benchmark suite. */
export interface SkillsBenchTask {
  task_id: string;
  category: string;
  query: string;
  expected_skill?: string;
  expected_tools?: string[];
  difficulty: "easy" | "medium" | "hard";
  tags?: string[];
}

/** Extended pair with synergy detection. */
export interface CoOccurrencePairV2 extends CoOccurrencePair {
  synergy_score: number;
  avg_errors_together: number;
  avg_errors_alone: number;
  workflow_candidate: boolean;
}

/** Ordered skill sequence detected from timestamps. */
export interface SkillSequence {
  skills: string[];
  occurrence_count: number;
  synergy_score: number;
  representative_query: string;
  sequence_consistency: number;
}

/** Extended report with synergy and sequence detection. */
export interface ComposabilityReportV2 extends ComposabilityReport {
  pairs: CoOccurrencePairV2[];
  sequences: SkillSequence[];
  workflow_candidates: CoOccurrencePairV2[];
  synergy_count: number;
}

export interface SkillFamilyOverlapMember {
  skill_name: string;
  skill_path?: string;
  positive_query_count: number;
}

export interface SkillFamilyOverlapPair {
  skill_a: string;
  skill_b: string;
  overlap_pct: number;
  shared_query_count: number;
  shared_queries: string[];
  consolidation_pressure: "low" | "medium" | "high";
}

export interface SkillFamilyColdStartPair {
  skill_a: string;
  skill_b: string;
  description_similarity: number;
  when_to_use_similarity: number;
  shared_command_surfaces: string[];
  shared_terms: string[];
  synthetic_confusion_queries: string[];
  suspicion_level: "low" | "medium" | "high";
}

export interface SkillFamilyColdStartSuspicion {
  candidate: boolean;
  analyzed_pairs: number;
  suspicious_pair_count: number;
  average_static_similarity: number;
  pairs: SkillFamilyColdStartPair[];
  rationale: string[];
}

export interface SkillFamilyRefactorWorkflow {
  workflow_name: string;
  source_skill: string;
  suggested_path: string;
}

export interface SkillFamilyRefactorProposal {
  parent_skill_name: string;
  family_prefix?: string;
  internal_workflows: SkillFamilyRefactorWorkflow[];
  compatibility_aliases: Array<{ skill_name: string; target_workflow: string }>;
  migration_notes: string[];
}

export interface SkillFamilyOverlapReport {
  family_prefix?: string;
  analyzed_skills: string[];
  members: SkillFamilyOverlapMember[];
  pairs: SkillFamilyOverlapPair[];
  cold_start_suspicion?: SkillFamilyColdStartSuspicion;
  total_pairs_analyzed: number;
  overlap_count: number;
  overlap_density: number;
  average_overlap_pct: number;
  consolidation_candidate: boolean;
  recommendation: string;
  rationale: string[];
  refactor_proposal?: SkillFamilyRefactorProposal;
  generated_at: string;
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

export interface CodifiedWorkflow {
  name: string;
  skills: string[];
  description?: string;
  source: "discovered" | "authored";
  discovered_from?: {
    workflow_id: string;
    occurrence_count: number;
    synergy_score: number;
  };
}

export interface WorkflowDiscoveryReport {
  workflows: DiscoveredWorkflow[];
  total_sessions_analyzed: number;
  generated_at: string;
}

/** Provenance trail for a package search run. */
export const PackageSearchProvenance = Schema.Struct({
  frontier_size: Schema.mutableKey(Schema.Number),
  parent_selection_method: Schema.mutableKey(Schema.String),
  candidate_fingerprints: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  surface_plan: Schema.mutableKey(
    Schema.optionalKey(
      Schema.Struct({
        routing_count: Schema.mutableKey(Schema.Number),
        body_count: Schema.mutableKey(Schema.Number),
        weakness_source: Schema.mutableKey(Schema.String),
        routing_weakness: Schema.mutableKey(Schema.NullOr(Schema.Number)),
        body_weakness: Schema.mutableKey(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
  evaluation_summaries: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          candidate_id: Schema.mutableKey(Schema.String),
          decision: Schema.mutableKey(Schema.String),
          rationale: Schema.mutableKey(Schema.String),
        }),
      ),
    ),
  ),
});
export type PackageSearchProvenance = typeof PackageSearchProvenance.Type;

/** Result of a bounded package search run. */
export interface PackageSearchRunResult {
  search_id: string;
  skill_name: string;
  parent_candidate_id: string | null;
  candidates_evaluated: number;
  winner_candidate_id: string | null;
  winner_rationale: string | null;
  started_at: string;
  completed_at: string;
  provenance: PackageSearchProvenance;
}
