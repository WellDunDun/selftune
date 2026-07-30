/**
 * Projects a locally review-ready body mutation into the portable Cloud
 * evaluation submission. Evidence is hypothesis context only: Cloud executes
 * the frozen suite named by the caller, never a trace-derived query.
 */

import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type EvaluationLane,
  type EvaluationSubmissionV1,
  buildEvaluationSubmission,
} from "@selftune/dashboard-core/review/portable";
import { EvidenceCohort, type EvidenceCohortEntry } from "@selftune/observability/evidence-cohort";

import {
  ResolvedEvidenceReference,
  type ExistingSkillBodyMutationCandidate,
} from "./evidence-cohort-body-adapter.js";

const ProjectionReason = Schema.Literals([
  "missing_cloud_identity",
  "candidate_revision_mismatch",
  "unresolved_evidence",
  "missing_evidence_split",
  "semantic_incompatibility",
  "invalid_submission",
]);

export class ImproveEvaluationProjectionFailure extends Schema.TaggedErrorClass<ImproveEvaluationProjectionFailure>()(
  "ImproveEvaluationProjectionFailure",
  {
    reason: ProjectionReason,
    message: Schema.String,
  },
) {}

export interface ImproveEvaluationProjectionInput {
  readonly cohort: EvidenceCohort;
  readonly candidate: ExistingSkillBodyMutationCandidate;
  readonly resolved_evidence: ReadonlyArray<ResolvedEvidenceReference>;
  /** Cloud identities are explicit authority, never inferred from local paths. */
  readonly cloud_source_id: string;
  readonly cloud_snapshot_id: string;
  readonly cloud_skill_id: string;
  /** A pre-existing frozen Cloud suite, not a suite assembled from trace evidence. */
  readonly cloud_eval_suite_id: string;
  readonly manifest_digest: string;
  readonly lane: EvaluationLane;
  readonly max_repetitions: number;
}

const bounded = (value: string, maximum: number): string => value.slice(0, maximum);

const sourceKey = (entry: EvidenceCohortEntry): string =>
  [
    entry.source.source_id,
    entry.source.source_revision,
    entry.source.trace_id,
    entry.source.span_id,
    entry.source.skill_invocation_id,
  ].join("\u0000");

const resolvedKey = (entry: ResolvedEvidenceReference): string =>
  [
    entry.source_id,
    entry.source_revision,
    entry.trace_id,
    entry.span_id,
    entry.skill_invocation_id,
  ].join("\u0000");

const stableSourceReference = (entry: EvidenceCohortEntry): string =>
  `trace://${entry.source.source_id}/${entry.source.source_revision}/${entry.source.trace_id}/${entry.source.span_id}/${entry.source.skill_invocation_id}`;

const evidenceRole = (entry: EvidenceCohortEntry): "calibration" | "holdout" =>
  entry.role === "heldout_failure" || entry.role === "heldout_success" ? "holdout" : "calibration";

const deterministicId = (
  prefix: "improve-evaluation" | "improve-evaluation-idempotency",
  input: ImproveEvaluationProjectionInput,
): string => {
  const digest = createHash("sha256")
    .update("selftune.improve-evaluation-projection.v1")
    .update("\u0000")
    .update(
      JSON.stringify([
        input.cohort.fingerprint,
        input.cohort.target_skill.skill_id,
        input.cohort.target_skill.revision,
        input.candidate.proposal_id,
        input.candidate.target_revision,
        input.candidate.proposed_body,
        input.cloud_source_id,
        input.cloud_snapshot_id,
        input.cloud_skill_id,
        input.cloud_eval_suite_id,
        input.manifest_digest,
        input.lane,
        input.max_repetitions,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
};

const requireCloudIdentity = (input: ImproveEvaluationProjectionInput) => {
  if (
    !input.cloud_source_id.trim() ||
    !input.cloud_snapshot_id.trim() ||
    !input.cloud_skill_id.trim() ||
    !input.cloud_eval_suite_id.trim() ||
    !input.manifest_digest.trim()
  ) {
    return Effect.fail(
      ImproveEvaluationProjectionFailure.make({
        reason: "missing_cloud_identity",
        message:
          "cloud_source_id, cloud_snapshot_id, cloud_skill_id, cloud_eval_suite_id, and manifest_digest are required explicitly.",
      }),
    );
  }
  return Effect.void;
};

const projectEvidence = (
  cohort: EvidenceCohort,
  resolvedEvidence: ReadonlyArray<ResolvedEvidenceReference>,
) => {
  const exactRevision = new Map(
    resolvedEvidence
      .filter((entry) => entry.skill_revision === cohort.target_skill.revision)
      .map((entry) => [resolvedKey(entry), entry]),
  );
  const entries = cohort.entries.map((entry) => {
    const resolved = exactRevision.get(sourceKey(entry));
    if (resolved === undefined) return undefined;
    return {
      role: evidenceRole(entry),
      query: bounded(resolved.query, 2_000),
      should_trigger: resolved.should_trigger,
      source_reference: bounded(stableSourceReference(entry), 512),
      ...(entry.redacted_excerpt === undefined
        ? {}
        : { redacted_excerpt: bounded(entry.redacted_excerpt, 1_000) }),
    };
  });
  if (entries.some((entry) => entry === undefined)) {
    return Effect.fail(
      ImproveEvaluationProjectionFailure.make({
        reason: "unresolved_evidence",
        message: "Every selected cohort entry must resolve at the cohort target skill revision.",
      }),
    );
  }
  const projected = entries.filter((entry) => entry !== undefined);
  if (
    !projected.some((entry) => entry.role === "calibration") ||
    !projected.some((entry) => entry.role === "holdout")
  ) {
    return Effect.fail(
      ImproveEvaluationProjectionFailure.make({
        reason: "missing_evidence_split",
        message: "Selected evidence must include both calibration and holdout entries.",
      }),
    );
  }
  return Effect.succeed(projected);
};

/**
 * A body mutation needs outcome-task evaluation before it can be submitted as
 * an improvement claim. Structural checks are verification-only work and are
 * deliberately rejected here.
 */
export const projectImproveEvaluationSubmission = Effect.fn("projectImproveEvaluationSubmission")(
  function* (
    input: ImproveEvaluationProjectionInput,
  ): Effect.fn.Return<EvaluationSubmissionV1, ImproveEvaluationProjectionFailure> {
    const cohort = yield* Schema.decodeUnknownEffect(EvidenceCohort)(input.cohort).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(
          ImproveEvaluationProjectionFailure.make({
            reason: "invalid_submission",
            message: error.message,
          }),
        ),
      ),
    );
    const resolvedEvidence = yield* Schema.decodeUnknownEffect(
      Schema.Array(ResolvedEvidenceReference),
    )(input.resolved_evidence).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(
          ImproveEvaluationProjectionFailure.make({
            reason: "invalid_submission",
            message: error.message,
          }),
        ),
      ),
    );
    yield* requireCloudIdentity(input);
    if (input.candidate.target_revision !== cohort.target_skill.revision) {
      return yield* Effect.fail(
        ImproveEvaluationProjectionFailure.make({
          reason: "candidate_revision_mismatch",
          message:
            "The body candidate target_revision must equal the Evidence Cohort target revision.",
        }),
      );
    }
    if (input.lane !== "outcome_task") {
      return yield* Effect.fail(
        ImproveEvaluationProjectionFailure.make({
          reason: "semantic_incompatibility",
          message:
            "An existing-skill body mutation requires an outcome_task Cloud evaluation; structural or routing checks cannot claim body improvement.",
        }),
      );
    }
    if (input.max_repetitions < 3) {
      return yield* Effect.fail(
        ImproveEvaluationProjectionFailure.make({
          reason: "semantic_incompatibility",
          message: "An outcome-task body evaluation requires at least three scored repetitions.",
        }),
      );
    }
    const evidence = yield* projectEvidence(cohort, resolvedEvidence);
    const submission = {
      schema_version: 1 as const,
      submission_id: deterministicId("improve-evaluation", input),
      idempotency_key: deterministicId("improve-evaluation-idempotency", input),
      baseline: {
        cloud_source_id: input.cloud_source_id,
        cloud_snapshot_id: input.cloud_snapshot_id,
        skill_id: input.cloud_skill_id,
        skill_name: cohort.target_skill.skill_name,
        skill_revision: cohort.target_skill.revision,
      },
      hypothesis: {
        pattern_id: cohort.pattern.pattern_id,
        kind: "repeated_correlated_errors" as const,
        summary: `Repeated correlated errors observed for ${cohort.target_skill.skill_name}.`,
      },
      candidate: {
        proposal_id: input.candidate.proposal_id,
        mutation_surface: "body" as const,
        target_revision: input.candidate.target_revision,
        proposed_body: input.candidate.proposed_body,
        rationale: input.candidate.rationale,
      },
      evaluation: {
        cloud_eval_suite_id: input.cloud_eval_suite_id,
        manifest_digest: input.manifest_digest,
        lane: "outcome_task" as const,
        max_repetitions: input.max_repetitions,
        verification_only: false,
      },
      evidence: {
        cohort_fingerprint: cohort.fingerprint,
        selected_trace_count: cohort.entries.length,
        entries: evidence,
      },
    } satisfies EvaluationSubmissionV1;
    return yield* Effect.try({
      try: () => buildEvaluationSubmission(submission),
      catch: (error) =>
        ImproveEvaluationProjectionFailure.make({
          reason: "invalid_submission",
          message:
            error instanceof Error ? error.message : "Portable submission validation failed.",
        }),
    });
  },
);
