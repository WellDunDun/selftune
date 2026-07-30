import { describe, expect, test } from "bun:test";

import {
  qualifyVerifierInstrument,
  type VerifierQualificationInput,
} from "@selftune/skill-intelligence/verifier-instruments";

const input: VerifierQualificationInput = {
  instrument: {
    verifier_id: "portal-status",
    version: "v1",
    kind: "deterministic",
    success_contract: "Only report an upload after the portal confirms completed status.",
    check_description: "Require the completed portal status artifact.",
  },
  evidence: [
    {
      evidence_id: "failure-1",
      label: "known_failure",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "good-1",
      label: "known_good",
      expected_decision: "accept",
      observed_decision: "accept",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "boundary-1",
      label: "boundary",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "adversarial-1",
      label: "adversarial",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
  ],
};

describe("verifier instrument qualification", () => {
  test("qualifies a deterministic instrument only after all isolated labeled controls pass", () => {
    const result = qualifyVerifierInstrument(input);

    expect(result).toMatchObject({
      status: "qualified",
      reasons: ["qualified"],
      control_counts: { known_failure: 1, known_good: 1, boundary: 1, adversarial: 1 },
      replay_status: "not_attempted",
    });
    expect(result.manifest_id).toMatch(/^verifier-manifest-/);
    expect(result.qualification_id).toMatch(/^verifier-qualification-/);
  });

  test("rejects missing and misclassified controls without claiming qualification", () => {
    const result = qualifyVerifierInstrument({
      ...input,
      evidence: input.evidence
        .filter((control) => control.label !== "adversarial")
        .map((control) =>
          control.label === "known_failure" ? { ...control, observed_decision: "accept" } : control,
        ),
    });

    expect(result).toMatchObject({ status: "rejected", replay_status: "not_attempted" });
    expect(result.reasons).toEqual(["misclassified_control", "missing_labeled_control"]);

    const mislabeledKnownFailure = qualifyVerifierInstrument({
      ...input,
      evidence: input.evidence.map((control) =>
        control.label === "known_failure"
          ? { ...control, expected_decision: "accept", observed_decision: "accept" }
          : control,
      ),
    });
    expect(mislabeledKnownFailure.reasons).toEqual(["misclassified_control"]);
  });

  test("rejects candidate-strategy leakage from either a reference or non-verifier partition", () => {
    const result = qualifyVerifierInstrument({
      ...input,
      evidence: [
        { ...input.evidence[0]!, candidate_strategy_reference: "candidate-1" },
        { ...input.evidence[1]!, partition: "selection" },
        input.evidence[2]!,
        input.evidence[3]!,
      ],
    });

    expect(result).toMatchObject({
      status: "rejected",
      reasons: ["candidate_strategy_leakage"],
    });
  });

  test("distinguishes judge instruments and sends them to a separate qualification lane", () => {
    const result = qualifyVerifierInstrument({
      ...input,
      instrument: { ...input.instrument, kind: "judge" },
    });

    expect(result).toMatchObject({
      status: "rejected",
      reasons: ["judge_requires_separate_qualification"],
      replay_status: "not_attempted",
    });
  });

  test("uses immutable IDs regardless of control ordering", () => {
    const first = qualifyVerifierInstrument(input);
    const second = qualifyVerifierInstrument({
      ...input,
      evidence: input.evidence.toReversed(),
    });

    expect(second.manifest_id).toBe(first.manifest_id);
    expect(second.qualification_id).toBe(first.qualification_id);
  });
});
