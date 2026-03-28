import { describe, expect, test } from "bun:test";

import {
  scoreDescription,
  scoreLengthCriterion,
  scoreNotJustNameCriterion,
  scoreSpecificityCriterion,
  scoreTriggerContextCriterion,
  scoreVaguenessCriterion,
} from "../../cli/selftune/evolution/description-quality.js";

// ---------------------------------------------------------------------------
// scoreLengthCriterion
// ---------------------------------------------------------------------------

describe("scoreLengthCriterion", () => {
  test("very short description scores low", () => {
    expect(scoreLengthCriterion("hi")).toBeLessThan(0.2);
  });

  test("ideal length scores 1.0", () => {
    const desc =
      "Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior.";
    expect(scoreLengthCriterion(desc)).toBe(1.0);
  });

  test("overly long description scores below 1.0", () => {
    const desc = "a".repeat(600);
    expect(scoreLengthCriterion(desc)).toBeLessThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// scoreTriggerContextCriterion
// ---------------------------------------------------------------------------

describe("scoreTriggerContextCriterion", () => {
  test("no trigger context scores 0", () => {
    expect(scoreTriggerContextCriterion("Run the verification stack")).toBe(0.0);
  });

  test("one trigger word scores 0.7", () => {
    expect(scoreTriggerContextCriterion("Run verification when code changes")).toBe(0.7);
  });

  test("multiple trigger words score higher", () => {
    const score = scoreTriggerContextCriterion(
      "Use when code changes, if tests fail, or after deployment",
    );
    expect(score).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// scoreVaguenessCriterion
// ---------------------------------------------------------------------------

describe("scoreVaguenessCriterion", () => {
  test("no vague words scores 1.0", () => {
    expect(scoreVaguenessCriterion("Deploy TypeScript CLI to production")).toBe(1.0);
  });

  test("one vague word scores 0.6", () => {
    expect(scoreVaguenessCriterion("Handle various deployment tasks")).toBe(0.6);
  });

  test("multiple vague words score lower", () => {
    const score = scoreVaguenessCriterion("Handle various general things and more stuff etc");
    expect(score).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// scoreSpecificityCriterion
// ---------------------------------------------------------------------------

describe("scoreSpecificityCriterion", () => {
  test("description with action verb scores high", () => {
    expect(scoreSpecificityCriterion("Analyze code for security vulnerabilities")).toBeGreaterThan(
      0.7,
    );
  });

  test("description without action verb scores low", () => {
    expect(scoreSpecificityCriterion("A great tool for productivity")).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// scoreNotJustNameCriterion
// ---------------------------------------------------------------------------

describe("scoreNotJustNameCriterion", () => {
  test("description identical to skill name scores 0", () => {
    expect(scoreNotJustNameCriterion("my-skill", "my-skill")).toBe(0.0);
  });

  test("description identical to kebab-expanded name scores 0", () => {
    expect(scoreNotJustNameCriterion("my skill", "my-skill")).toBe(0.0);
  });

  test("slightly longer than name scores 0.3", () => {
    expect(scoreNotJustNameCriterion("my skill tool", "my-skill")).toBe(0.3);
  });

  test("rich description scores 1.0", () => {
    expect(
      scoreNotJustNameCriterion(
        "Analyze TypeScript code for security vulnerabilities when PRs are opened",
        "security-scan",
      ),
    ).toBe(1.0);
  });

  test("no skill name provided scores 1.0", () => {
    expect(scoreNotJustNameCriterion("anything")).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// scoreDescription (composite)
// ---------------------------------------------------------------------------

describe("scoreDescription", () => {
  test("high-quality description from OpenAI blog scores above 0.7", () => {
    const result = scoreDescription(
      "Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior.",
      "code-change-verification",
    );
    expect(result.composite).toBeGreaterThan(0.7);
    expect(result.criteria.trigger_context).toBeGreaterThan(0.0);
    expect(result.criteria.vagueness).toBe(1.0);
    expect(result.criteria.specificity).toBeGreaterThan(0.7);
  });

  test("description without trigger context scores below good one", () => {
    const noContext = scoreDescription("Run the verification stack", "code-change-verification");
    const withContext = scoreDescription(
      "Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior.",
      "code-change-verification",
    );
    expect(noContext.composite).toBeLessThan(withContext.composite);
    expect(noContext.criteria.trigger_context).toBe(0.0);
  });

  test("vague description with no trigger context scores low", () => {
    const result = scoreDescription(
      "Handles various things and stuff related to general tasks and more",
      "my-skill",
    );
    expect(result.composite).toBeLessThan(0.4);
  });

  test("returns all criteria fields in breakdown", () => {
    const result = scoreDescription("test description", "test");
    expect(result.criteria).toHaveProperty("length");
    expect(result.criteria).toHaveProperty("trigger_context");
    expect(result.criteria).toHaveProperty("vagueness");
    expect(result.criteria).toHaveProperty("specificity");
    expect(result.criteria).toHaveProperty("not_just_name");
    expect(typeof result.composite).toBe("number");
  });

  test("composite is between 0 and 1", () => {
    const descriptions = [
      "",
      "x",
      "Run the mandatory verification stack when changes affect runtime code.",
      "a".repeat(1000),
    ];
    for (const desc of descriptions) {
      const result = scoreDescription(desc);
      expect(result.composite).toBeGreaterThanOrEqual(0.0);
      expect(result.composite).toBeLessThanOrEqual(1.0);
    }
  });

  test("improved OpenAI description scores higher than original", () => {
    const original = scoreDescription("Run the mandatory verification stack.", "code-verification");
    const improved = scoreDescription(
      "Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior.",
      "code-verification",
    );
    expect(improved.composite).toBeGreaterThan(original.composite);
  });
});
