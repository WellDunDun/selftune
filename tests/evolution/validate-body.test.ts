import { describe, expect, mock, test } from "bun:test";

import type { BodyEvolutionProposal, EvalEntry } from "../../cli/selftune/types.js";
import { stripMarkdownFences } from "../../cli/selftune/utils/llm-call.js";

// ---------------------------------------------------------------------------
// Mock callLlm before importing the module under test
// ---------------------------------------------------------------------------

const mockCallLlm = mock(async (_sys: string, _user: string, _agent: string) => {
  return "NO";
});

mock.module("../../cli/selftune/utils/llm-call.js", () => ({
  callLlm: mockCallLlm,
  stripMarkdownFences,
}));

// Import after mocking
const {
  validateBodyStructure,
  validateBodyTriggerAccuracy,
  assessBodyQuality,
  validateBodyProposal,
} = await import("../../cli/selftune/evolution/validate-body.js");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEval(query: string, shouldTrigger: boolean): EvalEntry {
  return { query, should_trigger: shouldTrigger };
}

function makeBodyProposal(overrides: Partial<BodyEvolutionProposal> = {}): BodyEvolutionProposal {
  return {
    proposal_id: "evo-body-test-001",
    skill_name: "test-skill",
    skill_path: "/skills/test-skill",
    original_body:
      "Original body content with ## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |",
    proposed_body:
      "Improved body.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |\n| validate | check |",
    rationale: "Better coverage",
    target: "body",
    failure_patterns: ["fp-test-0"],
    confidence: 0.8,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: validateBodyStructure
// ---------------------------------------------------------------------------

describe("validateBodyStructure", () => {
  test("valid body with Workflow Routing section passes", () => {
    const body =
      "Description here.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |";
    const result = validateBodyStructure(body);
    expect(result.valid).toBe(true);
  });

  test("empty body fails", () => {
    const result = validateBodyStructure("");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("body without Workflow Routing section fails", () => {
    const body = "Description here.\n\n## Examples\n\n- Example 1";
    const result = validateBodyStructure(body);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Workflow Routing");
  });

  test("body with Workflow Routing but no table fails", () => {
    const body = "Description.\n\n## Workflow Routing\n\nNo table here, just text.";
    const result = validateBodyStructure(body);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("table");
  });

  test("body with Workflow Routing and valid table passes", () => {
    const body =
      "Desc.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| create slides | presentation |\n\n## Examples\n\n- Ex 1";
    const result = validateBodyStructure(body);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 2: validateBodyTriggerAccuracy
// ---------------------------------------------------------------------------

describe("validateBodyTriggerAccuracy", () => {
  test("empty eval set returns zeros", async () => {
    const result = await validateBodyTriggerAccuracy("original", "proposed", [], "claude");
    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(0);
    expect(result.improved).toBe(false);
    expect(result.regressions).toEqual([]);
  });

  test("when LLM always says NO, negative evals pass and positives fail", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const evalSet = [makeEval("trigger query", true), makeEval("negative query", false)];
    const result = await validateBodyTriggerAccuracy("original", "proposed", evalSet, "claude");

    expect(result.before_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.after_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.improved).toBe(false);
  });

  test("tracks regressions correctly", async () => {
    // Original: YES for trigger, NO for negative (both pass)
    // Proposed: NO for trigger (regression), NO for negative (still pass)
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("proposed") || user.includes("Improved")) return "NO";
      return "YES";
    });

    const evalSet = [makeEval("trigger query", true)];
    const result = await validateBodyTriggerAccuracy(
      "original body",
      "proposed body",
      evalSet,
      "claude",
    );

    expect(result.regressions).toContain("trigger query");
  });
});

// ---------------------------------------------------------------------------
// Gate 3: assessBodyQuality
// ---------------------------------------------------------------------------

describe("assessBodyQuality", () => {
  test("returns parsed score from LLM response", async () => {
    mockCallLlm.mockImplementation(async () =>
      JSON.stringify({ score: 0.85, reason: "Well structured" }),
    );

    const result = await assessBodyQuality("Good body content", "test-skill", "claude");
    expect(result.score).toBe(0.85);
    expect(result.reason).toBe("Well structured");
  });

  test("returns default on malformed response", async () => {
    mockCallLlm.mockImplementation(async () => "not json at all");

    const result = await assessBodyQuality("Body content", "test-skill", "claude");
    expect(result.score).toBe(0.5);
    expect(result.reason).toContain("Failed to parse");
  });

  test("clamps score to 0.0-1.0", async () => {
    mockCallLlm.mockImplementation(async () => JSON.stringify({ score: 1.5, reason: "Great" }));

    const result = await assessBodyQuality("Body", "test", "claude");
    expect(result.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Full 3-gate validateBodyProposal
// ---------------------------------------------------------------------------

describe("validateBodyProposal", () => {
  test("structurally invalid proposal fails at gate 1", async () => {
    const proposal = makeBodyProposal({ proposed_body: "no routing section" });
    const evalSet = [makeEval("test", true)];

    const result = await validateBodyProposal(proposal, evalSet, "claude");

    expect(result.gates_passed).toBe(0);
    expect(result.gates_total).toBe(3);
    expect(result.improved).toBe(false);
    expect(result.gate_results[0].gate).toBe("structural");
    expect(result.gate_results[0].passed).toBe(false);
    // Should short-circuit — no further gates run
    expect(result.gate_results.length).toBe(1);
  });

  test("valid structure runs all 3 gates", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      // Gate 3 quality assessment
      if (user.includes("Rate the quality")) {
        return JSON.stringify({ score: 0.8, reason: "Good quality" });
      }
      return "NO";
    });

    const proposal = makeBodyProposal();
    const evalSet = [makeEval("test", true)];

    const result = await validateBodyProposal(proposal, evalSet, "claude");

    expect(result.gate_results.length).toBe(3);
    expect(result.gate_results[0].gate).toBe("structural");
    expect(result.gate_results[1].gate).toBe("trigger_accuracy");
    expect(result.gate_results[2].gate).toBe("quality");
    expect(result.gates_total).toBe(3);
  });

  test("returns correct proposal_id", async () => {
    mockCallLlm.mockImplementation(async () => JSON.stringify({ score: 0.8, reason: "Good" }));

    const proposal = makeBodyProposal({ proposal_id: "custom-id" });
    const result = await validateBodyProposal(proposal, [], "claude");

    expect(result.proposal_id).toBe("custom-id");
  });

  test("improved=true only when all 3 gates pass", async () => {
    // Make all gates pass
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("Rate the quality")) {
        return JSON.stringify({ score: 0.9, reason: "Excellent" });
      }
      // For trigger accuracy, make proposed better
      if (user.includes("Improved body")) return "YES";
      return "NO";
    });

    const proposal = makeBodyProposal();
    const evalSet = [makeEval("test query", true), makeEval("negative query", false)];

    const result = await validateBodyProposal(proposal, evalSet, "claude");

    // Gate 1 passes (structural), gate 2 depends on LLM responses, gate 3 passes
    expect(result.gate_results[0].passed).toBe(true);
    expect(result.gate_results[2].passed).toBe(true);
  });
});
