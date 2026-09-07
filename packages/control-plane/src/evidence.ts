import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

// Read contract for current and historical local evaluation evidence. Writers
// retain their stricter contracts; aliases here belong to the persisted format.
const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const optionalFlag = Schema.optional(Schema.NullOr(Schema.Boolean));
const optionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

const EvidenceQuery = Schema.Struct({
  query: optionalText,
  should_trigger: optionalFlag,
  invocation_type: optionalText,
});

export const EvidenceCase = Schema.Struct({
  ...EvidenceQuery.fields,
  entry: Schema.optional(Schema.NullOr(EvidenceQuery)),
  prompt: optionalText,
  input: optionalText,
  text: optionalText,
  expected: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Boolean, Schema.Number])),
  ),
  before_pass: optionalFlag,
  before: optionalFlag,
  original_triggered: optionalFlag,
  baseline: optionalFlag,
  after_pass: optionalFlag,
  after: optionalFlag,
  triggered: optionalFlag,
  result: optionalFlag,
  passed: optionalFlag,
  matched: optionalFlag,
  source: optionalText,
  created_at: optionalText,
});
export type EvidenceCase = typeof EvidenceCase.Type;

const TextEvidenceCase = Schema.String.pipe(
  Schema.decodeTo(Schema.Struct({ query: Schema.String }), {
    decode: SchemaGetter.transform((query) => ({ query })),
    encode: SchemaGetter.transform((entry) => entry.query),
  }),
);
const HistoricalEvidenceCase = Schema.Union([EvidenceCase, TextEvidenceCase]);
const cases = Schema.optional(Schema.NullOr(Schema.Array(HistoricalEvidenceCase)));

export const EvidenceValidation = Schema.Struct({
  improved: optionalFlag,
  before_pass_rate: optionalNumber,
  after_pass_rate: optionalNumber,
  net_change: optionalNumber,
  regressions: cases,
  new_passes: cases,
  per_entry_results: cases,
  before_entry_results: cases,
  gates_passed: optionalNumber,
  gates_total: optionalNumber,
  gate_results: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          gate: Schema.String,
          passed: Schema.Boolean,
          reason: Schema.String,
        }),
      ),
    ),
  ),
  validation_mode: optionalText,
  validation_agent: optionalText,
  validation_fixture_id: optionalText,
  validation_fallback_reason: optionalText,
  validation_evidence_ref: optionalText,
  total: optionalNumber,
  passed: optionalNumber,
  failed: optionalNumber,
  pass_rate: optionalNumber,
});
export type EvidenceValidation = typeof EvidenceValidation.Type;

export const decodeEvidenceValidation = Schema.decodeUnknownResult(EvidenceValidation);
export const decodeEvidenceCases = Schema.decodeUnknownResult(Schema.Array(HistoricalEvidenceCase));
export const decodeEvidenceValidationJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(EvidenceValidation),
);
export const decodeEvidenceCasesJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(HistoricalEvidenceCase)),
);
