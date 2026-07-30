export type EvaluationLane = "structural_validation" | "trigger_routing" | "outcome_task";
export type EvidenceRole = "calibration" | "holdout";
export type MutationSurface = "body" | "routing" | "description" | "structure";

export interface EvaluationSubmissionV1 {
  readonly schema_version: 1;
  readonly submission_id: string;
  readonly idempotency_key: string;
  readonly baseline: {
    readonly cloud_source_id: string;
    readonly cloud_snapshot_id: string;
    readonly skill_id: string;
    readonly skill_name: string;
    readonly skill_revision: string;
  };
  readonly hypothesis: {
    readonly pattern_id: string;
    readonly kind: "repeated_correlated_errors";
    readonly summary: string;
  };
  readonly candidate: {
    readonly proposal_id: string;
    readonly mutation_surface: MutationSurface;
    readonly target_revision: string;
    readonly proposed_body: string;
    readonly rationale: string;
  };
  readonly evaluation: {
    readonly cloud_eval_suite_id: string;
    readonly manifest_digest: string;
    readonly lane: EvaluationLane;
    readonly max_repetitions: number;
    /** Structural verification cannot be reported as a candidate winner. */
    readonly verification_only: boolean;
  };
  readonly evidence: {
    readonly cohort_fingerprint: string;
    readonly selected_trace_count: number;
    readonly entries: readonly TraceEvidenceEntry[];
  };
}

/** Bounded trace-derived hypothesis evidence, never an executable Cloud eval case. */
export interface TraceEvidenceEntry {
  readonly role: EvidenceRole;
  readonly query: string;
  readonly should_trigger: boolean;
  readonly source_reference: string;
  readonly redacted_excerpt?: string;
}

const MAX_TRACE_EVIDENCE_ENTRIES = 14;
const MAX_SELECTED_TRACE_COUNT = 10_000;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const sensitiveTextPattern =
  /(?:bearer\s+|\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*)[^\s,;]+/i;
const localPathPattern = /(?:^|[\s"'`])(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/;
const PRIVATE_KEY_BEGIN = "-----BEGIN ";
const PRIVATE_KEY_END = "-----END ";
const PRIVATE_KEY_LABEL = "PRIVATE KEY";
const PRIVATE_KEY_FENCE = "-----";
const PRIVATE_KEY_REPLACEMENT = "[redacted-private-key]";

interface TextRange {
  readonly start: number;
  readonly end: number;
}

function matchesAsciiCaseInsensitive(value: string, start: number, expected: string): boolean {
  if (start < 0 || start + expected.length > value.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    const actualCode = value.charCodeAt(start + offset);
    const upperCode = actualCode >= 97 && actualCode <= 122 ? actualCode - 32 : actualCode;
    if (upperCode !== expected.charCodeAt(offset)) return false;
  }
  return true;
}

function isAsciiLetterOrSpace(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code === 32 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function findPrivateKeyMarker(
  value: string,
  prefix: typeof PRIVATE_KEY_BEGIN | typeof PRIVATE_KEY_END,
  fromIndex: number,
): TextRange | null {
  const lastCandidate = value.length - prefix.length;
  for (let candidate = Math.max(0, fromIndex); candidate <= lastCandidate; candidate += 1) {
    if (!matchesAsciiCaseInsensitive(value, candidate, prefix)) continue;

    const labelStart = candidate + prefix.length;
    let cursor = labelStart;
    while (cursor < value.length && isAsciiLetterOrSpace(value, cursor)) cursor += 1;

    const keyLabelStart = cursor - PRIVATE_KEY_LABEL.length;
    if (
      keyLabelStart >= labelStart &&
      matchesAsciiCaseInsensitive(value, keyLabelStart, PRIVATE_KEY_LABEL) &&
      value.startsWith(PRIVATE_KEY_FENCE, cursor)
    ) {
      return { start: candidate, end: cursor + PRIVATE_KEY_FENCE.length };
    }

    // A marker prefix cannot start inside the ASCII label run, so skip it in one pass.
    candidate = Math.max(candidate, cursor - 1);
  }
  return null;
}

function findPrivateKeyBlock(value: string, fromIndex = 0): TextRange | null {
  const begin = findPrivateKeyMarker(value, PRIVATE_KEY_BEGIN, fromIndex);
  if (begin === null) return null;
  const end = findPrivateKeyMarker(value, PRIVATE_KEY_END, begin.end);
  return end === null ? null : { start: begin.start, end: end.end };
}

function redactFirstPrivateKeyBlock(value: string): string {
  const block = findPrivateKeyBlock(value);
  return block === null
    ? value
    : `${value.slice(0, block.start)}${PRIVATE_KEY_REPLACEMENT}${value.slice(block.end)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new TypeError(`${label} contains an unsupported field: ${key}.`);
  }
  for (const key of keys) {
    if (!hasOwn(record, key)) throw new TypeError(`${label} is missing ${key}.`);
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function readSafeText(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${key} must be a non-empty string up to ${maxLength} characters.`);
  }
  if (
    sensitiveTextPattern.test(value) ||
    findPrivateKeyBlock(value) !== null ||
    localPathPattern.test(value)
  ) {
    throw new TypeError(`${key} must not contain a secret or absolute local path.`);
  }
  return value;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new TypeError(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function readLane(value: unknown): EvaluationLane {
  if (
    value === "structural_validation" ||
    value === "trigger_routing" ||
    value === "outcome_task"
  ) {
    return value;
  }
  throw new TypeError("evaluation lane is invalid.");
}

function readEvidenceRole(value: unknown): EvidenceRole {
  if (value === "calibration" || value === "holdout") return value;
  throw new TypeError("evidence entry role is invalid.");
}

function readMutationSurface(value: unknown): MutationSurface {
  if (value === "body" || value === "routing" || value === "description" || value === "structure") {
    return value;
  }
  throw new TypeError("candidate mutation_surface is invalid.");
}

function parseEvidenceEntry(value: unknown): TraceEvidenceEntry {
  const record = readRecord(value, "evidence entry");
  const hasExcerpt = hasOwn(record, "redacted_excerpt");
  assertExactKeys(
    record,
    hasExcerpt
      ? ["role", "query", "should_trigger", "source_reference", "redacted_excerpt"]
      : ["role", "query", "should_trigger", "source_reference"],
    "evidence entry",
  );
  if (typeof record.should_trigger !== "boolean") {
    throw new TypeError("evidence entry should_trigger must be a boolean.");
  }
  return {
    role: readEvidenceRole(record.role),
    query: readSafeText(record, "query", 2_000),
    should_trigger: record.should_trigger,
    source_reference: readSafeText(record, "source_reference", 512),
    ...(hasExcerpt ? { redacted_excerpt: readSafeText(record, "redacted_excerpt", 1_000) } : {}),
  };
}

function redactText(value: string): string {
  return redactFirstPrivateKeyBlock(value)
    .replace(/bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]");
}

/** Explicitly redacts user-derived text before producing a portable submission. */
export function buildEvaluationSubmission(input: EvaluationSubmissionV1): EvaluationSubmissionV1 {
  const submission: EvaluationSubmissionV1 = {
    schema_version: 1,
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
      pattern_id: redactText(input.hypothesis.pattern_id),
      kind: "repeated_correlated_errors",
      summary: redactText(input.hypothesis.summary),
    },
    candidate: {
      proposal_id: redactText(input.candidate.proposal_id),
      mutation_surface: input.candidate.mutation_surface,
      target_revision: redactText(input.candidate.target_revision),
      proposed_body: redactText(input.candidate.proposed_body),
      rationale: redactText(input.candidate.rationale),
    },
    evaluation: {
      cloud_eval_suite_id: redactText(input.evaluation.cloud_eval_suite_id),
      manifest_digest: input.evaluation.manifest_digest,
      lane: input.evaluation.lane,
      max_repetitions: input.evaluation.max_repetitions,
      verification_only: input.evaluation.verification_only,
    },
    evidence: {
      cohort_fingerprint: input.evidence.cohort_fingerprint,
      selected_trace_count: input.evidence.selected_trace_count,
      entries: input.evidence.entries.map((entry) => ({
        role: entry.role,
        query: redactText(entry.query),
        should_trigger: entry.should_trigger,
        source_reference: redactText(entry.source_reference),
        ...(entry.redacted_excerpt === undefined
          ? {}
          : { redacted_excerpt: redactText(entry.redacted_excerpt) }),
      })),
    },
  };
  return parseEvaluationSubmission(submission);
}

export function parseEvaluationSubmission(value: unknown): EvaluationSubmissionV1 {
  const record = readRecord(value, "Evaluation submission");
  assertExactKeys(
    record,
    [
      "schema_version",
      "submission_id",
      "idempotency_key",
      "baseline",
      "hypothesis",
      "candidate",
      "evaluation",
      "evidence",
    ],
    "Evaluation submission",
  );
  if (record.schema_version !== 1)
    throw new TypeError("Unsupported evaluation submission schema version.");

  const baseline = readRecord(record.baseline, "baseline");
  assertExactKeys(
    baseline,
    ["cloud_source_id", "cloud_snapshot_id", "skill_id", "skill_name", "skill_revision"],
    "baseline",
  );
  const hypothesis = readRecord(record.hypothesis, "hypothesis");
  assertExactKeys(hypothesis, ["pattern_id", "kind", "summary"], "hypothesis");
  if (hypothesis.kind !== "repeated_correlated_errors")
    throw new TypeError("hypothesis kind is invalid.");
  const candidate = readRecord(record.candidate, "candidate");
  assertExactKeys(
    candidate,
    ["proposal_id", "mutation_surface", "target_revision", "proposed_body", "rationale"],
    "candidate",
  );
  const evaluation = readRecord(record.evaluation, "evaluation");
  assertExactKeys(
    evaluation,
    ["cloud_eval_suite_id", "manifest_digest", "lane", "max_repetitions", "verification_only"],
    "evaluation",
  );
  const lane = readLane(evaluation.lane);
  if (typeof evaluation.verification_only !== "boolean") {
    throw new TypeError("evaluation verification_only must be a boolean.");
  }
  const mutationSurface = readMutationSurface(candidate.mutation_surface);
  if (mutationSurface === "body" && (lane !== "outcome_task" || evaluation.verification_only)) {
    throw new TypeError(
      "body candidates require an outcome_task evaluation that can make a winner claim.",
    );
  }
  if (
    mutationSurface === "routing" &&
    (lane !== "trigger_routing" || evaluation.verification_only)
  ) {
    throw new TypeError(
      "routing candidates require a trigger_routing evaluation that can make a winner claim.",
    );
  }
  if (
    (mutationSurface === "description" || mutationSurface === "structure") &&
    (lane !== "structural_validation" || !evaluation.verification_only)
  ) {
    throw new TypeError(
      "description and structure candidates require verification-only structural validation.",
    );
  }

  const evidence = readRecord(record.evidence, "evidence");
  assertExactKeys(evidence, ["cohort_fingerprint", "selected_trace_count", "entries"], "evidence");
  const fingerprint = readSafeText(evidence, "cohort_fingerprint", 71);
  if (!fingerprintPattern.test(fingerprint))
    throw new TypeError("evidence cohort_fingerprint is invalid.");
  if (
    !Array.isArray(evidence.entries) ||
    evidence.entries.length === 0 ||
    evidence.entries.length > MAX_TRACE_EVIDENCE_ENTRIES
  ) {
    throw new TypeError(
      `evidence entries must contain 1 to ${MAX_TRACE_EVIDENCE_ENTRIES} entries.`,
    );
  }
  const entries = evidence.entries.map(parseEvidenceEntry);
  if (!entries.some((entry) => entry.role === "calibration")) {
    throw new TypeError("evidence entries must include calibration.");
  }
  if (!entries.some((entry) => entry.role === "holdout")) {
    throw new TypeError("evidence entries must include holdout.");
  }

  return {
    schema_version: 1,
    submission_id: readSafeText(record, "submission_id", 128),
    idempotency_key: readSafeText(record, "idempotency_key", 128),
    baseline: {
      cloud_source_id: readSafeText(baseline, "cloud_source_id", 128),
      cloud_snapshot_id: readSafeText(baseline, "cloud_snapshot_id", 128),
      skill_id: readSafeText(baseline, "skill_id", 128),
      skill_name: readSafeText(baseline, "skill_name", 160),
      skill_revision: readSafeText(baseline, "skill_revision", 128),
    },
    hypothesis: {
      pattern_id: readSafeText(hypothesis, "pattern_id", 128),
      kind: "repeated_correlated_errors",
      summary: readSafeText(hypothesis, "summary", 2_000),
    },
    candidate: {
      proposal_id: readSafeText(candidate, "proposal_id", 128),
      mutation_surface: mutationSurface,
      target_revision: readSafeText(candidate, "target_revision", 128),
      proposed_body: readSafeText(candidate, "proposed_body", 16_000),
      rationale: readSafeText(candidate, "rationale", 2_000),
    },
    evaluation: {
      cloud_eval_suite_id: readSafeText(evaluation, "cloud_eval_suite_id", 128),
      manifest_digest: (() => {
        const digest = readSafeText(evaluation, "manifest_digest", 71);
        if (!fingerprintPattern.test(digest))
          throw new TypeError("evaluation manifest_digest is invalid.");
        return digest;
      })(),
      lane,
      max_repetitions: readInteger(evaluation, "max_repetitions", 1, 5),
      verification_only: evaluation.verification_only,
    },
    evidence: {
      cohort_fingerprint: fingerprint,
      selected_trace_count: readInteger(
        evidence,
        "selected_trace_count",
        1,
        MAX_SELECTED_TRACE_COUNT,
      ),
      entries,
    },
  };
}
