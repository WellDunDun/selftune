import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const TraceId = Schema.String.check(
  Schema.isLengthBetween(32, 32),
  Schema.isPattern(/^[0-9a-f]{32}$/),
);
const SpanId = Schema.String.check(
  Schema.isLengthBetween(16, 16),
  Schema.isPattern(/^[0-9a-f]{16}$/),
);
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Revision = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const MetricCount = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const Excerpt = Schema.String.check(Schema.isMaxLength(65_536));
const ExcerptLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(4_096),
);
const RequestLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(32_768),
);

export class EvidenceCohortFailure extends Schema.TaggedErrorClass<EvidenceCohortFailure>()(
  "EvidenceCohortFailure",
  {
    reason: Schema.Literals([
      "invalid_input",
      "insufficient_contrast",
      "source_not_allowed",
      "request_limit_exceeded",
    ]),
    message: Schema.String,
  },
) {}

/** Exact installed SKILL.md identity. The cohort never targets a new package. */
export class EvidenceCohortTargetSkill extends Schema.Class<EvidenceCohortTargetSkill>(
  "EvidenceCohortTargetSkill",
)({
  skill_id: BoundedText,
  skill_name: BoundedText,
  skill_path: Revision,
  revision: Revision,
}) {}

/** The supported analytical pattern is deliberately non-causal. */
export class EvidenceCohortPattern extends Schema.Class<EvidenceCohortPattern>(
  "EvidenceCohortPattern",
)({
  pattern_id: BoundedText,
  kind: Schema.Literal("repeated_correlated_errors"),
  skill_id: BoundedText,
  skill_name: BoundedText,
}) {}

/**
 * Source-native parsing occurs before this boundary. This carries only the
 * selected source reference, derived metrics, and an optional ephemeral text
 * sample. `source_excerpt` is never copied verbatim into the cohort.
 */
export class EvidenceCohortCandidate extends Schema.Class<EvidenceCohortCandidate>(
  "EvidenceCohortCandidate",
)({
  trace_id: TraceId,
  span_id: SpanId,
  skill_invocation_id: BoundedText,
  source_id: BoundedText,
  source_revision: Revision,
  model: Schema.optionalKey(BoundedText),
  duration_ms: MetricCount,
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
  source_excerpt: Schema.optionalKey(Excerpt),
}) {}

const CohortRole = Schema.Literals([
  "calibration_failure",
  "calibration_success",
  "counterexample",
  "heldout_failure",
  "heldout_success",
]);

export class EvidenceCohortSourceReference extends Schema.Class<EvidenceCohortSourceReference>(
  "EvidenceCohortSourceReference",
)({
  source_id: BoundedText,
  source_revision: Revision,
  trace_id: TraceId,
  span_id: SpanId,
  skill_invocation_id: BoundedText,
}) {}

export class EvidenceCohortEntry extends Schema.Class<EvidenceCohortEntry>("EvidenceCohortEntry")({
  role: CohortRole,
  source: EvidenceCohortSourceReference,
  model: Schema.optionalKey(BoundedText),
  duration_ms: MetricCount,
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
  redacted_excerpt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
}) {}

export class EvidenceCohort extends Schema.Class<EvidenceCohort>("EvidenceCohort")({
  schema_version: Schema.Literal("1.0.0"),
  selector_version: BoundedText,
  pattern: EvidenceCohortPattern,
  target_skill: EvidenceCohortTargetSkill,
  excerpt_limit_bytes: ExcerptLimit,
  request_limit_bytes: RequestLimit,
  entries: Schema.Array(EvidenceCohortEntry).check(Schema.isMaxLength(14)),
  fingerprint: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
}) {}

class EvidenceCohortMaterializationInput extends Schema.Class<EvidenceCohortMaterializationInput>(
  "EvidenceCohortMaterializationInput",
)({
  schema_version: Schema.Literal("1.0.0"),
  selector_version: BoundedText,
  pattern: EvidenceCohortPattern,
  target_skill: EvidenceCohortTargetSkill,
  source_allowlist: Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  excerpt_limit_bytes: ExcerptLimit,
  request_limit_bytes: RequestLimit,
  candidates: Schema.Array(EvidenceCohortCandidate).check(Schema.isMaxLength(512)),
}) {}

export type EvidenceCohortMaterializationRequest = typeof EvidenceCohortMaterializationInput.Type;

export class EvidencePayloadPreview extends Schema.Class<EvidencePayloadPreview>(
  "EvidencePayloadPreview",
)({
  cohort_fingerprint: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  entries: Schema.Array(EvidenceCohortEntry).check(Schema.isMaxLength(12)),
  total_bytes: MetricCount,
}) {}

type CohortRole = typeof CohortRole.Type;

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const truncateToBytes = (value: string, limit: number): string => {
  let result = "";
  for (const character of value) {
    const next = `${result}${character}`;
    if (byteLength(next) > limit) return result;
    result = next;
  }
  return result;
};

const redactExcerpt = (value: string, byteLimit: number): string =>
  truncateToBytes(
    value
      .replace(/(?:~|\/Users\/[^\s/]+|\/home\/[^\s/]+)(?:\/[^\s]*)?/g, "[REDACTED_PATH]")
      .replace(/\b(?:sk|rk|api)[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]"),
    byteLimit,
  );

const stableRank = (candidate: EvidenceCohortCandidate): string =>
  createHash("sha256")
    .update("selftune.evidence-cohort.candidate.v1")
    .update("\u0000")
    .update(candidate.trace_id)
    .update("\u0000")
    .update(candidate.span_id)
    .digest("hex");

const diversityKey = (candidate: EvidenceCohortCandidate): string =>
  `${candidate.source_id}\u0000${candidate.model ?? "unknown"}\u0000${candidate.error_count}\u0000${candidate.tool_call_count}`;

const ordered = (candidates: ReadonlyArray<EvidenceCohortCandidate>) =>
  [...candidates].toSorted((left, right) => stableRank(left).localeCompare(stableRank(right)));

const selectDiverse = (candidates: ReadonlyArray<EvidenceCohortCandidate>, maximum: number) => {
  const selected: EvidenceCohortCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered(candidates)) {
    if (!seen.has(diversityKey(candidate))) {
      selected.push(candidate);
      seen.add(diversityKey(candidate));
    }
    if (selected.length === maximum) return selected;
  }
  for (const candidate of ordered(candidates)) {
    if (!selected.includes(candidate)) selected.push(candidate);
    if (selected.length === maximum) return selected;
  }
  return selected;
};

const partition = (candidates: ReadonlyArray<EvidenceCohortCandidate>) => {
  const sorted = ordered(candidates);
  const heldout = sorted.length >= 2 ? sorted.at(-1) : undefined;
  return {
    calibration: heldout === undefined ? sorted : sorted.slice(0, -1),
    heldout,
  };
};

const toEntry = (candidate: EvidenceCohortCandidate, role: CohortRole, excerptLimitBytes: number) =>
  EvidenceCohortEntry.make({
    role,
    source: EvidenceCohortSourceReference.make({
      source_id: candidate.source_id,
      source_revision: candidate.source_revision,
      trace_id: candidate.trace_id,
      span_id: candidate.span_id,
      skill_invocation_id: candidate.skill_invocation_id,
    }),
    ...(candidate.model === undefined ? {} : { model: candidate.model }),
    duration_ms: candidate.duration_ms,
    input_tokens: candidate.input_tokens,
    output_tokens: candidate.output_tokens,
    error_count: candidate.error_count,
    tool_call_count: candidate.tool_call_count,
    ...(candidate.source_excerpt === undefined
      ? {}
      : { redacted_excerpt: redactExcerpt(candidate.source_excerpt, excerptLimitBytes) }),
  });

const fingerprint = (input: Omit<EvidenceCohort, "fingerprint">): string =>
  `sha256:${createHash("sha256")
    .update("selftune.evidence-cohort.v1")
    .update("\u0000")
    .update(JSON.stringify(input))
    .digest("hex")}`;

const boundedPayloadEntries = (cohort: EvidenceCohort): EvidenceCohortEntry[] => {
  const eligible = cohort.entries.filter(
    (entry) => entry.role !== "heldout_failure" && entry.role !== "heldout_success",
  );
  const required = [
    eligible.find((entry) => entry.role === "calibration_failure"),
    eligible.find((entry) => entry.role === "calibration_success"),
  ].filter((entry) => entry !== undefined);
  const orderedEntries = [...required, ...eligible.filter((entry) => !required.includes(entry))];
  const entries: EvidenceCohortEntry[] = [];
  for (const entry of orderedEntries) {
    const next = [...entries, entry];
    if (byteLength(JSON.stringify(next)) > cohort.request_limit_bytes) continue;
    entries.push(entry);
  }
  return entries;
};

/**
 * Materializes an immutable, bounded cohort from already selected DuckDB facts.
 * It does not read source files and never persists raw source text; adapters
 * own source-native parsing and may supply only an ephemeral text sample.
 */
export const materializeEvidenceCohort = Effect.fn("materializeEvidenceCohort")(function* (
  input: unknown,
) {
  const decoded = yield* Schema.decodeUnknownEffect(EvidenceCohortMaterializationInput)(input).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(EvidenceCohortFailure.make({ reason: "invalid_input", message: error.message })),
    ),
  );
  const allowed = new Set(decoded.source_allowlist);
  const unallowed = decoded.candidates.find((candidate) => !allowed.has(candidate.source_id));
  if (unallowed !== undefined) {
    return yield* Effect.fail(
      EvidenceCohortFailure.make({
        reason: "source_not_allowed",
        message: `Source ${unallowed.source_id} is not in the evidence allowlist.`,
      }),
    );
  }
  const failures = decoded.candidates.filter((candidate) => candidate.error_count > 0);
  const successes = decoded.candidates.filter((candidate) => candidate.error_count === 0);
  if (failures.length === 0 || successes.length === 0) {
    return yield* Effect.fail(
      EvidenceCohortFailure.make({
        reason: "insufficient_contrast",
        message:
          "A supported pattern needs at least one failed and one comparable successful execution.",
      }),
    );
  }
  const failurePartition = partition(failures);
  const successPartition = partition(successes);
  const calibrationFailures = selectDiverse(failurePartition.calibration, 5);
  const calibrationSuccesses = selectDiverse(successPartition.calibration, 5);
  if (calibrationFailures.length === 0 || calibrationSuccesses.length === 0) {
    return yield* Effect.fail(
      EvidenceCohortFailure.make({
        reason: "insufficient_contrast",
        message: "Holdout partitioning left no contrastive calibration evidence.",
      }),
    );
  }
  const usedSuccesses = new Set(calibrationSuccesses);
  if (successPartition.heldout !== undefined) usedSuccesses.add(successPartition.heldout);
  const counterexample = selectDiverse(
    successPartition.calibration.filter((candidate) => !usedSuccesses.has(candidate)),
    1,
  ).at(0);
  const entries = [
    ...calibrationFailures.map((candidate) =>
      toEntry(candidate, "calibration_failure", decoded.excerpt_limit_bytes),
    ),
    ...calibrationSuccesses.map((candidate) =>
      toEntry(candidate, "calibration_success", decoded.excerpt_limit_bytes),
    ),
    ...(counterexample === undefined
      ? []
      : [toEntry(counterexample, "counterexample", decoded.excerpt_limit_bytes)]),
    ...(failurePartition.heldout === undefined
      ? []
      : [toEntry(failurePartition.heldout, "heldout_failure", decoded.excerpt_limit_bytes)]),
    ...(successPartition.heldout === undefined
      ? []
      : [toEntry(successPartition.heldout, "heldout_success", decoded.excerpt_limit_bytes)]),
  ];
  const cohortWithoutFingerprint = {
    schema_version: decoded.schema_version,
    selector_version: decoded.selector_version,
    pattern: decoded.pattern,
    target_skill: decoded.target_skill,
    excerpt_limit_bytes: decoded.excerpt_limit_bytes,
    request_limit_bytes: decoded.request_limit_bytes,
    entries,
  };
  const cohort = EvidenceCohort.make({
    ...cohortWithoutFingerprint,
    fingerprint: fingerprint(cohortWithoutFingerprint),
  });
  const previewEntries = boundedPayloadEntries(cohort);
  if (
    !previewEntries.some((entry) => entry.role === "calibration_failure") ||
    !previewEntries.some((entry) => entry.role === "calibration_success")
  ) {
    return yield* Effect.fail(
      EvidenceCohortFailure.make({
        reason: "request_limit_exceeded",
        message: "The request-byte limit cannot carry one calibration failure and success.",
      }),
    );
  }
  return cohort;
});

/** The exact bounded payload eligible to cross a teacher/provider boundary. */
export const buildEvidencePayloadPreview = (cohort: EvidenceCohort): EvidencePayloadPreview => {
  const entries = boundedPayloadEntries(cohort);
  const totalBytes = byteLength(JSON.stringify(entries));
  return EvidencePayloadPreview.make({
    cohort_fingerprint: cohort.fingerprint,
    entries,
    total_bytes: totalBytes,
  });
};
