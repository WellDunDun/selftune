import { describe, expect, mock, test } from "bun:test";
import type { BodyEvolutionProposal, BodyValidationResult } from "../../cli/selftune/types.js";
import { stripMarkdownFences } from "../../cli/selftune/utils/llm-call.js";
import {
  buildRefinementPrompt,
  BODY_REFINER_SYSTEM,
  parseRefinementResponse,
} from "../../cli/selftune/evolution/refine-body.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<BodyEvolutionProposal> = {}): BodyEvolutionProposal {
  return {
    proposal_id: "evo-body-test-001",
    skill_name: "test-skill",
    skill_path: "/skills/test-skill",
    original_body: "Original body",
    proposed_body: "Proposed body with issues",
    rationale: "Initial attempt",
    target: "body",
    failure_patterns: ["fp-test-0"],
    confidence: 0.7,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeValidation(overrides: Partial<BodyValidationResult> = {}): BodyValidationResult {
  return {
    proposal_id: "evo-body-test-001",
    gates_passed: 1,
    gates_total: 3,
    gate_results: [
      { gate: "structural", passed: true, reason: "Passed" },
      { gate: "trigger_accuracy", passed: false, reason: "Not improved: 50% -> 50%" },
      { gate: "quality", passed: false, reason: "Quality score: 0.4 (threshold: 0.6)" },
    ],
    improved: false,
    regressions: ["query that broke"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BODY_REFINER_SYSTEM
// ---------------------------------------------------------------------------

describe("BODY_REFINER_SYSTEM", () => {
  test("contains key instructions about refinement and JSON", () => {
    expect(BODY_REFINER_SYSTEM.toLowerCase()).toContain("refin");
    expect(BODY_REFINER_SYSTEM.toLowerCase()).toContain("json");
    expect(BODY_REFINER_SYSTEM.toLowerCase()).toContain("validation");
  });
});

// ---------------------------------------------------------------------------
// buildRefinementPrompt
// ---------------------------------------------------------------------------

describe("buildRefinementPrompt", () => {
  test("includes skill name", () => {
    const prompt = buildRefinementPrompt("body", makeValidation(), "test-skill");
    expect(prompt).toContain("test-skill");
  });

  test("includes proposed body", () => {
    const prompt = buildRefinementPrompt("Proposed body content", makeValidation(), "test-skill");
    expect(prompt).toContain("Proposed body content");
  });

  test("includes failed gate reasons", () => {
    const prompt = buildRefinementPrompt("body", makeValidation(), "test-skill");
    expect(prompt).toContain("trigger_accuracy");
    expect(prompt).toContain("Not improved");
    expect(prompt).toContain("quality");
    expect(prompt).toContain("Quality score");
  });

  test("does not include passed gates in failed section", () => {
    const prompt = buildRefinementPrompt("body", makeValidation(), "test-skill");
    // The structural gate passed, so its reason should NOT be in the "Failed" list
    expect(prompt).toContain("Failed Validation Gates");
    // Should have 2 failed gates listed
    const failedLines = prompt.split("Failed Validation Gates")[1].split("\n").filter((l: string) => l.includes("- "));
    expect(failedLines.length).toBe(2);
  });

  test("includes regression queries when provided", () => {
    const prompt = buildRefinementPrompt("body", makeValidation(), "test-skill", ["query that broke"]);
    expect(prompt).toContain("Regression Queries");
    expect(prompt).toContain("query that broke");
  });

  test("omits regression section when no regressions", () => {
    const prompt = buildRefinementPrompt("body", makeValidation(), "test-skill", []);
    expect(prompt).not.toContain("Regression Queries");
  });
});

// ---------------------------------------------------------------------------
// parseRefinementResponse
// ---------------------------------------------------------------------------

describe("parseRefinementResponse", () => {
  test("handles valid JSON", () => {
    const raw = JSON.stringify({
      refined_body: "Better body content",
      changes_made: "Fixed routing table",
      confidence: 0.85,
    });
    const result = parseRefinementResponse(raw);
    expect(result.refined_body).toBe("Better body content");
    expect(result.changes_made).toBe("Fixed routing table");
    expect(result.confidence).toBe(0.85);
  });

  test("handles markdown-fenced JSON", () => {
    const raw =
      '```json\n{"refined_body":"body","changes_made":"changes","confidence":0.7}\n```';
    const result = parseRefinementResponse(raw);
    expect(result.refined_body).toBe("body");
    expect(result.confidence).toBe(0.7);
  });

  test("throws on malformed input", () => {
    expect(() => parseRefinementResponse("not valid json")).toThrow();
  });

  test("throws on missing required fields", () => {
    const raw = JSON.stringify({ refined_body: "only this" });
    expect(() => parseRefinementResponse(raw)).toThrow();
  });

  test("clamps confidence above 1.0 to 1.0", () => {
    const raw = JSON.stringify({
      refined_body: "body",
      changes_made: "changes",
      confidence: 1.5,
    });
    const result = parseRefinementResponse(raw);
    expect(result.confidence).toBe(1.0);
  });

  test("clamps confidence below 0.0 to 0.0", () => {
    const raw = JSON.stringify({
      refined_body: "body",
      changes_made: "changes",
      confidence: -0.3,
    });
    const result = parseRefinementResponse(raw);
    expect(result.confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// refineBodyProposal (mocked LLM)
// ---------------------------------------------------------------------------

describe("refineBodyProposal", () => {
  test("returns refined proposal with updated body", async () => {
    const mockResponse = JSON.stringify({
      refined_body: "Refined and improved body",
      changes_made: "Fixed trigger accuracy",
      confidence: 0.9,
    });

    mock.module("../../cli/selftune/utils/llm-call.js", () => ({
      callLlm: async () => mockResponse,
      stripMarkdownFences,
    }));

    const { refineBodyProposal: mockedRefine } = await import(
      "../../cli/selftune/evolution/refine-body.js"
    );

    const proposal = makeProposal();
    const validation = makeValidation();

    const refined = await mockedRefine(proposal, validation, "claude");

    expect(refined.proposal_id).toContain("refined");
    expect(refined.proposed_body).toBe("Refined and improved body");
    expect(refined.rationale).toContain("Refinement: Fixed trigger accuracy");
    expect(refined.confidence).toBe(0.9);
    expect(refined.skill_name).toBe("test-skill");
    expect(refined.status).toBe("pending");
  });
});
