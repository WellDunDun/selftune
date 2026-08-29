import * as Schema from "effect/Schema";

export const EvaluationLaneSchema = Schema.Literals([
  "structural_validation",
  "trigger_routing",
  "outcome_task",
]);
export type EvaluationLane = typeof EvaluationLaneSchema.Type;
export const EvidenceRoleSchema = Schema.Literals(["calibration", "holdout"]);
export type EvidenceRole = typeof EvidenceRoleSchema.Type;
export const MutationSurfaceSchema = Schema.Literals([
  "body",
  "routing",
  "description",
  "structure",
]);
export type MutationSurface = typeof MutationSurfaceSchema.Type;

const TraceEvidenceEntrySchema = Schema.Struct({
  role: EvidenceRoleSchema,
  query: Schema.String,
  should_trigger: Schema.Boolean,
  source_reference: Schema.String,
  redacted_excerpt: Schema.optional(Schema.String),
});
export type TraceEvidenceEntry = typeof TraceEvidenceEntrySchema.Type;

export const EvaluationSubmissionV1Schema = Schema.Struct({
  schema_version: Schema.Literal(1),
  submission_id: Schema.String,
  idempotency_key: Schema.String,
  baseline: Schema.Struct({
    cloud_source_id: Schema.String,
    cloud_snapshot_id: Schema.String,
    skill_id: Schema.String,
    skill_name: Schema.String,
    skill_revision: Schema.String,
  }),
  hypothesis: Schema.Struct({
    pattern_id: Schema.String,
    kind: Schema.Literal("repeated_correlated_errors"),
    summary: Schema.String,
  }),
  candidate: Schema.Struct({
    proposal_id: Schema.String,
    mutation_surface: MutationSurfaceSchema,
    target_revision: Schema.String,
    proposed_body: Schema.String,
    rationale: Schema.String,
  }),
  evaluation: Schema.Struct({
    cloud_eval_suite_id: Schema.String,
    manifest_digest: Schema.String,
    lane: EvaluationLaneSchema,
    max_repetitions: Schema.Number,
    verification_only: Schema.Boolean,
  }),
  evidence: Schema.Struct({
    cohort_fingerprint: Schema.String,
    selected_trace_count: Schema.Number,
    entries: Schema.Array(TraceEvidenceEntrySchema),
  }),
});
export type EvaluationSubmissionV1 = typeof EvaluationSubmissionV1Schema.Type;

const MAX_TRACE_EVIDENCE_ENTRIES = 14;
const MAX_SELECTED_TRACE_COUNT = 10_000;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const sensitiveTextPattern =
  /(?:bearer\s+|\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*)[^\s,;]+/i;
const localPathPattern = /(?:^|[\s"'`])(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/;

function privateKeyRange(value: string): readonly [number, number] | null {
  const upper = value.toUpperCase();
  const start = upper.indexOf("-----BEGIN ");
  if (start < 0) return null;
  const beginEnd = upper.indexOf("PRIVATE KEY-----", start + 11);
  if (beginEnd < 0) return null;
  const endStart = upper.indexOf("-----END ", beginEnd + 16);
  if (endStart < 0) return null;
  const end = upper.indexOf("PRIVATE KEY-----", endStart + 9);
  return end < 0 ? null : [start, end + 16];
}

function redactPrivateKey(value: string): string {
  const range = privateKeyRange(value);
  return range === null
    ? value
    : `${value.slice(0, range[0])}[redacted-private-key]${value.slice(range[1])}`;
}

function validateSafeText(value: string, key: string, maximumLength: number): void {
  if (value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${key} must be a non-empty string up to ${maximumLength} characters.`);
  }
  if (
    sensitiveTextPattern.test(value) ||
    privateKeyRange(value) !== null ||
    localPathPattern.test(value)
  ) {
    throw new TypeError(`${key} must not contain a secret or absolute local path.`);
  }
}

function validateInteger(value: number, key: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function validateSemantics(submission: EvaluationSubmissionV1): EvaluationSubmissionV1 {
  const textFields: ReadonlyArray<readonly [string, string, number]> = [
    [submission.submission_id, "submission_id", 128],
    [submission.idempotency_key, "idempotency_key", 128],
    [submission.baseline.cloud_source_id, "cloud_source_id", 128],
    [submission.baseline.cloud_snapshot_id, "cloud_snapshot_id", 128],
    [submission.baseline.skill_id, "skill_id", 128],
    [submission.baseline.skill_name, "skill_name", 160],
    [submission.baseline.skill_revision, "skill_revision", 128],
    [submission.hypothesis.pattern_id, "pattern_id", 128],
    [submission.hypothesis.summary, "summary", 2_000],
    [submission.candidate.proposal_id, "proposal_id", 128],
    [submission.candidate.target_revision, "target_revision", 128],
    [submission.candidate.proposed_body, "proposed_body", 16_000],
    [submission.candidate.rationale, "rationale", 2_000],
    [submission.evaluation.cloud_eval_suite_id, "cloud_eval_suite_id", 128],
    [submission.evaluation.manifest_digest, "manifest_digest", 71],
    [submission.evidence.cohort_fingerprint, "cohort_fingerprint", 71],
  ];
  for (const [value, key, maximum] of textFields) validateSafeText(value, key, maximum);

  if (!fingerprintPattern.test(submission.evaluation.manifest_digest)) {
    throw new TypeError("evaluation manifest_digest is invalid.");
  }
  if (!fingerprintPattern.test(submission.evidence.cohort_fingerprint)) {
    throw new TypeError("evidence cohort_fingerprint is invalid.");
  }
  validateInteger(submission.evaluation.max_repetitions, "max_repetitions", 1, 100);
  validateInteger(
    submission.evidence.selected_trace_count,
    "selected_trace_count",
    1,
    MAX_SELECTED_TRACE_COUNT,
  );
  if (
    submission.evidence.entries.length < 1 ||
    submission.evidence.entries.length > MAX_TRACE_EVIDENCE_ENTRIES
  ) {
    throw new TypeError(
      `evidence entries must contain 1 to ${MAX_TRACE_EVIDENCE_ENTRIES} entries.`,
    );
  }
  for (const entry of submission.evidence.entries) {
    validateSafeText(entry.query, "query", 2_000);
    validateSafeText(entry.source_reference, "source_reference", 512);
    if (entry.redacted_excerpt !== undefined) {
      validateSafeText(entry.redacted_excerpt, "redacted_excerpt", 1_000);
    }
  }
  if (!submission.evidence.entries.some((entry) => entry.role === "calibration")) {
    throw new TypeError("evidence entries must include calibration.");
  }
  if (!submission.evidence.entries.some((entry) => entry.role === "holdout")) {
    throw new TypeError("evidence entries must include holdout.");
  }

  const { mutation_surface: surface } = submission.candidate;
  const { lane, verification_only: verificationOnly } = submission.evaluation;
  if (surface === "body" && (lane !== "outcome_task" || verificationOnly)) {
    throw new TypeError(
      "body candidates require an outcome_task evaluation that can make a winner claim.",
    );
  }
  if (surface === "routing" && (lane !== "trigger_routing" || verificationOnly)) {
    throw new TypeError(
      "routing candidates require a trigger_routing evaluation that can make a winner claim.",
    );
  }
  if (
    (surface === "description" || surface === "structure") &&
    (lane !== "structural_validation" || !verificationOnly)
  ) {
    throw new TypeError(
      "description and structure candidates require verification-only structural validation.",
    );
  }
  return submission;
}

function redactText(value: string): string {
  return redactPrivateKey(value)
    .replace(/bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]");
}

function redactEvidenceEntry(entry: TraceEvidenceEntry): TraceEvidenceEntry {
  const redacted = {
    role: entry.role,
    query: redactText(entry.query),
    should_trigger: entry.should_trigger,
    source_reference: redactText(entry.source_reference),
  };
  if (entry.redacted_excerpt !== undefined) {
    return { ...redacted, redacted_excerpt: redactText(entry.redacted_excerpt) };
  }
  return redacted;
}

export function buildEvaluationSubmission(input: EvaluationSubmissionV1): EvaluationSubmissionV1 {
  return parseEvaluationSubmission({
    ...input,
    submission_id: redactText(input.submission_id),
    idempotency_key: redactText(input.idempotency_key),
    baseline: {
      cloud_source_id: redactText(input.baseline.cloud_source_id),
      cloud_snapshot_id: redactText(input.baseline.cloud_snapshot_id),
      skill_id: redactText(input.baseline.skill_id),
      skill_name: redactText(input.baseline.skill_name),
      skill_revision: redactText(input.baseline.skill_revision),
    },
    hypothesis: {
      ...input.hypothesis,
      pattern_id: redactText(input.hypothesis.pattern_id),
      summary: redactText(input.hypothesis.summary),
    },
    candidate: {
      ...input.candidate,
      proposal_id: redactText(input.candidate.proposal_id),
      target_revision: redactText(input.candidate.target_revision),
      proposed_body: redactText(input.candidate.proposed_body),
      rationale: redactText(input.candidate.rationale),
    },
    evaluation: {
      ...input.evaluation,
      cloud_eval_suite_id: redactText(input.evaluation.cloud_eval_suite_id),
    },
    evidence: { ...input.evidence, entries: input.evidence.entries.map(redactEvidenceEntry) },
  });
}

export function parseEvaluationSubmission(
  value: typeof Schema.Unknown.Type,
): EvaluationSubmissionV1 {
  try {
    const submission = Schema.decodeUnknownSync(EvaluationSubmissionV1Schema)(value, {
      onExcessProperty: "error",
    });
    return validateSemantics(submission);
  } catch (cause) {
    const message = String(cause);
    if (message.includes('at ["run_id"]')) {
      throw new TypeError("Evaluation submission contains an unsupported field: run_id.", {
        cause,
      });
    }
    throw cause;
  }
}
