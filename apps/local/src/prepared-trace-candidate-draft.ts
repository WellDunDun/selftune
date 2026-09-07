import { EvidenceCohortEntry } from "@selftune/observability";
import { ResolvedEvidenceReference } from "@selftune/runtime/evolution/evidence-cohort-body-adapter";
import { Schema } from "effect";

const correlatedErrorDraftSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  cohort: Schema.Struct({
    schema_version: Schema.Literal("1.0.0"),
    selector_version: Schema.String.check(Schema.isMaxLength(256)),
    pattern: Schema.Struct({
      pattern_id: Schema.String.check(Schema.isMaxLength(256)),
      kind: Schema.Literal("repeated_correlated_errors"),
      skill_id: Schema.String.check(Schema.isMaxLength(256)),
      skill_name: Schema.String.check(Schema.isMaxLength(256)),
    }),
    target_skill: Schema.Struct({
      skill_id: Schema.String.check(Schema.isMaxLength(256)),
      skill_name: Schema.String.check(Schema.isMaxLength(256)),
      revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
    excerpt_limit_bytes: Schema.Number,
    request_limit_bytes: Schema.Number,
    entries: Schema.Array(EvidenceCohortEntry).check(Schema.isMaxLength(14)),
    fingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  }),
  candidate: Schema.Struct({
    proposal_id: Schema.String.check(Schema.isMaxLength(128)),
    target_revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    proposed_body: Schema.String.check(Schema.isMaxLength(16_000)),
    rationale: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
  resolved_evidence: Schema.Array(ResolvedEvidenceReference).check(Schema.isMaxLength(14)),
});

const historicalTaskSourceSchema = Schema.Struct({
  source_id: Schema.String.check(Schema.isMaxLength(256)),
  source_revision: Schema.String.check(Schema.isMaxLength(512)),
  trace_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  span_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  skill_invocation_id: Schema.String.check(Schema.isMaxLength(256)),
});

const historicalCandidateSearchSchema = Schema.Struct({
  requested_candidates: Schema.Number,
  generated_candidates: Schema.Number,
  calibrated_candidates: Schema.Number,
  required_calibration_repetitions: Schema.Number,
  current_calibration_passed_repetitions: Schema.Number,
  frontier_candidate_ids: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(8),
  ),
  selected_candidate_id: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  selection_method: Schema.Literal("pareto_calibration_frontier"),
  candidate_summaries: Schema.Array(
    Schema.Struct({
      proposal_id: Schema.String.check(Schema.isMaxLength(128)),
      calibration_passed: Schema.Boolean,
      scored_repetitions: Schema.Number,
      passed_repetitions: Schema.Number,
      calibration_score: Schema.Number,
      changed_lines: Schema.Number,
      input_tokens: Schema.NullOr(Schema.Number),
      output_tokens: Schema.NullOr(Schema.Number),
      wall_time_ms: Schema.NullOr(Schema.Number),
      frontier_member: Schema.Boolean,
      selected: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(8)),
});

export const preparedHistoricalTaskDraftSchema = Schema.Struct({
  schema_version: Schema.Literal(2),
  cohort: Schema.Struct({
    schema_version: Schema.Literal("1.0.0"),
    selector_version: Schema.String.check(Schema.isMaxLength(256)),
    pattern: Schema.Struct({
      pattern_id: Schema.String.check(Schema.isMaxLength(256)),
      kind: Schema.Literal("historical_task_quality"),
      skill_id: Schema.String.check(Schema.isMaxLength(256)),
      skill_name: Schema.String.check(Schema.isMaxLength(256)),
    }),
    target_skill: Schema.Struct({
      skill_id: Schema.String.check(Schema.isMaxLength(256)),
      skill_name: Schema.String.check(Schema.isMaxLength(256)),
      revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
    request_limit_bytes: Schema.Number,
    entries: Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["calibration", "selection", "audit_holdout"]),
        source: historicalTaskSourceSchema,
        redacted_task: Schema.String.check(Schema.isMaxLength(512)),
      }),
    ).check(Schema.isLengthBetween(3, 12)),
    fingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  }),
  candidate: Schema.NullOr(
    Schema.Struct({
      proposal_id: Schema.String.check(Schema.isMaxLength(128)),
      target_revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      proposed_body: Schema.String.check(Schema.isMaxLength(16_000)),
      rationale: Schema.String.check(Schema.isMaxLength(2_000)),
    }),
  ),
  search: Schema.optionalKey(historicalCandidateSearchSchema),
});

const preparedCandidateDraftSchema = Schema.Union([
  correlatedErrorDraftSchema,
  preparedHistoricalTaskDraftSchema,
]);

export type PreparedTraceCandidateDraft = typeof preparedCandidateDraftSchema.Type;

export const decodePreparedTraceCandidateDraft = Schema.decodeUnknownEffect(
  preparedCandidateDraftSchema,
);
