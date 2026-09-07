import { Schema } from "effect";

import { InvocationType } from "./evaluation.js";

export const ContributionQuery = Schema.Struct({
  query: Schema.mutableKey(Schema.String),
  invocation_type: Schema.mutableKey(InvocationType),
  source: Schema.mutableKey(Schema.String),
});
export type ContributionQuery = typeof ContributionQuery.Type;

export const ContributionEvalEntry = Schema.Struct({
  query: Schema.mutableKey(Schema.String),
  should_trigger: Schema.mutableKey(Schema.Boolean),
  invocation_type: Schema.mutableKey(Schema.optionalKey(InvocationType)),
});
export type ContributionEvalEntry = typeof ContributionEvalEntry.Type;

export const ContributionGradingSummary = Schema.Struct({
  total_sessions: Schema.mutableKey(Schema.Number),
  graded_sessions: Schema.mutableKey(Schema.Number),
  average_pass_rate: Schema.mutableKey(Schema.Number),
  expectation_count: Schema.mutableKey(Schema.Number),
});
export type ContributionGradingSummary = typeof ContributionGradingSummary.Type;

export const ContributionEvolutionSummary = Schema.Struct({
  total_proposals: Schema.mutableKey(Schema.Number),
  deployed_proposals: Schema.mutableKey(Schema.Number),
  rolled_back_proposals: Schema.mutableKey(Schema.Number),
  average_improvement: Schema.mutableKey(Schema.Number),
});
export type ContributionEvolutionSummary = typeof ContributionEvolutionSummary.Type;

export const ContributionSessionMetrics = Schema.Struct({
  total_sessions: Schema.mutableKey(Schema.Number),
  avg_assistant_turns: Schema.mutableKey(Schema.Number),
  avg_tool_calls: Schema.mutableKey(Schema.Number),
  avg_errors: Schema.mutableKey(Schema.Number),
  top_tools: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          tool: Schema.mutableKey(Schema.String),
          count: Schema.mutableKey(Schema.Number),
        }),
      ),
    ),
  ),
});
export type ContributionSessionMetrics = typeof ContributionSessionMetrics.Type;

const UnmatchedContributionQuery = Schema.Struct({
  query: Schema.mutableKey(Schema.String),
  timestamp: Schema.mutableKey(Schema.String),
});

const PendingContributionProposal = Schema.Struct({
  proposal_id: Schema.mutableKey(Schema.String),
  skill_name: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  action: Schema.mutableKey(Schema.String),
  timestamp: Schema.mutableKey(Schema.String),
  details: Schema.mutableKey(Schema.String),
});

/** The complete portable contribution payload owned by the runtime. */
export const ContributionBundle = Schema.Struct({
  schema_version: Schema.mutableKey(Schema.Literals(["1.0", "1.1", "1.2"])),
  skill_name: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  contributor_id: Schema.mutableKey(Schema.String),
  created_at: Schema.mutableKey(Schema.String),
  selftune_version: Schema.mutableKey(Schema.String),
  agent_type: Schema.mutableKey(Schema.String),
  sanitization_level: Schema.mutableKey(Schema.Literals(["conservative", "aggressive"])),
  positive_queries: Schema.mutableKey(Schema.mutable(Schema.Array(ContributionQuery))),
  eval_entries: Schema.mutableKey(Schema.mutable(Schema.Array(ContributionEvalEntry))),
  grading_summary: Schema.mutableKey(Schema.NullOr(ContributionGradingSummary)),
  evolution_summary: Schema.mutableKey(Schema.NullOr(ContributionEvolutionSummary)),
  session_metrics: Schema.mutableKey(ContributionSessionMetrics),
  unmatched_queries: Schema.mutableKey(
    Schema.optionalKey(Schema.mutable(Schema.Array(UnmatchedContributionQuery))),
  ),
  pending_proposals: Schema.mutableKey(
    Schema.optionalKey(Schema.mutable(Schema.Array(PendingContributionProposal))),
  ),
});
export type ContributionBundle = typeof ContributionBundle.Type;
