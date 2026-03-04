import { describe, expect, test } from "bun:test";
import {
  buildMergePrompt,
  computeInvocationScores,
  computeParetoFrontier,
  computeTokenEfficiencyScore,
  computeTokenUsageMetrics,
  dominates,
  selectFromFrontier,
} from "../../cli/selftune/evolution/pareto.js";
import type {
  InvocationTypeScores,
  ParetoCandidate,
  SessionTelemetryRecord,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScores(
  overrides: Partial<Record<string, { passed: number; total: number; pass_rate: number }>> = {},
): InvocationTypeScores {
  return {
    explicit: { passed: 5, total: 10, pass_rate: 0.5 },
    implicit: { passed: 5, total: 10, pass_rate: 0.5 },
    contextual: { passed: 5, total: 10, pass_rate: 0.5 },
    negative: { passed: 5, total: 10, pass_rate: 0.5 },
    ...overrides,
  } as InvocationTypeScores;
}

function makeCandidate(
  id: string,
  scores: InvocationTypeScores,
  afterPassRate = 0.7,
): ParetoCandidate {
  return {
    proposal: {
      proposal_id: id,
      skill_name: "test",
      skill_path: "/test",
      original_description: "old desc",
      proposed_description: `new desc ${id}`,
      rationale: "test",
      failure_patterns: [],
      eval_results: {
        before: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
        after: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
      },
      confidence: 0.8,
      created_at: "",
      status: "pending",
    },
    validation: {
      proposal_id: id,
      before_pass_rate: 0.5,
      after_pass_rate: afterPassRate,
      improved: true,
      regressions: [],
      new_passes: [],
      net_change: 0.2,
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
    const a = makeScores({
      explicit: { passed: 9, total: 10, pass_rate: 0.9 },
      implicit: { passed: 3, total: 10, pass_rate: 0.3 },
    });
    const b = makeScores({
      explicit: { passed: 3, total: 10, pass_rate: 0.3 },
      implicit: { passed: 9, total: 10, pass_rate: 0.9 },
    });
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
    const better = makeCandidate(
      "better",
      makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } }),
    );
    const worse = makeCandidate("worse", makeScores());
    const frontier = computeParetoFrontier([better, worse]);
    expect(frontier).toHaveLength(1);
    expect(frontier[0].proposal.proposal_id).toBe("better");
  });

  test("complementary candidates both stay on frontier", () => {
    const a = makeCandidate(
      "a",
      makeScores({
        explicit: { passed: 9, total: 10, pass_rate: 0.9 },
        implicit: { passed: 3, total: 10, pass_rate: 0.3 },
      }),
    );
    const b = makeCandidate(
      "b",
      makeScores({
        explicit: { passed: 3, total: 10, pass_rate: 0.3 },
        implicit: { passed: 9, total: 10, pass_rate: 0.9 },
      }),
    );
    const frontier = computeParetoFrontier([a, b]);
    expect(frontier).toHaveLength(2);
  });

  test("empty input returns empty", () => {
    expect(computeParetoFrontier([])).toEqual([]);
  });

  test("sets dominates_on for frontier members", () => {
    const a = makeCandidate(
      "a",
      makeScores({
        explicit: { passed: 9, total: 10, pass_rate: 0.9 },
        implicit: { passed: 3, total: 10, pass_rate: 0.3 },
      }),
    );
    const b = makeCandidate(
      "b",
      makeScores({
        explicit: { passed: 3, total: 10, pass_rate: 0.3 },
        implicit: { passed: 9, total: 10, pass_rate: 0.9 },
      }),
    );
    const frontier = computeParetoFrontier([a, b]);
    const memberA = frontier.find((c) => c.proposal.proposal_id === "a")!;
    const memberB = frontier.find((c) => c.proposal.proposal_id === "b")!;
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

// ---------------------------------------------------------------------------
// Token efficiency helpers
// ---------------------------------------------------------------------------

function makeTelemetryRecord(overrides: Partial<SessionTelemetryRecord> = {}): SessionTelemetryRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    cwd: "/tmp",
    transcript_path: "/tmp/transcript.jsonl",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    assistant_turns: 1,
    errors_encountered: 0,
    transcript_chars: 100,
    last_user_query: "test",
    input_tokens: 1000,
    output_tokens: 500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeTokenUsageMetrics
// ---------------------------------------------------------------------------

describe("computeTokenUsageMetrics", () => {
  test("sums tokens from multiple records", () => {
    const records = [
      makeTelemetryRecord({ input_tokens: 100, output_tokens: 50 }),
      makeTelemetryRecord({ input_tokens: 200, output_tokens: 150 }),
    ];
    const metrics = computeTokenUsageMetrics(records);
    expect(metrics.input_tokens).toBe(300);
    expect(metrics.output_tokens).toBe(200);
    expect(metrics.total_tokens).toBe(500);
  });

  test("handles records with missing token fields", () => {
    const records = [
      makeTelemetryRecord({ input_tokens: undefined, output_tokens: undefined }),
      makeTelemetryRecord({ input_tokens: 100, output_tokens: 50 }),
    ];
    const metrics = computeTokenUsageMetrics(records);
    expect(metrics.input_tokens).toBe(100);
    expect(metrics.output_tokens).toBe(50);
    expect(metrics.total_tokens).toBe(150);
  });

  test("returns zeros for empty input", () => {
    const metrics = computeTokenUsageMetrics([]);
    expect(metrics.total_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeTokenEfficiencyScore
// ---------------------------------------------------------------------------

describe("computeTokenEfficiencyScore", () => {
  test("returns > 0.5 when skill sessions use fewer tokens", () => {
    const telemetry = [
      // Sessions WITH the skill — fewer tokens
      makeTelemetryRecord({ skills_triggered: ["my-skill"], input_tokens: 500, output_tokens: 200 }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"], input_tokens: 600, output_tokens: 300 }),
      // Sessions WITHOUT the skill — more tokens (baseline)
      makeTelemetryRecord({ skills_triggered: [], input_tokens: 1500, output_tokens: 800 }),
      makeTelemetryRecord({ skills_triggered: [], input_tokens: 1200, output_tokens: 600 }),
    ];
    const score = computeTokenEfficiencyScore("my-skill", telemetry);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("returns < 0.5 when skill sessions use more tokens", () => {
    const telemetry = [
      // Sessions WITH the skill — more tokens
      makeTelemetryRecord({ skills_triggered: ["my-skill"], input_tokens: 3000, output_tokens: 1500 }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"], input_tokens: 2500, output_tokens: 1200 }),
      // Sessions WITHOUT — fewer tokens
      makeTelemetryRecord({ skills_triggered: [], input_tokens: 500, output_tokens: 200 }),
      makeTelemetryRecord({ skills_triggered: [], input_tokens: 600, output_tokens: 300 }),
    ];
    const score = computeTokenEfficiencyScore("my-skill", telemetry);
    expect(score).toBeLessThan(0.5);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test("returns 0.5 (neutral) when no sessions with skill", () => {
    const telemetry = [
      makeTelemetryRecord({ skills_triggered: [], input_tokens: 1000, output_tokens: 500 }),
    ];
    const score = computeTokenEfficiencyScore("my-skill", telemetry);
    expect(score).toBe(0.5);
  });

  test("returns 0.5 (neutral) when no sessions without skill", () => {
    const telemetry = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"], input_tokens: 1000, output_tokens: 500 }),
    ];
    const score = computeTokenEfficiencyScore("my-skill", telemetry);
    expect(score).toBe(0.5);
  });

  test("returns 0.5 for empty telemetry", () => {
    expect(computeTokenEfficiencyScore("any-skill", [])).toBe(0.5);
  });

  test("skips records with zero total tokens", () => {
    const telemetry = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"], input_tokens: 0, output_tokens: 0 }),
      makeTelemetryRecord({ skills_triggered: [], input_tokens: 0, output_tokens: 0 }),
    ];
    const score = computeTokenEfficiencyScore("my-skill", telemetry);
    expect(score).toBe(0.5); // insufficient data after filtering
  });
});

// ---------------------------------------------------------------------------
// dominates — 5D (with token efficiency)
// ---------------------------------------------------------------------------

describe("dominates (5D with token efficiency)", () => {
  test("token efficiency breaks tie when 4D scores are equal", () => {
    const scores = makeScores();
    // A has better token efficiency
    expect(dominates(scores, scores, 0.8, 0.5)).toBe(true);
    // B has better token efficiency
    expect(dominates(scores, scores, 0.5, 0.8)).toBe(false);
  });

  test("token efficiency adds dimension — A worse on tokens prevents domination", () => {
    // A is better on explicit but worse on token efficiency
    const a = makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } });
    const b = makeScores();
    // Without token data, A dominates B
    expect(dominates(a, b)).toBe(true);
    // With token data where B is more efficient, A no longer dominates
    expect(dominates(a, b, 0.3, 0.7)).toBe(false);
  });

  test("5D domination requires all 5 dimensions to be >= and one >", () => {
    const a = makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } });
    const b = makeScores();
    // A better on explicit and equally good on tokens
    expect(dominates(a, b, 0.5, 0.5)).toBe(true);
  });

  test("undefined token scores are ignored (backward compatible)", () => {
    const a = makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } });
    const b = makeScores();
    // One has token data, the other doesn't — token dimension is skipped
    expect(dominates(a, b, 0.8, undefined)).toBe(true);
    expect(dominates(a, b, undefined, 0.8)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeParetoFrontier — 5D
// ---------------------------------------------------------------------------

describe("computeParetoFrontier (5D with token efficiency)", () => {
  test("token efficiency prevents domination — keeps both on frontier", () => {
    // A is better on all 4D invocation scores but worse on token efficiency
    const a = makeCandidate(
      "a",
      makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } }),
    );
    a.token_efficiency_score = 0.3; // poor efficiency

    const b = makeCandidate("b", makeScores());
    b.token_efficiency_score = 0.9; // great efficiency

    const frontier = computeParetoFrontier([a, b]);
    // Both should be on frontier: A better on explicit, B better on tokens
    expect(frontier).toHaveLength(2);
  });

  test("5D domination removes inferior candidate", () => {
    // A is better on explicit AND token efficiency
    const a = makeCandidate(
      "a",
      makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } }),
    );
    a.token_efficiency_score = 0.8;

    const b = makeCandidate("b", makeScores());
    b.token_efficiency_score = 0.5;

    const frontier = computeParetoFrontier([a, b]);
    expect(frontier).toHaveLength(1);
    expect(frontier[0].proposal.proposal_id).toBe("a");
  });

  test("mixed candidates — some with token scores, some without", () => {
    // When one candidate has token data and the other doesn't,
    // the token dimension is ignored for that pair
    const a = makeCandidate(
      "a",
      makeScores({ explicit: { passed: 8, total: 10, pass_rate: 0.8 } }),
    );
    a.token_efficiency_score = 0.8;

    const b = makeCandidate("b", makeScores());
    // b has no token_efficiency_score

    const frontier = computeParetoFrontier([a, b]);
    // A dominates B on 4D (token dimension ignored since B has no score)
    expect(frontier).toHaveLength(1);
    expect(frontier[0].proposal.proposal_id).toBe("a");
  });
});
