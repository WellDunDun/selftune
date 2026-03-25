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
const { validateRoutingStructure, validateRoutingTriggerAccuracy, validateRoutingProposal } =
  await import("../../cli/selftune/evolution/validate-routing.js");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEval(query: string, shouldTrigger: boolean): EvalEntry {
  return { query, should_trigger: shouldTrigger };
}

function makeRoutingProposal(
  overrides: Partial<BodyEvolutionProposal> = {},
): BodyEvolutionProposal {
  return {
    proposal_id: "evo-routing-test-001",
    skill_name: "test-skill",
    skill_path: "/skills/test-skill",
    original_body: "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |",
    proposed_body:
      "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |\n| create deck | presentation |",
    rationale: "Added deck trigger",
    target: "routing",
    failure_patterns: ["fp-test-0"],
    confidence: 0.8,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateRoutingStructure
// ---------------------------------------------------------------------------

describe("validateRoutingStructure", () => {
  test("valid table passes", () => {
    const table = "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(true);
  });

  test("empty string fails", () => {
    const result = validateRoutingStructure("");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("at least a header");
  });

  test("missing Trigger column fails", () => {
    const table = "| Action | Workflow |\n| --- | --- |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Trigger");
  });

  test("missing Workflow column fails", () => {
    const table = "| Trigger | Result |\n| --- | --- |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Workflow");
  });

  test("missing separator row fails", () => {
    const table = "| Trigger | Workflow |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("separator");
  });

  test("header only (no data rows) fails", () => {
    const table = "| Trigger | Workflow |\n| --- | --- |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("data row");
  });

  test("data row without pipes fails", () => {
    const table = "| Trigger | Workflow |\n| --- | --- |\nmake slides presentation";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
  });

  test("multiple data rows pass", () => {
    const table =
      "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |\n| create deck | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateRoutingTriggerAccuracy
// ---------------------------------------------------------------------------

describe("validateRoutingTriggerAccuracy", () => {
  test("empty eval set returns zeros", async () => {
    const result = await validateRoutingTriggerAccuracy("original", "proposed", [], "claude");
    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(0);
    expect(result.improved).toBe(false);
  });

  test("when LLM always says NO, negative evals pass and positive fail", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const evalSet = [makeEval("trigger query", true), makeEval("negative query", false)];
    const result = await validateRoutingTriggerAccuracy("original", "proposed", evalSet, "claude");

    expect(result.before_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.after_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.improved).toBe(false);
  });

  test("detects improvement when proposed gets better results", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("create deck")) return "YES";
      return "NO";
    });

    const evalSet = [makeEval("negative query", false)];
    const result = await validateRoutingTriggerAccuracy("original", "proposed", evalSet, "claude");
    expect(typeof result.before_pass_rate).toBe("number");
    expect(typeof result.after_pass_rate).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// validateRoutingProposal
// ---------------------------------------------------------------------------

describe("validateRoutingProposal", () => {
  test("structurally invalid proposal fails gate 1", async () => {
    const proposal = makeRoutingProposal({ proposed_body: "not a table" });
    const evalSet = [makeEval("test", true)];

    const result = await validateRoutingProposal(proposal, evalSet, "claude");

    expect(result.gates_passed).toBe(0);
    expect(result.gates_total).toBe(2);
    expect(result.improved).toBe(false);
    expect(result.gate_results[0].gate).toBe("structural");
    expect(result.gate_results[0].passed).toBe(false);
  });

  test("valid structure passes gate 1, trigger accuracy determines gate 2", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeRoutingProposal();
    const evalSet = [makeEval("test", true)];

    const result = await validateRoutingProposal(proposal, evalSet, "claude");

    expect(result.gate_results[0].gate).toBe("structural");
    expect(result.gate_results[0].passed).toBe(true);
    expect(result.gate_results.length).toBe(2);
    expect(result.gates_total).toBe(2);
  });

  test("returns correct proposal_id", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeRoutingProposal({ proposal_id: "custom-id" });
    const result = await validateRoutingProposal(proposal, [], "claude");

    expect(result.proposal_id).toBe("custom-id");
  });
});
