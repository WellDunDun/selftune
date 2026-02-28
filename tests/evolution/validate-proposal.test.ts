import { describe, expect, mock, test } from "bun:test";
import type { EvalEntry, EvolutionProposal } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Mock callLlm before importing the module under test
// ---------------------------------------------------------------------------

const mockCallLlm = mock(async (_sys: string, user: string, _mode: string, _agent?: string) => {
  // Default: deterministic responses based on content in the user prompt
  // If the prompt contains "should-trigger-query" and the description is "proposed", say YES
  // Otherwise say NO
  return "NO";
});

mock.module("../../cli/selftune/utils/llm-call.js", () => ({
  callLlm: mockCallLlm,
}));

// Import after mocking
const { buildTriggerCheckPrompt, parseTriggerResponse, validateProposal } = await import(
  "../../cli/selftune/evolution/validate-proposal.js"
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEval(query: string, shouldTrigger: boolean): EvalEntry {
  return { query, should_trigger: shouldTrigger };
}

function makeProposal(overrides: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    proposal_id: "prop-test-001",
    skill_name: "test-skill",
    skill_path: "/skills/test-skill",
    original_description: "A skill for testing things",
    proposed_description: "A skill for testing and validating things",
    rationale: "Improve trigger coverage for validation queries",
    failure_patterns: ["fp-test-0"],
    eval_results: {
      before: { total: 10, passed: 7, failed: 3, pass_rate: 0.7 },
      after: { total: 10, passed: 9, failed: 1, pass_rate: 0.9 },
    },
    confidence: 0.8,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildTriggerCheckPrompt
// ---------------------------------------------------------------------------

describe("buildTriggerCheckPrompt", () => {
  test("includes the description in the prompt", () => {
    const prompt = buildTriggerCheckPrompt("My skill description", "user query here");
    expect(prompt).toContain("My skill description");
  });

  test("includes the query in the prompt", () => {
    const prompt = buildTriggerCheckPrompt("My skill description", "user query here");
    expect(prompt).toContain("user query here");
  });

  test("asks for YES or NO response", () => {
    const prompt = buildTriggerCheckPrompt("desc", "query");
    const upper = prompt.toUpperCase();
    expect(upper).toContain("YES");
    expect(upper).toContain("NO");
  });
});

// ---------------------------------------------------------------------------
// parseTriggerResponse
// ---------------------------------------------------------------------------

describe("parseTriggerResponse", () => {
  test("'YES' returns true", () => {
    expect(parseTriggerResponse("YES")).toBe(true);
  });

  test("'NO' returns false", () => {
    expect(parseTriggerResponse("NO")).toBe(false);
  });

  test("'Yes, because...' returns true (starts with YES)", () => {
    expect(parseTriggerResponse("Yes, because the query matches")).toBe(true);
  });

  test("'yes' lowercase returns true", () => {
    expect(parseTriggerResponse("yes")).toBe(true);
  });

  test("'no' lowercase returns false", () => {
    expect(parseTriggerResponse("no")).toBe(false);
  });

  test("'nope' returns false (starts with NO)", () => {
    expect(parseTriggerResponse("nope")).toBe(false);
  });

  test("empty string returns false (conservative default)", () => {
    expect(parseTriggerResponse("")).toBe(false);
  });

  test("'maybe' returns false (not YES or NO)", () => {
    expect(parseTriggerResponse("maybe")).toBe(false);
  });

  test("whitespace-padded '  YES  ' returns true", () => {
    expect(parseTriggerResponse("  YES  ")).toBe(true);
  });

  test("'NO reason given' returns false", () => {
    expect(parseTriggerResponse("NO reason given")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateProposal
// ---------------------------------------------------------------------------

describe("validateProposal", () => {
  test("returns correct ValidationResult structure", async () => {
    // Mock: all LLM calls return "NO" (default)
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("run tests", true), makeEval("unrelated query", false)];

    const result = await validateProposal(proposal, evalSet, "api");

    expect(result.proposal_id).toBe("prop-test-001");
    expect(typeof result.before_pass_rate).toBe("number");
    expect(typeof result.after_pass_rate).toBe("number");
    expect(typeof result.improved).toBe("boolean");
    expect(Array.isArray(result.regressions)).toBe(true);
    expect(Array.isArray(result.new_passes)).toBe(true);
    expect(typeof result.net_change).toBe("number");
  });

  test("computes pass rates correctly when LLM always says NO", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("should trigger", true), // should_trigger=true, LLM=NO => FAIL
      makeEval("should trigger 2", true), // should_trigger=true, LLM=NO => FAIL
      makeEval("negative case", false), // should_trigger=false, LLM=NO => PASS
    ];

    const result = await validateProposal(proposal, evalSet, "api");

    // Before: all NO => should_trigger=true fails (2 fail), should_trigger=false passes (1 pass) => 1/3
    // After: same => 1/3
    expect(result.before_pass_rate).toBeCloseTo(1 / 3, 5);
    expect(result.after_pass_rate).toBeCloseTo(1 / 3, 5);
    expect(result.net_change).toBeCloseTo(0, 5);
    expect(result.improved).toBe(false);
  });

  test("computes pass rates correctly when LLM always says YES", async () => {
    mockCallLlm.mockImplementation(async () => "YES");

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("should trigger", true), // should_trigger=true, LLM=YES => PASS
      makeEval("should trigger 2", true), // should_trigger=true, LLM=YES => PASS
      makeEval("negative case", false), // should_trigger=false, LLM=YES => FAIL
    ];

    const result = await validateProposal(proposal, evalSet, "api");

    // Before: all YES => should_trigger=true passes (2 pass), should_trigger=false fails (1 fail) => 2/3
    // After: same => 2/3
    expect(result.before_pass_rate).toBeCloseTo(2 / 3, 5);
    expect(result.after_pass_rate).toBeCloseTo(2 / 3, 5);
    expect(result.improved).toBe(false);
  });

  test("detects improvement when proposed description gets better results", async () => {
    // Mock: original description triggers NO for everything,
    //       proposed description triggers YES for everything
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("A skill for testing and validating things")) {
        return "YES";
      }
      return "NO";
    });

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("run tests", true),
      makeEval("validate input", true),
      makeEval("check assertions", true),
      makeEval("unrelated cooking", false),
    ];

    const result = await validateProposal(proposal, evalSet, "api");

    // Before (original desc => all NO):
    //   true entries: NO => fail (3 fail)
    //   false entry: NO => pass (1 pass)
    //   before_pass_rate = 1/4 = 0.25

    // After (proposed desc => all YES):
    //   true entries: YES => pass (3 pass)
    //   false entry: YES => fail (1 fail)
    //   after_pass_rate = 3/4 = 0.75

    expect(result.before_pass_rate).toBeCloseTo(0.25, 5);
    expect(result.after_pass_rate).toBeCloseTo(0.75, 5);
    expect(result.net_change).toBeCloseTo(0.5, 5);
    expect(result.new_passes.length).toBe(3);
    // The negative entry regressed (passed before as NO, now fails as YES)
    expect(result.regressions.length).toBe(1);
    // Improved: after > before, regressions (1) < 5% of 4 is 0.2 => 1 > 0.2? => false
    // Wait: 5% of 4 = 0.2, regressions=1 => 1 < 0.2 is false => NOT improved
    // Actually that can't be right. Let me re-think. 5% of 4 total entries = 0.2
    // 1 regression >= 0.2, so the condition fails. But the improvement is huge.
    // The spec says regressions count < 5% of total. With only 4 entries, 5% = 0.2.
    // 1 regression is NOT < 0.2 so improved = false despite huge improvement.
    // This is expected behavior for small eval sets - conservative check.
    expect(result.improved).toBe(false);
  });

  test("detects improvement with large eval set and few regressions", async () => {
    // Build a large eval set where the proposed description helps
    const evalSet: EvalEntry[] = [];
    // 20 should-trigger entries
    for (let i = 0; i < 20; i++) {
      evalSet.push(makeEval(`trigger query ${i}`, true));
    }
    // 10 should-not-trigger entries
    for (let i = 0; i < 10; i++) {
      evalSet.push(makeEval(`negative query ${i}`, false));
    }

    // Mock: original says YES only for first 14 trigger queries
    // Proposed says YES for all 20 trigger queries
    // Both say NO for negative queries
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      const isProposed = user.includes("A skill for testing and validating things");
      const isTriggerQuery = user.includes("trigger query");
      const queryNum = Number.parseInt(user.match(/trigger query (\d+)/)?.[1] ?? "-1", 10);

      if (isTriggerQuery) {
        if (isProposed) return "YES"; // proposed gets all trigger queries right
        return queryNum < 14 ? "YES" : "NO"; // original misses queries 14-19
      }
      return "NO"; // both correctly say NO for negative queries
    });

    const proposal = makeProposal();
    const result = await validateProposal(proposal, evalSet, "api");

    // Before: 14 trigger + 10 negative correct = 24/30
    expect(result.before_pass_rate).toBeCloseTo(24 / 30, 5);
    // After: 20 trigger + 10 negative correct = 30/30
    expect(result.after_pass_rate).toBeCloseTo(30 / 30, 5);
    expect(result.net_change).toBeCloseTo(6 / 30, 5);
    expect(result.new_passes.length).toBe(6);
    expect(result.regressions.length).toBe(0);
    // improved: after > before (1.0 > 0.8), regressions (0) < 5% of 30 (1.5), net >= 0.10
    expect(result.improved).toBe(true);
  });

  test("regressions tracked correctly: passed before, fail after", async () => {
    // Mock: original says YES for everything, proposed says NO for everything
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("A skill for testing and validating things")) {
        return "NO";
      }
      return "YES";
    });

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("should trigger", true), // before: YES=pass, after: NO=fail => regression
      makeEval("negative case", false), // before: YES=fail, after: NO=pass => new_pass
    ];

    const result = await validateProposal(proposal, evalSet, "api");

    expect(result.regressions.length).toBe(1);
    expect(result.regressions[0].query).toBe("should trigger");
    expect(result.new_passes.length).toBe(1);
    expect(result.new_passes[0].query).toBe("negative case");
  });

  test("passes agent parameter through to callLlm", async () => {
    let capturedAgent: string | undefined;
    mockCallLlm.mockImplementation(
      async (_sys: string, _user: string, _mode: string, agent?: string) => {
        capturedAgent = agent;
        return "NO";
      },
    );

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("test", true)];

    await validateProposal(proposal, evalSet, "agent", "claude");

    expect(capturedAgent).toBe("claude");
  });

  test("empty eval set returns zero pass rates", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeProposal();
    const result = await validateProposal(proposal, [], "api");

    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(0);
    expect(result.net_change).toBe(0);
    expect(result.improved).toBe(false);
    expect(result.regressions).toEqual([]);
    expect(result.new_passes).toEqual([]);
  });
});
