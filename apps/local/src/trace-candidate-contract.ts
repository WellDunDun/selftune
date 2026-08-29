import { Context, Effect, Schema } from "effect";

export interface TraceCandidateReview {
  readonly draft_id: string | null;
  readonly pattern_id: string;
  readonly cohort_fingerprint: string | null;
  readonly target_revision: string | null;
  readonly readiness: "review_ready" | "not_ready";
  readonly failure_reason: string | null;
  readonly evidence: {
    readonly cohort_entries: number;
    readonly resolved_entries: number;
  };
  readonly candidate: {
    readonly body: string;
    readonly rationale: string;
    readonly diff: {
      readonly changed_lines: number;
      readonly target_section: string;
    };
    readonly uncertainty: readonly string[];
  } | null;
  readonly search?: {
    readonly requested_candidates: number;
    readonly generated_candidates: number;
    readonly calibrated_candidates: number;
    readonly required_calibration_repetitions: number;
    readonly current_calibration_passed_repetitions: number;
    readonly frontier_candidate_ids: readonly string[];
    readonly selected_candidate_id: string | null;
    readonly selection_method: "pareto_calibration_frontier";
    readonly candidate_summaries: readonly {
      readonly proposal_id: string;
      readonly calibration_passed: boolean;
      readonly scored_repetitions: number;
      readonly passed_repetitions: number;
      readonly calibration_score: number;
      readonly changed_lines: number;
      readonly input_tokens: number | null;
      readonly output_tokens: number | null;
      readonly wall_time_ms: number | null;
      readonly frontier_member: boolean;
      readonly selected: boolean;
    }[];
  } | null;
}

export class TraceCandidatePreparationError extends Schema.TaggedErrorClass<TraceCandidatePreparationError>()(
  "TraceCandidatePreparationError",
  { message: Schema.String },
) {}

export interface TraceCandidatePreparationService {
  readonly prepare: (
    input: unknown,
  ) => Effect.Effect<TraceCandidateReview, TraceCandidatePreparationError>;
}

export class TraceCandidatePreparation extends Context.Service<
  TraceCandidatePreparation,
  TraceCandidatePreparationService
>()("@selftune/local/TraceCandidatePreparation") {}
