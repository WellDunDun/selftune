import { describe, expect, it } from "vitest";
import * as Result from "effect/Result";
import { decodeEvidenceCasesJson, decodeEvidenceValidationJson } from "../src/evidence";

describe("local evidence read contract", () => {
  it("reads current nested results and historical flat aliases and regression text", () => {
    const validation = {
      before_pass_rate: 0.5,
      after_pass_rate: 0.75,
      net_change: 0.25,
      regressions: ["historical regression"],
      new_passes: [{ query: "flat", should_trigger: false }],
      per_entry_results: [
        { entry: { query: "nested", should_trigger: true }, before_pass: false, after_pass: true },
        { prompt: "older prompt", baseline: true, result: false },
        { input: "input alias", passed: true },
      ],
      gate_results: [{ gate: "routing", passed: false, reason: "Regression" }],
    };
    const decoded = decodeEvidenceValidationJson(JSON.stringify(validation));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) throw new Error("Fixture did not decode");
    expect(decoded.success.regressions).toEqual([{ query: "historical regression" }]);
    expect(decoded.success.per_entry_results).toEqual(validation.per_entry_results);
    expect(decoded.success.gate_results).toEqual(validation.gate_results);
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"after_pass_rate":"0.9"}',
    '{"per_entry_results":[{"passed":"false"}]}',
  ])("rejects unreadable validation %s", (json) =>
    expect(Result.isFailure(decodeEvidenceValidationJson(json))).toBe(true),
  );

  it("accepts historical null optionals without coercing missing results into failures", () => {
    const decoded = decodeEvidenceCasesJson(
      '[{"query":"not measured","result":null,"expected":false}]',
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) throw new Error("Fixture did not decode");
    expect(decoded.success).toEqual([{ query: "not measured", result: null, expected: false }]);
    expect(Result.isFailure(decodeEvidenceCasesJson('[{"query":12}]'))).toBe(true);
  });
});
