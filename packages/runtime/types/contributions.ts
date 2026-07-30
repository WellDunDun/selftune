import type { InvocationType } from "../types.js";

export interface ContributionQuery {
  query: string;
  invocation_type: InvocationType;
  source: string;
}

export interface ContributionEvalEntry {
  query: string;
  should_trigger: boolean;
  invocation_type?: InvocationType;
}

export interface ContributionGradingSummary {
  total_sessions: number;
  graded_sessions: number;
  average_pass_rate: number;
  expectation_count: number;
}

export interface ContributionEvolutionSummary {
  total_proposals: number;
  deployed_proposals: number;
  rolled_back_proposals: number;
  average_improvement: number;
}

export interface ContributionSessionMetrics {
  total_sessions: number;
  avg_assistant_turns: number;
  avg_tool_calls: number;
  avg_errors: number;
  top_tools: Array<{ tool: string; count: number }>;
}

export interface ContributionBundle {
  schema_version: "1.0" | "1.1" | "1.2";
  skill_name?: string;
  contributor_id: string;
  created_at: string;
  selftune_version: string;
  agent_type: string;
  sanitization_level: "conservative" | "aggressive";
  positive_queries: ContributionQuery[];
  eval_entries: ContributionEvalEntry[];
  grading_summary: ContributionGradingSummary | null;
  evolution_summary: ContributionEvolutionSummary | null;
  session_metrics: ContributionSessionMetrics;
  unmatched_queries?: Array<{ query: string; timestamp: string }>;
  pending_proposals?: Array<{
    proposal_id: string;
    skill_name?: string;
    action: string;
    timestamp: string;
    details: string;
  }>;
}
