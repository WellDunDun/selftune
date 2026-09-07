import * as Schema from "effect/Schema";
import { DashboardActionName } from "./action-name.js";
import type { DashboardActionEvent, DashboardActionResultSummary } from "../dashboard-contract.js";
import {
  CreatePackageBodySummary,
  CreatePackageCandidateAcceptanceDecision,
  CreatePackageEvaluationEfficiencySummary,
  CreatePackageEvaluationEvidenceSummary,
  CreatePackageEvaluationGradingSummary,
  CreatePackageEvaluationSource,
  CreatePackageEvaluationUnitTestSummary,
  CreatePackageEvaluationWatchSummary,
  CreatePackageReplaySummary,
} from "../types/evaluation.js";
import { optionalEvidence } from "../utils/transcript-contract.js";

const Text = Schema.NullOr(Schema.String);
const NumberValue = Schema.NullOr(Schema.Number);
const OptionalText = optionalEvidence(Text);
const SearchRun = Schema.Struct({
  search_id: Schema.String,
  parent_candidate_id: Text,
  winner_candidate_id: Text,
  winner_rationale: Text,
  candidates_evaluated: Schema.Number,
  frontier_size: Schema.Number,
  parent_selection_method: Schema.String,
  surface_plan: optionalEvidence(
    Schema.NullOr(
      Schema.Struct({
        routing_count: Schema.Number,
        body_count: Schema.Number,
        weakness_source: Schema.String,
        routing_weakness: NumberValue,
        body_weakness: NumberValue,
      }),
    ),
  ),
});
const ResultSummary: Schema.Codec<DashboardActionResultSummary> = Schema.Struct({
  reason: Text,
  improved: Schema.NullOr(Schema.Boolean),
  deployed: Schema.NullOr(Schema.Boolean),
  before_pass_rate: NumberValue,
  before_label: OptionalText,
  after_pass_rate: NumberValue,
  after_label: OptionalText,
  net_change: NumberValue,
  net_change_label: OptionalText,
  validation_mode: Text,
  validation_label: OptionalText,
  recommended_command: OptionalText,
  package_evaluation_source: optionalEvidence(Schema.NullOr(CreatePackageEvaluationSource)),
  package_candidate_id: OptionalText,
  package_parent_candidate_id: OptionalText,
  package_candidate_generation: optionalEvidence(NumberValue),
  package_candidate_acceptance_decision: optionalEvidence(
    Schema.NullOr(CreatePackageCandidateAcceptanceDecision),
  ),
  package_candidate_acceptance_rationale: OptionalText,
  package_evidence: optionalEvidence(Schema.NullOr(CreatePackageEvaluationEvidenceSummary)),
  package_efficiency: optionalEvidence(Schema.NullOr(CreatePackageEvaluationEfficiencySummary)),
  package_routing: optionalEvidence(Schema.NullOr(CreatePackageReplaySummary)),
  package_body: optionalEvidence(Schema.NullOr(CreatePackageBodySummary)),
  package_grading: optionalEvidence(Schema.NullOr(CreatePackageEvaluationGradingSummary)),
  package_unit_tests: optionalEvidence(Schema.NullOr(CreatePackageEvaluationUnitTestSummary)),
  package_watch: optionalEvidence(Schema.NullOr(CreatePackageEvaluationWatchSummary)),
  search_run: optionalEvidence(Schema.NullOr(SearchRun)),
  watch_gate_passed: optionalEvidence(Schema.NullOr(Schema.Boolean)),
});

const ActionEvent: Schema.Codec<DashboardActionEvent> = Schema.Struct({
  event_id: Schema.String,
  action: DashboardActionName,
  stage: Schema.Literals(["started", "progress", "stdout", "stderr", "metrics", "finished"]),
  skill_name: Text,
  skill_path: Text,
  ts: Schema.Number,
  chunk: optionalEvidence(Schema.String),
  success: optionalEvidence(Schema.Boolean),
  exit_code: optionalEvidence(NumberValue),
  error: OptionalText,
  summary: optionalEvidence(Schema.NullOr(ResultSummary)),
  metrics: optionalEvidence(
    Schema.NullOr(
      Schema.Struct({
        platform: Text,
        model: Text,
        session_id: Text,
        input_tokens: NumberValue,
        output_tokens: NumberValue,
        cache_creation_input_tokens: NumberValue,
        cache_read_input_tokens: NumberValue,
        total_cost_usd: NumberValue,
        duration_ms: NumberValue,
        num_turns: NumberValue,
      }),
    ),
  ),
  progress: optionalEvidence(
    Schema.NullOr(
      Schema.Struct({
        current: Schema.Number,
        total: Schema.Number,
        status: Schema.Literals(["started", "finished"]),
        unit: optionalEvidence(Schema.NullOr(Schema.Literals(["eval", "llm_call", "step"]))),
        phase: OptionalText,
        label: OptionalText,
        query: Text,
        passed: Schema.NullOr(Schema.Boolean),
        evidence: Text,
      }),
    ),
  ),
});

const decodeActionLine = Schema.decodeUnknownSync(Schema.fromJsonString(ActionEvent));
export const decodeDashboardActionLine = (line: string) =>
  decodeActionLine(line, { onExcessProperty: "preserve" });
