import { Schema } from "effect";

export const InvocationType = Schema.Union([
  Schema.Literal("explicit"),
  Schema.Literal("implicit"),
  Schema.Literal("contextual"),
  Schema.Literal("negative"),
]);
export type InvocationType = typeof InvocationType.Type;

export const EvalEntry = Schema.Struct({
  query: Schema.mutableKey(Schema.String),

  should_trigger: Schema.mutableKey(Schema.Boolean),

  invocation_type: Schema.mutableKey(Schema.optionalKey(InvocationType)),
  /** Provenance: where this eval entry originated */
  source: Schema.mutableKey(
    Schema.optionalKey(
      Schema.Union([Schema.Literal("synthetic"), Schema.Literal("log"), Schema.Literal("blended")]),
    ),
  ),
  /** ISO timestamp when this eval entry was created */
  created_at: Schema.mutableKey(Schema.optionalKey(Schema.String)),
});
export type EvalEntry = typeof EvalEntry.Type;

export const AssertionType = Schema.Union([
  Schema.Literal("contains"),
  Schema.Literal("not_contains"),
  Schema.Literal("regex"),
  Schema.Literal("json_path"),
  Schema.Literal("tool_called"),
  Schema.Literal("tool_not_called"),
]);
export type AssertionType = typeof AssertionType.Type;

export const SkillAssertion = Schema.Struct({
  type: Schema.mutableKey(AssertionType),

  value: Schema.mutableKey(Schema.String),

  description: Schema.mutableKey(Schema.optionalKey(Schema.String)),
});
export type SkillAssertion = typeof SkillAssertion.Type;

export const SkillUnitTest = Schema.Struct({
  id: Schema.mutableKey(Schema.String),

  skill_name: Schema.mutableKey(Schema.String),

  query: Schema.mutableKey(Schema.String),

  assertions: Schema.mutableKey(Schema.mutable(Schema.Array(SkillAssertion))),

  timeout_ms: Schema.mutableKey(Schema.optionalKey(Schema.Number)),

  tags: Schema.mutableKey(Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)))),
});
export type SkillUnitTest = typeof SkillUnitTest.Type;

export const UnitTestResult = Schema.Struct({
  test_id: Schema.mutableKey(Schema.String),

  passed: Schema.mutableKey(Schema.Boolean),

  assertion_results: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          assertion: Schema.mutableKey(SkillAssertion),

          passed: Schema.mutableKey(Schema.Boolean),

          actual: Schema.mutableKey(Schema.optionalKey(Schema.String)),
        }),
      ),
    ),
  ),

  duration_ms: Schema.mutableKey(Schema.Number),

  error: Schema.mutableKey(Schema.optionalKey(Schema.String)),
});
export type UnitTestResult = typeof UnitTestResult.Type;

export const UnitTestSuiteResult = Schema.Struct({
  skill_name: Schema.mutableKey(Schema.String),

  total: Schema.mutableKey(Schema.Number),

  passed: Schema.mutableKey(Schema.Number),

  failed: Schema.mutableKey(Schema.Number),

  pass_rate: Schema.mutableKey(Schema.Number),

  results: Schema.mutableKey(Schema.mutable(Schema.Array(UnitTestResult))),

  run_at: Schema.mutableKey(Schema.String),
});
export type UnitTestSuiteResult = typeof UnitTestSuiteResult.Type;

export const ReplayStagingMode = Schema.Union([
  Schema.Literal("routing"),
  Schema.Literal("package"),
]);
export type ReplayStagingMode = typeof ReplayStagingMode.Type;

export const CreatePackageEvaluationSource = Schema.Union([
  Schema.Literal("fresh"),
  Schema.Literal("artifact_cache"),
  Schema.Literal("candidate_cache"),
]);
export type CreatePackageEvaluationSource = typeof CreatePackageEvaluationSource.Type;

export const CreatePackageEvaluationStatus = Schema.Union([
  Schema.Literal("passed"),
  Schema.Literal("replay_failed"),
  Schema.Literal("baseline_failed"),
]);
export type CreatePackageEvaluationStatus = typeof CreatePackageEvaluationStatus.Type;

export const RuntimeReplayAggregateMetrics = Schema.Struct({
  eval_runs: Schema.mutableKey(Schema.Number),

  usage_observations: Schema.mutableKey(Schema.Number),

  total_duration_ms: Schema.mutableKey(Schema.Number),

  avg_duration_ms: Schema.mutableKey(Schema.Number),

  total_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  total_output_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  total_cache_creation_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  total_cache_read_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  total_cost_usd: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  total_turns: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),
});
export type RuntimeReplayAggregateMetrics = typeof RuntimeReplayAggregateMetrics.Type;

export const CreatePackageReplaySummary = Schema.Struct({
  mode: Schema.mutableKey(ReplayStagingMode),

  validation_mode: Schema.mutableKey(Schema.Literal("host_replay")),

  agent: Schema.mutableKey(Schema.String),

  proposal_id: Schema.mutableKey(Schema.String),

  fixture_id: Schema.mutableKey(Schema.String),

  total: Schema.mutableKey(Schema.Number),

  passed: Schema.mutableKey(Schema.Number),

  failed: Schema.mutableKey(Schema.Number),

  pass_rate: Schema.mutableKey(Schema.Number),

  runtime_metrics: Schema.mutableKey(Schema.optionalKey(RuntimeReplayAggregateMetrics)),
});
export type CreatePackageReplaySummary = typeof CreatePackageReplaySummary.Type;

export const CreatePackageBaselineSummary = Schema.Struct({
  mode: Schema.mutableKey(ReplayStagingMode),

  baseline_pass_rate: Schema.mutableKey(Schema.Number),

  with_skill_pass_rate: Schema.mutableKey(Schema.Number),

  lift: Schema.mutableKey(Schema.Number),

  adds_value: Schema.mutableKey(Schema.Boolean),

  measured_at: Schema.mutableKey(Schema.String),

  sample_size: Schema.mutableKey(Schema.optionalKey(Schema.Number)),

  runtime_metrics: Schema.mutableKey(
    Schema.optionalKey(
      Schema.Struct({
        with_skill: Schema.mutableKey(RuntimeReplayAggregateMetrics),

        without_skill: Schema.mutableKey(RuntimeReplayAggregateMetrics),
      }),
    ),
  ),
});
export type CreatePackageBaselineSummary = typeof CreatePackageBaselineSummary.Type;

export const CreatePackageEvaluationEvidenceSample = Schema.Struct({
  query: Schema.mutableKey(Schema.String),

  evidence: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),
});
export type CreatePackageEvaluationEvidenceSample =
  typeof CreatePackageEvaluationEvidenceSample.Type;

export const CreatePackageEvaluationEvidenceSummary = Schema.Struct({
  replay_failures: Schema.mutableKey(Schema.Number),

  baseline_wins: Schema.mutableKey(Schema.Number),

  baseline_regressions: Schema.mutableKey(Schema.Number),

  replay_failure_samples: Schema.mutableKey(
    Schema.mutable(Schema.Array(CreatePackageEvaluationEvidenceSample)),
  ),

  baseline_win_samples: Schema.mutableKey(
    Schema.mutable(Schema.Array(CreatePackageEvaluationEvidenceSample)),
  ),

  baseline_regression_samples: Schema.mutableKey(
    Schema.mutable(Schema.Array(CreatePackageEvaluationEvidenceSample)),
  ),
});
export type CreatePackageEvaluationEvidenceSummary =
  typeof CreatePackageEvaluationEvidenceSummary.Type;

export const CreatePackageEvaluationEfficiencySummary = Schema.Struct({
  with_skill: Schema.mutableKey(RuntimeReplayAggregateMetrics),

  without_skill: Schema.mutableKey(RuntimeReplayAggregateMetrics),
});
export type CreatePackageEvaluationEfficiencySummary =
  typeof CreatePackageEvaluationEfficiencySummary.Type;

export const CreatePackageEvaluationGradingBaselineSummary = Schema.Struct({
  proposal_id: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  measured_at: Schema.mutableKey(Schema.String),

  pass_rate: Schema.mutableKey(Schema.Number),

  mean_score: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  sample_size: Schema.mutableKey(Schema.Number),
});
export type CreatePackageEvaluationGradingBaselineSummary =
  typeof CreatePackageEvaluationGradingBaselineSummary.Type;

export const CreatePackageEvaluationGradingRecentSummary = Schema.Struct({
  sample_size: Schema.mutableKey(Schema.Number),

  average_pass_rate: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  average_mean_score: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  newest_graded_at: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  oldest_graded_at: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),
});
export type CreatePackageEvaluationGradingRecentSummary =
  typeof CreatePackageEvaluationGradingRecentSummary.Type;

export const CreatePackageEvaluationGradingSummary = Schema.Struct({
  baseline: Schema.mutableKey(
    Schema.Union([CreatePackageEvaluationGradingBaselineSummary, Schema.Null]),
  ),

  recent: Schema.mutableKey(
    Schema.Union([CreatePackageEvaluationGradingRecentSummary, Schema.Null]),
  ),

  pass_rate_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  mean_score_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  regressed: Schema.mutableKey(Schema.Union([Schema.Boolean, Schema.Null])),
});
export type CreatePackageEvaluationGradingSummary =
  typeof CreatePackageEvaluationGradingSummary.Type;

export const CreatePackageBodySummary = Schema.Struct({
  structural_valid: Schema.mutableKey(Schema.Boolean),

  structural_reason: Schema.mutableKey(Schema.String),

  quality_score: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  quality_reason: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  quality_threshold: Schema.mutableKey(Schema.Number),

  quality_passed: Schema.mutableKey(Schema.Union([Schema.Boolean, Schema.Null])),

  valid: Schema.mutableKey(Schema.Boolean),
});
export type CreatePackageBodySummary = typeof CreatePackageBodySummary.Type;

export const CreatePackageEvaluationUnitTestFailureSummary = Schema.Struct({
  test_id: Schema.mutableKey(Schema.String),

  error: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  failed_assertions: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
});
export type CreatePackageEvaluationUnitTestFailureSummary =
  typeof CreatePackageEvaluationUnitTestFailureSummary.Type;

export const CreatePackageEvaluationUnitTestSummary = Schema.Struct({
  total: Schema.mutableKey(Schema.Number),

  passed: Schema.mutableKey(Schema.Number),

  failed: Schema.mutableKey(Schema.Number),

  pass_rate: Schema.mutableKey(Schema.Number),

  run_at: Schema.mutableKey(Schema.String),

  failing_tests: Schema.mutableKey(
    Schema.mutable(Schema.Array(CreatePackageEvaluationUnitTestFailureSummary)),
  ),
});
export type CreatePackageEvaluationUnitTestSummary =
  typeof CreatePackageEvaluationUnitTestSummary.Type;

export const MonitoringSnapshot = Schema.Struct({
  timestamp: Schema.mutableKey(Schema.String),

  skill_name: Schema.mutableKey(Schema.String),

  window_sessions: Schema.mutableKey(Schema.Number),

  skill_checks: Schema.mutableKey(Schema.Number),

  pass_rate: Schema.mutableKey(Schema.Number),

  false_negative_rate: Schema.mutableKey(Schema.Number),

  by_invocation_type: Schema.mutableKey(
    Schema.Record(
      InvocationType,
      Schema.mutableKey(
        Schema.Struct({
          passed: Schema.mutableKey(Schema.Number),

          total: Schema.mutableKey(Schema.Number),
        }),
      ),
    ),
  ),

  regression_detected: Schema.mutableKey(Schema.Boolean),

  baseline_pass_rate: Schema.mutableKey(Schema.Number),
});
export type MonitoringSnapshot = typeof MonitoringSnapshot.Type;

export const CreatePackageEvaluationWatchEfficiencyRegressionSummary = Schema.Struct({
  sample_size: Schema.mutableKey(Schema.Number),

  baseline_avg_duration_ms: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  observed_avg_duration_ms: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  duration_delta_ratio: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  baseline_avg_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  observed_avg_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  input_tokens_delta_ratio: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  baseline_avg_output_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  observed_avg_output_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  output_tokens_delta_ratio: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  baseline_avg_turns: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  observed_avg_turns: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  turns_delta_ratio: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),
});
export type CreatePackageEvaluationWatchEfficiencyRegressionSummary =
  typeof CreatePackageEvaluationWatchEfficiencyRegressionSummary.Type;

export const CreatePackageEvaluationWatchSummary = Schema.Struct({
  snapshot: Schema.mutableKey(MonitoringSnapshot),

  alert: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  rolled_back: Schema.mutableKey(Schema.Boolean),

  recommendation: Schema.mutableKey(Schema.String),

  recommended_command: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  grade_alert: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  grade_regression: Schema.mutableKey(
    Schema.Union([
      Schema.Struct({
        before: Schema.mutableKey(Schema.Number),

        after: Schema.mutableKey(Schema.Number),

        delta: Schema.mutableKey(Schema.Number),
      }),
      Schema.Null,
    ]),
  ),

  efficiency_alert: Schema.mutableKey(
    Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ),

  efficiency_regression: Schema.mutableKey(
    Schema.optionalKey(
      Schema.Union([CreatePackageEvaluationWatchEfficiencyRegressionSummary, Schema.Null]),
    ),
  ),
});
export type CreatePackageEvaluationWatchSummary = typeof CreatePackageEvaluationWatchSummary.Type;

export const CreatePackageCandidateAcceptanceDecision = Schema.Union([
  Schema.Literal("root"),
  Schema.Literal("accepted"),
  Schema.Literal("rejected"),
]);
export type CreatePackageCandidateAcceptanceDecision =
  typeof CreatePackageCandidateAcceptanceDecision.Type;

export const CreatePackageCandidateAcceptanceSummary = Schema.Struct({
  decision: Schema.mutableKey(CreatePackageCandidateAcceptanceDecision),

  compared_to_candidate_id: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  decided_at: Schema.mutableKey(Schema.String),

  rationale: Schema.mutableKey(Schema.String),

  replay_pass_rate_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  routing_pass_rate_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  baseline_lift_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  body_quality_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  unit_test_pass_rate_delta: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),
});
export type CreatePackageCandidateAcceptanceSummary =
  typeof CreatePackageCandidateAcceptanceSummary.Type;

export const CreatePackageEvaluationSummary = Schema.Struct({
  skill_name: Schema.mutableKey(Schema.String),

  skill_path: Schema.mutableKey(Schema.String),

  mode: Schema.mutableKey(ReplayStagingMode),

  package_fingerprint: Schema.mutableKey(Schema.optionalKey(Schema.String)),

  candidate_id: Schema.mutableKey(Schema.optionalKey(Schema.String)),

  parent_candidate_id: Schema.mutableKey(
    Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ),

  candidate_generation: Schema.mutableKey(
    Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
  ),

  evaluation_source: Schema.mutableKey(Schema.optionalKey(CreatePackageEvaluationSource)),

  status: Schema.mutableKey(CreatePackageEvaluationStatus),

  evaluation_passed: Schema.mutableKey(Schema.Boolean),

  next_command: Schema.mutableKey(Schema.Union([Schema.String, Schema.Null])),

  replay: Schema.mutableKey(CreatePackageReplaySummary),

  routing: Schema.mutableKey(Schema.optionalKey(CreatePackageReplaySummary)),

  baseline: Schema.mutableKey(CreatePackageBaselineSummary),

  evidence: Schema.mutableKey(Schema.optionalKey(CreatePackageEvaluationEvidenceSummary)),

  efficiency: Schema.mutableKey(Schema.optionalKey(CreatePackageEvaluationEfficiencySummary)),

  grading: Schema.mutableKey(Schema.optionalKey(CreatePackageEvaluationGradingSummary)),

  body: Schema.mutableKey(Schema.optionalKey(CreatePackageBodySummary)),

  unit_tests: Schema.mutableKey(Schema.optionalKey(CreatePackageEvaluationUnitTestSummary)),

  watch: Schema.mutableKey(Schema.optionalKey(CreatePackageEvaluationWatchSummary)),

  candidate_acceptance: Schema.mutableKey(
    Schema.optionalKey(CreatePackageCandidateAcceptanceSummary),
  ),
});
export type CreatePackageEvaluationSummary = typeof CreatePackageEvaluationSummary.Type;

export const RuntimeReplayEntryMetrics = Schema.Struct({
  input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  output_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  cache_creation_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  cache_read_input_tokens: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  total_cost_usd: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  duration_ms: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),

  num_turns: Schema.mutableKey(Schema.Union([Schema.Number, Schema.Null])),
});
export type RuntimeReplayEntryMetrics = typeof RuntimeReplayEntryMetrics.Type;

export const RoutingReplayEntryResult = Schema.Struct({
  query: Schema.mutableKey(Schema.String),

  should_trigger: Schema.mutableKey(Schema.Boolean),

  triggered: Schema.mutableKey(Schema.Boolean),

  passed: Schema.mutableKey(Schema.Boolean),

  evidence: Schema.mutableKey(Schema.optionalKey(Schema.String)),

  runtime_metrics: Schema.mutableKey(Schema.optionalKey(RuntimeReplayEntryMetrics)),
});
export type RoutingReplayEntryResult = typeof RoutingReplayEntryResult.Type;

export const TokenUsageMetrics = Schema.Struct({
  input_tokens: Schema.mutableKey(Schema.Number),

  output_tokens: Schema.mutableKey(Schema.Number),

  total_tokens: Schema.mutableKey(Schema.Number),

  estimated_cost_usd: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
});
export type TokenUsageMetrics = typeof TokenUsageMetrics.Type;

export const BaselineResult = Schema.Struct({
  skill_name: Schema.mutableKey(Schema.String),

  query: Schema.mutableKey(Schema.String),

  with_skill: Schema.mutableKey(Schema.Boolean),

  triggered: Schema.mutableKey(Schema.Boolean),

  pass: Schema.mutableKey(Schema.Boolean),

  evidence: Schema.mutableKey(Schema.optionalKey(Schema.String)),

  latency_ms: Schema.mutableKey(Schema.optionalKey(Schema.Number)),

  tokens: Schema.mutableKey(Schema.optionalKey(TokenUsageMetrics)),

  measured_at: Schema.mutableKey(Schema.String),
});
export type BaselineResult = typeof BaselineResult.Type;

export const CreateReplayResult = Schema.Struct({
  skill: Schema.mutableKey(Schema.String),
  skill_path: Schema.mutableKey(Schema.String),
  mode: Schema.mutableKey(ReplayStagingMode),
  agent: Schema.mutableKey(Schema.String),
  proposal_id: Schema.mutableKey(Schema.String),
  total: Schema.mutableKey(Schema.Number),
  passed: Schema.mutableKey(Schema.Number),
  failed: Schema.mutableKey(Schema.Number),
  pass_rate: Schema.mutableKey(Schema.Number),
  fixture_id: Schema.mutableKey(Schema.String),
  results: Schema.mutableKey(Schema.mutable(Schema.Array(RoutingReplayEntryResult))),
  runtime_metrics: Schema.mutableKey(RuntimeReplayAggregateMetrics),
});
export type CreateReplayResult = typeof CreateReplayResult.Type;

export const CreateBaselineResult = Schema.Struct({
  skill_name: Schema.mutableKey(Schema.String),
  mode: Schema.mutableKey(ReplayStagingMode),
  baseline_pass_rate: Schema.mutableKey(Schema.Number),
  with_skill_pass_rate: Schema.mutableKey(Schema.Number),
  lift: Schema.mutableKey(Schema.Number),
  adds_value: Schema.mutableKey(Schema.Boolean),
  per_entry: Schema.mutableKey(Schema.mutable(Schema.Array(BaselineResult))),
  measured_at: Schema.mutableKey(Schema.String),
  runtime_metrics: Schema.mutableKey(
    Schema.optionalKey(
      Schema.Struct({
        with_skill: Schema.mutableKey(RuntimeReplayAggregateMetrics),
        without_skill: Schema.mutableKey(RuntimeReplayAggregateMetrics),
      }),
    ),
  ),
});
export type CreateBaselineResult = typeof CreateBaselineResult.Type;

export const CreatePackageEvaluationResult = Schema.Struct({
  summary: Schema.mutableKey(CreatePackageEvaluationSummary),
  replay: Schema.mutableKey(CreateReplayResult),
  baseline: Schema.mutableKey(CreateBaselineResult),
});
export type CreatePackageEvaluationResult = typeof CreatePackageEvaluationResult.Type;
