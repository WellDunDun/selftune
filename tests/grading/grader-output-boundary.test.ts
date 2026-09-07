import { describe, expect, test } from "bun:test";
import { parseGraderOutput } from "../../packages/runtime/grading/grade-session.js";
import type { GraderOutput } from "../../packages/runtime/types/grading.js";

const output: GraderOutput = {
  expectations: [{ text: "writes the campaign", passed: false, evidence: "no output", score: 0.2 }],
  summary: { passed: 0, failed: 1, total: 1, pass_rate: 0, mean_score: 0.2 },
  claims: [
    { claim: "campaign was written", type: "process", verified: false, evidence: "no output" },
  ],
  eval_feedback: {
    suggestions: [{ assertion: "includes a headline", reason: "expected output" }],
    overall: "Incomplete",
  },
  failure_feedback: [
    {
      query: "write a campaign",
      failure_reason: "no output",
      improvement_hint: "write the copy",
      invocation_type: "explicit",
    },
  ],
};

describe("grader output boundary", () => {
  test("decodes complete output and preserves false values, evidence, and feedback", () => {
    expect(parseGraderOutput(JSON.stringify(output))).toEqual(output);
    expect(parseGraderOutput(`\x60\x60\x60json\n${JSON.stringify(output)}\n\x60\x60\x60`)).toEqual(
      output,
    );
  });

  test.each([
    { raw: "null" },
    { raw: "[]" },
    { raw: "{}" },
    { raw: "{" },
    {
      raw: JSON.stringify({
        ...output,
        expectations: [{ text: "writes the campaign", passed: "true", evidence: "none" }],
      }),
    },
    {
      raw: JSON.stringify({
        ...output,
        claims: [{ claim: "written", type: "unknown", verified: true, evidence: "none" }],
      }),
    },
    {
      raw: JSON.stringify({
        ...output,
        eval_feedback: { suggestions: ["missing reason"], overall: "Incomplete" },
      }),
    },
    {
      raw: JSON.stringify({
        ...output,
        failure_feedback: [
          {
            query: "campaign",
            failure_reason: "none",
            improvement_hint: "write",
            invocation_type: "invalid",
          },
        ],
      }),
    },
  ])("rejects malformed grader results: $raw", ({ raw }) => {
    expect(() => parseGraderOutput(raw)).toThrow("not valid grader JSON");
  });

  test("allows omitted optional scores and feedback", () => {
    const { failure_feedback: _feedback, ...withoutFeedback } = output;
    const minimal = {
      ...withoutFeedback,
      expectations: [{ text: "campaign", passed: false, evidence: "none" }],
    };
    expect(parseGraderOutput(JSON.stringify(minimal))).toEqual(minimal);
  });

  test("does not include raw transcript-derived content in the error message", () => {
    const raw = "private session excerpt, not JSON";
    try {
      parseGraderOutput(raw);
      throw new Error("Expected a grading parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("not valid grader JSON");
      expect(String(error)).not.toContain(raw);
    }
  });
});
