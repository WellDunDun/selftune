import { describe, expect, mock, test } from "bun:test";
import type { EvalEntry, EvolutionProposal } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Mock callLlm before importing the module under test
// ---------------------------------------------------------------------------

const mockCallLlm = mock(
  async (_sys: string, _user: string, _agent: string, _modelFlag?: string) => {
    // Default: deterministic responses based on content in the user prompt
    return "NO";
  },
);

mock.module("../../cli/selftune/utils/llm-call.js", () => ({
  callLlm: mockCallLlm,
}));

// Import after mocking
const {
  buildTriggerCheckPrompt,
  parseTriggerResponse,
  validateProposal,
  validateProposalSequential,
  validateProposalBatched,
  TRIGGER_CHECK_BATCH_SIZE,
} = await import("../../cli/selftune/evolution/validate-proposal.js");

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
// Batch helper: generate numbered YES/NO response from a batch user prompt
// ---------------------------------------------------------------------------

/**
 * Given a batch prompt string containing numbered queries, produce a
 * numbered YES/NO response where every query gets the specified answer.
 */
function batchAllResponse(userPrompt: string, answer: "YES" | "NO"): string {
  const lines = userPrompt.split("\n");
  const queryLines = lines.filter((l) => /^\d+\.\s*"/.test(l.trim()));
  return queryLines
    .map((l) => {
      const num = l.trim().match(/^(\d+)/)?.[1];
      return `${num}. ${answer}`;
    })
    .join("\n");
}

/**
 * Given a batch prompt, produce numbered YES/NO using a per-query decision fn.
 */
function batchConditionalResponse(
  userPrompt: string,
  decide: (query: string) => "YES" | "NO",
): string {
  const lines = userPrompt.split("\n");
  const queryLines = lines.filter((l) => /^\d+\.\s*"/.test(l.trim()));
  return queryLines
    .map((l) => {
      const num = l.trim().match(/^(\d+)/)?.[1];
      const query = l.trim().match(/"(.+)"/)?.[1] ?? "";
      return `${num}. ${decide(query)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// validateProposal (batched — the default)
// ---------------------------------------------------------------------------

describe("validateProposal", () => {
  test("returns correct ValidationResult structure", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) =>
      batchAllResponse(user, "NO"),
    );

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("run tests", true), makeEval("unrelated query", false)];

    const result = await validateProposal(proposal, evalSet, "claude");

    expect(result.proposal_id).toBe("prop-test-001");
    expect(typeof result.before_pass_rate).toBe("number");
    expect(typeof result.after_pass_rate).toBe("number");
    expect(typeof result.improved).toBe("boolean");
    expect(Array.isArray(result.regressions)).toBe(true);
    expect(Array.isArray(result.new_passes)).toBe(true);
    expect(typeof result.net_change).toBe("number");
  });

  test("computes pass rates correctly when LLM always says NO", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) =>
      batchAllResponse(user, "NO"),
    );

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("should trigger", true),
      makeEval("should trigger 2", true),
      makeEval("negative case", false),
    ];

    const result = await validateProposal(proposal, evalSet, "claude");

    // All NO: 2 should_trigger fail, 1 negative passes -> 1/3
    expect(result.before_pass_rate).toBeCloseTo(1 / 3, 5);
    expect(result.after_pass_rate).toBeCloseTo(1 / 3, 5);
    expect(result.net_change).toBeCloseTo(0, 5);
    expect(result.improved).toBe(false);
  });

  test("computes pass rates correctly when LLM always says YES", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) =>
      batchAllResponse(user, "YES"),
    );

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("should trigger", true),
      makeEval("should trigger 2", true),
      makeEval("negative case", false),
    ];

    const result = await validateProposal(proposal, evalSet, "claude");

    // All YES: 2 should_trigger pass, 1 negative fails -> 2/3
    expect(result.before_pass_rate).toBeCloseTo(2 / 3, 5);
    expect(result.after_pass_rate).toBeCloseTo(2 / 3, 5);
    expect(result.improved).toBe(false);
  });

  test("detects improvement when proposed description gets better results", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("A skill for testing and validating things")) {
        return batchAllResponse(user, "YES");
      }
      return batchAllResponse(user, "NO");
    });

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("run tests", true),
      makeEval("validate input", true),
      makeEval("check assertions", true),
      makeEval("unrelated cooking", false),
    ];

    const result = await validateProposal(proposal, evalSet, "claude");

    // Before: all NO -> only "unrelated cooking" (negative, NO) passes -> 1/4 = 0.25
    expect(result.before_pass_rate).toBeCloseTo(0.25, 5);
    // After: all YES -> 3 positives pass, 1 negative fails -> 3/4 = 0.75
    expect(result.after_pass_rate).toBeCloseTo(0.75, 5);
    expect(result.net_change).toBeCloseTo(0.5, 5);
    expect(result.new_passes.length).toBe(3);
    expect(result.regressions.length).toBe(1);
    // Regression on negative case blocks improvement flag
    expect(result.improved).toBe(false);
  });

  test("detects improvement with large eval set and few regressions", async () => {
    const evalSet: EvalEntry[] = [];
    for (let i = 0; i < 20; i++) {
      evalSet.push(makeEval(`trigger query ${i}`, true));
    }
    for (let i = 0; i < 10; i++) {
      evalSet.push(makeEval(`negative query ${i}`, false));
    }

    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      const isProposed = user.includes("A skill for testing and validating things");

      return batchConditionalResponse(user, (query: string) => {
        const isTriggerQuery = query.startsWith("trigger query");
        const queryNum = Number.parseInt(query.match(/trigger query (\d+)/)?.[1] ?? "-1", 10);

        if (isTriggerQuery) {
          if (isProposed) return "YES";
          return queryNum < 14 ? "YES" : "NO";
        }
        return "NO";
      });
    });

    const proposal = makeProposal();
    const result = await validateProposal(proposal, evalSet, "claude");

    // Before: 14 trigger pass + 10 negative pass = 24/30
    expect(result.before_pass_rate).toBeCloseTo(24 / 30, 5);
    // After: 20 trigger pass + 10 negative pass = 30/30
    expect(result.after_pass_rate).toBeCloseTo(30 / 30, 5);
    expect(result.net_change).toBeCloseTo(6 / 30, 5);
    expect(result.new_passes.length).toBe(6);
    expect(result.regressions.length).toBe(0);
    expect(result.improved).toBe(true);
  });

  test("regressions tracked correctly: passed before, fail after", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("A skill for testing and validating things")) {
        return batchAllResponse(user, "NO");
      }
      return batchAllResponse(user, "YES");
    });

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      makeEval("should trigger", true),
      makeEval("negative case", false),
    ];

    const result = await validateProposal(proposal, evalSet, "claude");

    expect(result.regressions.length).toBe(1);
    expect(result.regressions[0].query).toBe("should trigger");
    expect(result.new_passes.length).toBe(1);
    expect(result.new_passes[0].query).toBe("negative case");
  });

  test("passes agent parameter through to callLlm", async () => {
    let capturedAgent: string | undefined;
    mockCallLlm.mockImplementation(async (_sys: string, user: string, agent: string) => {
      capturedAgent = agent;
      return batchAllResponse(user, "NO");
    });

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("test", true)];

    await validateProposal(proposal, evalSet, "claude");

    expect(capturedAgent).toBe("claude");
  });

  test("passes modelFlag parameter through to callLlm", async () => {
    let capturedModelFlag: string | undefined;
    mockCallLlm.mockImplementation(
      async (_sys: string, user: string, _agent: string, modelFlag?: string) => {
        capturedModelFlag = modelFlag;
        return batchAllResponse(user, "NO");
      },
    );

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("test", true)];

    await validateProposal(proposal, evalSet, "claude", "haiku");

    expect(capturedModelFlag).toBe("haiku");
  });

  test("modelFlag defaults to undefined when not provided", async () => {
    let capturedModelFlag: string | undefined = "should-be-overwritten";
    mockCallLlm.mockImplementation(
      async (_sys: string, user: string, _agent: string, modelFlag?: string) => {
        capturedModelFlag = modelFlag;
        return batchAllResponse(user, "NO");
      },
    );

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("test", true)];

    await validateProposal(proposal, evalSet, "claude");

    expect(capturedModelFlag).toBeUndefined();
  });

  test("empty eval set returns zero pass rates", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeProposal();
    const result = await validateProposal(proposal, [], "claude");

    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(0);
    expect(result.net_change).toBe(0);
    expect(result.improved).toBe(false);
    expect(result.regressions).toEqual([]);
    expect(result.new_passes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateProposalBatched — specific batch behavior
// ---------------------------------------------------------------------------

describe("validateProposalBatched", () => {
  test("TRIGGER_CHECK_BATCH_SIZE is 50", () => {
    expect(TRIGGER_CHECK_BATCH_SIZE).toBe(50);
  });

  test("makes fewer LLM calls than sequential for large eval sets", async () => {
    let callCount = 0;
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      callCount++;
      return batchAllResponse(user, "NO");
    });

    const evalSet: EvalEntry[] = [];
    for (let i = 0; i < 25; i++) {
      evalSet.push(makeEval(`query ${i}`, true));
    }

    callCount = 0;
    const proposal = makeProposal();
    await validateProposalBatched(proposal, evalSet, "claude");

    // 25 entries / batch size 50 = 1 batch, 2 calls (before + after) × 3 majority-vote runs
    // Sequential would be 25 * 2 = 50 calls
    expect(callCount).toBe(6);
  });

  test("handles eval set smaller than batch size", async () => {
    let callCount = 0;
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      callCount++;
      return batchAllResponse(user, "YES");
    });

    const evalSet: EvalEntry[] = [makeEval("q1", true), makeEval("q2", false)];

    callCount = 0;
    const proposal = makeProposal();
    const result = await validateProposalBatched(proposal, evalSet, "claude");

    // 1 batch, 2 calls (before + after) × 3 majority-vote runs
    expect(callCount).toBe(6);
    // All YES: q1 (should_trigger=true, YES) passes, q2 (should_trigger=false, YES) fails
    expect(result.before_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.after_pass_rate).toBeCloseTo(0.5, 5);
  });

  test("passes modelFlag through to callLlm", async () => {
    let capturedModel: string | undefined;
    mockCallLlm.mockImplementation(
      async (_sys: string, user: string, _agent: string, model?: string) => {
        capturedModel = model;
        return batchAllResponse(user, "NO");
      },
    );

    const proposal = makeProposal();
    await validateProposalBatched(proposal, [makeEval("q", true)], "claude", "haiku");

    expect(capturedModel).toBe("haiku");
  });
});

// ---------------------------------------------------------------------------
// validateProposalSequential — backward compat
// ---------------------------------------------------------------------------

describe("validateProposalSequential", () => {
  test("exists and works with single-query mocking", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [makeEval("test query", true)];

    const result = await validateProposalSequential(proposal, evalSet, "claude");

    expect(result.proposal_id).toBe("prop-test-001");
    expect(typeof result.before_pass_rate).toBe("number");
  });

  test("makes 2 calls per eval entry (not batched)", async () => {
    let callCount = 0;
    mockCallLlm.mockImplementation(async () => {
      callCount++;
      return "NO";
    });

    const evalSet: EvalEntry[] = [
      makeEval("q1", true),
      makeEval("q2", true),
      makeEval("q3", false),
    ];

    callCount = 0;
    const proposal = makeProposal();
    await validateProposalSequential(proposal, evalSet, "claude");

    // 3 entries * 2 calls each = 6
    expect(callCount).toBe(6);
  });
});
