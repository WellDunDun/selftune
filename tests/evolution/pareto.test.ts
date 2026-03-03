import { describe, expect, test } from "bun:test";
import {
  computeInvocationScores,
  computeParetoFrontier,
  dominates,
  getDominatedDimensions,
  buildMergePrompt,
  selectFromFrontier,
} from "../../cli/selftune/evolution/pareto.js";
import type { InvocationTypeScores, ParetoCandidate } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScores(overrides: Partial<Record<string, { passed: number; total: number; pass_rate: number }>> = {}): InvocationTypeScores {
  return {
    explicit: { passed: 5, total: 10, pass_rate: 0.5 },
    implicit: { passed: 5, total: 10, pass_rate: 0.5 },
    contextual: { passed: 5, total: 10, pass_rate: 0.5 },
    negative: { passed: 5, total: 10, pass_rate: 0.5 },
    ...overrides,
  } as InvocationTypeScores;
}

function makeCandidate(id: string, scores: InvocationTypeScores, afterPassRate = 0.7): ParetoCandidate {
  return {
    proposal: {
      proposal_id: id, skill_name: "test", skill_path: "/test",
      original_description: "old desc", proposed_description: `new desc ${id}`,
      rationale: "test", failure_patterns: [],
      eval_results: { before: { total: 0, passed: 0, failed: 0, pass_rate: 0 }, after: { total: 0, passed: 0, failed: 0, pass_rate: 0 } },
      confidence: 0.8, created_at: "", status: "pending",
    },
    validation: {
      proposal_id: id, before_pass_rate: 0.5, after_pass_rate: afterPassRate,
      improved: true, regressions: [], new_passes: [], net_change: 0.2,
    },
    invocation_scores: scores,
    dominates_on: [],
  };
}

// ---------------------------------------------------------------------------
// computeInvocationScores
// ---------------------------------------------------------------------------

describe("computeInvocationScores", () => {
  test("computes scores from per-entry results", () => {
    const entries = [
      { entry: { invocation_type: "explicit" as const }, after_pass: true },
      { entry: { invocation_type: "explicit" as const }, after_pass: false },
      { entry: { invocation_type: "implicit" as const }, after_pass: true },
      { entry: { invocation_type: "negative" as const }, after_pass: true },
    ];
    const scores = computeInvocationScores(entries);
    expect(scores.explicit.passed).toBe(1);
    expect(scores.explicit.total).toBe(2);
    expect(scores.explicit.pass_rate).toBe(0.5);
    expect(scores.implicit.passed).toBe(1);
    expect(scores.implicit.total).toBe(1);
    expect(scores.implicit.pass_rate).toBe(1.0);
    expect(scores.contextual.total).toBe(0);
    expect(scores.contextual.pass_rate).toBe(0);
  });

  test("defaults missing invocation_type to implicit", () => {
    const entries = [
      { entry: {}, after_pass: true },
      { entry: {}, after_pass: false },
    ];
    const scores = computeInvocationScores(entries);
    expect(scores.implicit.total).toBe(2);
    expect(scores.implicit.passed).toBe(1);
  });

  test("handles empty input", () => {
    const scores = computeInvocationScores([]);
    expect(scores.explicit.total).toBe(0);
    expect(scores.implicit.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dominates
// ---------------------------------------------------------------------------

describe("dominates", () => {
  test("A dominates B when strictly better on at least one dimension", () => {
    const a = makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } });
    const b = makeScores();
    expect(dominates(a, b)).toBe(true);
  });

  test("equal scores means no domination", () => {
    const a = makeScores();
    const b = makeScores();
    expect(dominates(a, b)).toBe(false);
  });

  test("A does not dominate B when worse on any dimension", () => {
    const a = makeScores({
      explicit: { passed: 8, total: 10, pass_rate: 0.8 },
      implicit: { passed: 3, total: 10, pass_rate: 0.3 },
    });
    const b = makeScores();
    expect(dominates(a, b)).toBe(false);
  });

  test("mutual non-domination for complementary strengths", () => {
    const a = makeScores({ explicit: { passed: 9, total: 10, pass_rate: 0.9 }, implicit: { passed: 3, total: 10, pass_rate: 0.3 } });
    const b = makeScores({ explicit: { passed: 3, total: 10, pass_rate: 0.3 }, implicit: { passed: 9, total: 10, pass_rate: 0.9 } });
    expect(dominates(a, b)).toBe(false);
    expect(dominates(b, a)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeParetoFrontier
// ---------------------------------------------------------------------------

describe("computeParetoFrontier", () => {
  test("single candidate returns that candidate", () => {
    const c = makeCandidate("c1", makeScores());
    const frontier = computeParetoFrontier([c]);
    expect(frontier).toHaveLength(1);
    expect(frontier[0].proposal.proposal_id).toBe("c1");
  });

  test("dominated candidate is excluded", () => {
    const better = makeCandidate("better", makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } }));
    const worse = makeCandidate("worse", makeScores());
    const frontier = computeParetoFrontier([better, worse]);
    expect(frontier).toHaveLength(1);
    expect(frontier[0].proposal.proposal_id).toBe("better");
  });

  test("complementary candidates both stay on frontier", () => {
    const a = makeCandidate("a", makeScores({ explicit: { passed: 9, total: 10, pass_rate: 0.9 }, implicit: { passed: 3, total: 10, pass_rate: 0.3 } }));
    const b = makeCandidate("b", makeScores({ explicit: { passed: 3, total: 10, pass_rate: 0.3 }, implicit: { passed: 9, total: 10, pass_rate: 0.9 } }));
    const frontier = computeParetoFrontier([a, b]);
    expect(frontier).toHaveLength(2);
  });

  test("empty input returns empty", () => {
    expect(computeParetoFrontier([])).toEqual([]);
  });

  test("sets dominates_on for frontier members", () => {
    const a = makeCandidate("a", makeScores({ explicit: { passed: 9, total: 10, pass_rate: 0.9 }, implicit: { passed: 3, total: 10, pass_rate: 0.3 } }));
    const b = makeCandidate("b", makeScores({ explicit: { passed: 3, total: 10, pass_rate: 0.3 }, implicit: { passed: 9, total: 10, pass_rate: 0.9 } }));
    const frontier = computeParetoFrontier([a, b]);
    const memberA = frontier.find(c => c.proposal.proposal_id === "a")!;
    const memberB = frontier.find(c => c.proposal.proposal_id === "b")!;
    expect(memberA.dominates_on).toContain("explicit");
    expect(memberB.dominates_on).toContain("implicit");
  });
});

// ---------------------------------------------------------------------------
// buildMergePrompt
// ---------------------------------------------------------------------------

describe("buildMergePrompt", () => {
  test("returns null for single candidate", () => {
    const c = makeCandidate("c1", makeScores());
    c.dominates_on = ["explicit"];
    expect(buildMergePrompt([c], "original")).toBeNull();
  });

  test("returns null when no complementarity", () => {
    const a = makeCandidate("a", makeScores());
    const b = makeCandidate("b", makeScores());
    a.dominates_on = [];
    b.dominates_on = [];
    expect(buildMergePrompt([a, b], "original")).toBeNull();
  });

  test("returns prompt when complementary candidates exist", () => {
    const a = makeCandidate("a", makeScores());
    const b = makeCandidate("b", makeScores());
    a.dominates_on = ["explicit"];
    b.dominates_on = ["implicit"];
    const prompt = buildMergePrompt([a, b], "original");
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("original");
    expect(prompt).toContain("Candidate 1");
    expect(prompt).toContain("Candidate 2");
  });
});

// ---------------------------------------------------------------------------
// selectFromFrontier
// ---------------------------------------------------------------------------

describe("selectFromFrontier", () => {
  test("throws on empty frontier", () => {
    expect(() => selectFromFrontier([])).toThrow("Cannot select from empty frontier");
  });

  test("returns best by after_pass_rate", () => {
    const a = makeCandidate("a", makeScores(), 0.8);
    const b = makeCandidate("b", makeScores(), 0.7);
    const { best } = selectFromFrontier([a, b]);
    expect(best.proposal.proposal_id).toBe("a");
  });

  test("shouldMerge is true when frontier has complementary candidates", () => {
    const a = makeCandidate("a", makeScores());
    const b = makeCandidate("b", makeScores());
    a.dominates_on = ["explicit"];
    b.dominates_on = ["implicit"];
    const { shouldMerge } = selectFromFrontier([a, b]);
    expect(shouldMerge).toBe(true);
  });

  test("shouldMerge is false for single candidate", () => {
    const a = makeCandidate("a", makeScores());
    const { shouldMerge } = selectFromFrontier([a]);
    expect(shouldMerge).toBe(false);
  });
});
