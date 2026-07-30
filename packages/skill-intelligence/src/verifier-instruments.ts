import { createHash } from "node:crypto";

import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_000));

export const VerifierInstrumentKind = Schema.Literals(["deterministic", "judge"]);
export const VerifierControlLabel = Schema.Literals([
  "known_failure",
  "known_good",
  "boundary",
  "adversarial",
]);
export const VerifierControlDecision = Schema.Literals(["accept", "reject"]);
export const VerifierQualificationPartition = Schema.Literals([
  "verifier_calibration",
  "candidate_calibration",
  "selection",
  "audit",
]);

/**
 * A first-class verifier definition. This artifact describes checking only;
 * it contains neither a candidate mutation nor a replay outcome.
 */
export const VerifierInstrument = Schema.Struct({
  verifier_id: Identifier,
  version: Identifier,
  kind: VerifierInstrumentKind,
  success_contract: BoundedText,
  check_description: BoundedText,
});
export type VerifierInstrument = typeof VerifierInstrument.Type;

/** A labeled, isolated control used to qualify an instrument before use. */
export const VerifierQualificationEvidence = Schema.Struct({
  evidence_id: Identifier,
  label: VerifierControlLabel,
  expected_decision: VerifierControlDecision,
  observed_decision: VerifierControlDecision,
  partition: VerifierQualificationPartition,
  candidate_strategy_reference: Schema.NullOr(Identifier),
});
export type VerifierQualificationEvidence = typeof VerifierQualificationEvidence.Type;

export const VerifierQualificationInput = Schema.Struct({
  instrument: VerifierInstrument,
  evidence: Schema.Array(VerifierQualificationEvidence).check(Schema.isMaxLength(64)),
});
export type VerifierQualificationInput = typeof VerifierQualificationInput.Type;

export const VerifierQualificationStatus = Schema.Literals(["qualified", "rejected"]);
export const VerifierQualificationReason = Schema.Literals([
  "qualified",
  "judge_requires_separate_qualification",
  "missing_labeled_control",
  "misclassified_control",
  "candidate_strategy_leakage",
  "duplicate_evidence_id",
]);

export const VerifierQualificationResult = Schema.Struct({
  qualification_id: Identifier,
  manifest_id: Identifier,
  instrument: VerifierInstrument,
  status: VerifierQualificationStatus,
  reasons: Schema.Array(VerifierQualificationReason),
  control_counts: Schema.Struct({
    known_failure: Schema.Number,
    known_good: Schema.Number,
    boundary: Schema.Number,
    adversarial: Schema.Number,
  }),
  replay_status: Schema.Literal("not_attempted"),
});
export type VerifierQualificationResult = typeof VerifierQualificationResult.Type;

const labels: ReadonlyArray<typeof VerifierControlLabel.Type> = [
  "known_failure",
  "known_good",
  "boundary",
  "adversarial",
];

function canonicalManifest(input: VerifierQualificationInput): string {
  return JSON.stringify({
    instrument: input.instrument,
    evidence: input.evidence
      .map((control) => ({
        evidence_id: control.evidence_id,
        label: control.label,
        expected_decision: control.expected_decision,
        observed_decision: control.observed_decision,
        partition: control.partition,
        candidate_strategy_reference: control.candidate_strategy_reference,
      }))
      .toSorted((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  });
}

function stableId(prefix: string, canonical: string): string {
  return `${prefix}-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function controlCounts(
  evidence: ReadonlyArray<VerifierQualificationEvidence>,
): VerifierQualificationResult["control_counts"] {
  return {
    known_failure: evidence.filter((control) => control.label === "known_failure").length,
    known_good: evidence.filter((control) => control.label === "known_good").length,
    boundary: evidence.filter((control) => control.label === "boundary").length,
    adversarial: evidence.filter((control) => control.label === "adversarial").length,
  };
}

function reasonSet(
  input: VerifierQualificationInput,
): Array<typeof VerifierQualificationReason.Type> {
  const reasons = new Set<typeof VerifierQualificationReason.Type>();
  if (input.instrument.kind === "judge") reasons.add("judge_requires_separate_qualification");

  const ids = input.evidence.map((control) => control.evidence_id);
  if (new Set(ids).size !== ids.length) reasons.add("duplicate_evidence_id");

  for (const label of labels) {
    if (!input.evidence.some((control) => control.label === label)) {
      reasons.add("missing_labeled_control");
    }
  }

  if (
    input.evidence.some(
      (control) =>
        control.partition !== "verifier_calibration" ||
        control.candidate_strategy_reference !== null,
    )
  ) {
    reasons.add("candidate_strategy_leakage");
  }

  if (
    input.evidence.some(
      (control) =>
        control.expected_decision !== control.observed_decision ||
        (control.label === "known_failure" && control.expected_decision !== "reject") ||
        (control.label === "known_good" && control.expected_decision !== "accept"),
    )
  ) {
    reasons.add("misclassified_control");
  }

  return [...reasons].toSorted();
}

/**
 * Qualifies deterministic verifiers only. It intentionally does not execute
 * a replay or make a claim about a candidate; those require a frozen study.
 */
export function qualifyVerifierInstrument(
  input: VerifierQualificationInput,
): VerifierQualificationResult {
  const manifest = canonicalManifest(input);
  const reasons = reasonSet(input);
  return VerifierQualificationResult.make({
    qualification_id: stableId("verifier-qualification", manifest),
    manifest_id: stableId("verifier-manifest", manifest),
    instrument: input.instrument,
    status: reasons.length === 0 ? "qualified" : "rejected",
    reasons: reasons.length === 0 ? ["qualified"] : reasons,
    control_counts: controlCounts(input.evidence),
    replay_status: "not_attempted",
  });
}
