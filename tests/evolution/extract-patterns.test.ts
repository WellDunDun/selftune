import { describe, expect, test } from "bun:test";
import {
  clusterQueries,
  computeQuerySimilarity,
  extractFailurePatterns,
} from "../../cli/selftune/evolution/extract-patterns.js";
import type { EvalEntry, SkillUsageRecord } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEval(
  query: string,
  shouldTrigger: boolean,
  invocationType: "explicit" | "implicit" | "contextual" | "negative" = "implicit",
): EvalEntry {
  return { query, should_trigger: shouldTrigger, invocation_type: invocationType };
}

function makeUsage(skillName: string, query: string): SkillUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: "sess-1",
    skill_name: skillName,
    skill_path: `/skills/${skillName}`,
    query,
    triggered: true,
  };
}

// ---------------------------------------------------------------------------
// computeQuerySimilarity
// ---------------------------------------------------------------------------

describe("computeQuerySimilarity", () => {
  test("similar queries return similarity > 0.3", () => {
    const sim = computeQuerySimilarity("make slides", "create slides");
    expect(sim).toBeGreaterThan(0.3);
  });

  test("dissimilar queries return similarity < 0.3", () => {
    const sim = computeQuerySimilarity("make slides", "debug python");
    expect(sim).toBeLessThan(0.3);
  });

  test("two empty strings return 0", () => {
    const sim = computeQuerySimilarity("", "");
    expect(sim).toBe(0);
  });

  test("identical queries return 1.0", () => {
    const sim = computeQuerySimilarity("build the app", "build the app");
    expect(sim).toBe(1.0);
  });

  test("completely disjoint queries return 0", () => {
    const sim = computeQuerySimilarity("alpha beta", "gamma delta");
    expect(sim).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clusterQueries
// ---------------------------------------------------------------------------

describe("clusterQueries", () => {
  test("clusters similar queries together", () => {
    const clusters = clusterQueries(["make slides", "create slides", "debug python"]);
    // "make slides" and "create slides" share "slides" => grouped
    // "debug python" shares nothing => separate cluster
    expect(clusters.length).toBe(2);

    const slidesCluster = clusters.find((c) => c.includes("make slides"));
    expect(slidesCluster).toBeDefined();
    expect(slidesCluster).toContain("create slides");

    const debugCluster = clusters.find((c) => c.includes("debug python"));
    expect(debugCluster).toBeDefined();
    expect(debugCluster).not.toContain("make slides");
  });

  test("empty input returns empty array", () => {
    const clusters = clusterQueries([]);
    expect(clusters).toEqual([]);
  });

  test("single query returns single cluster", () => {
    const clusters = clusterQueries(["hello world"]);
    expect(clusters.length).toBe(1);
    expect(clusters[0]).toEqual(["hello world"]);
  });
});

// ---------------------------------------------------------------------------
// extractFailurePatterns
// ---------------------------------------------------------------------------

describe("extractFailurePatterns", () => {
  test("5 missed queries with overlapping terms produce correct pattern count", () => {
    const evals: EvalEntry[] = [
      makeEval("make slides", true, "implicit"),
      makeEval("create slides", true, "implicit"),
      makeEval("build slides", true, "implicit"),
      makeEval("debug python", true, "implicit"),
      makeEval("fix python", true, "implicit"),
    ];
    // no usage => all are missed
    const usage: SkillUsageRecord[] = [];
    const patterns = extractFailurePatterns(evals, usage, "presenter");

    // "slides" queries should cluster (share "slides"), "python" queries should cluster (share "python")
    expect(patterns.length).toBe(2);
  });

  test("empty eval entries returns empty array", () => {
    const patterns = extractFailurePatterns([], [], "myskill");
    expect(patterns).toEqual([]);
  });

  test("mixed invocation types produce separate patterns", () => {
    const evals: EvalEntry[] = [
      makeEval("make slides", true, "explicit"),
      makeEval("create slides", true, "implicit"),
    ];
    const usage: SkillUsageRecord[] = [];
    const patterns = extractFailurePatterns(evals, usage, "presenter");

    // Different invocation types => separate groups => separate patterns
    // even though the queries are similar, they are grouped by invocation_type first
    const types = new Set(patterns.map((p) => p.invocation_type));
    expect(types.size).toBe(2);
    expect(types.has("explicit")).toBe(true);
    expect(types.has("implicit")).toBe(true);
  });

  test("all triggered queries (no misses) returns empty array", () => {
    const evals: EvalEntry[] = [
      makeEval("make slides", true, "implicit"),
      makeEval("create slides", true, "implicit"),
    ];
    const usage: SkillUsageRecord[] = [
      makeUsage("presenter", "make slides"),
      makeUsage("presenter", "create slides"),
    ];
    const patterns = extractFailurePatterns(evals, usage, "presenter");
    expect(patterns).toEqual([]);
  });

  test("patterns sorted by frequency descending", () => {
    const evals: EvalEntry[] = [
      // 3 queries that cluster together (slides group)
      makeEval("make slides", true, "implicit"),
      makeEval("create slides", true, "implicit"),
      makeEval("build slides", true, "implicit"),
      // 1 query alone (debug group)
      makeEval("debug python", true, "implicit"),
    ];
    const usage: SkillUsageRecord[] = [];
    const patterns = extractFailurePatterns(evals, usage, "presenter");

    expect(patterns.length).toBeGreaterThanOrEqual(2);
    // First pattern should have highest frequency
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i - 1].frequency).toBeGreaterThanOrEqual(patterns[i].frequency);
    }
  });

  test("single missed query creates a single pattern with frequency 1", () => {
    const evals: EvalEntry[] = [makeEval("run linter", true, "implicit")];
    const usage: SkillUsageRecord[] = [];
    const patterns = extractFailurePatterns(evals, usage, "linter");

    expect(patterns.length).toBe(1);
    expect(patterns[0].frequency).toBe(1);
    expect(patterns[0].missed_queries).toEqual(["run linter"]);
  });

  test("pattern has correct structure", () => {
    const evals: EvalEntry[] = [makeEval("run tests", true, "explicit")];
    const usage: SkillUsageRecord[] = [];
    const patterns = extractFailurePatterns(evals, usage, "tester");

    expect(patterns.length).toBe(1);
    const p = patterns[0];
    expect(p.pattern_id).toMatch(/^fp-tester-\d+$/);
    expect(p.skill_name).toBe("tester");
    expect(p.invocation_type).toBe("explicit");
    expect(p.missed_queries).toEqual(["run tests"]);
    expect(p.frequency).toBe(1);
    expect(p.sample_sessions).toEqual([]);
    expect(typeof p.extracted_at).toBe("string");
    // Verify it's a valid ISO date
    expect(Number.isNaN(Date.parse(p.extracted_at))).toBe(false);
  });

  test("should_trigger=false entries are ignored", () => {
    const evals: EvalEntry[] = [
      makeEval("make slides", true, "implicit"),
      makeEval("unrelated thing", false, "negative"),
      makeEval("another negative", false, "negative"),
    ];
    const usage: SkillUsageRecord[] = [];
    const patterns = extractFailurePatterns(evals, usage, "presenter");

    // Only the should_trigger=true entry that is missed should produce a pattern
    expect(patterns.length).toBe(1);
    expect(patterns[0].missed_queries).toEqual(["make slides"]);
  });

  test("only skill usage for the target skill is considered", () => {
    const evals: EvalEntry[] = [makeEval("make slides", true, "implicit")];
    // Usage exists but for a DIFFERENT skill
    const usage: SkillUsageRecord[] = [makeUsage("other-skill", "make slides")];
    const patterns = extractFailurePatterns(evals, usage, "presenter");

    // "make slides" was not triggered for "presenter", so it should be missed
    expect(patterns.length).toBe(1);
    expect(patterns[0].missed_queries).toEqual(["make slides"]);
  });

  test("attaches feedback from grading results to patterns", () => {
    const evals: EvalEntry[] = [
      makeEval("make slides", true, "implicit"),
    ];
    const usage: SkillUsageRecord[] = [];
    const gradingResults = [{
      session_id: "s1", skill_name: "presenter", transcript_path: "",
      graded_at: "", expectations: [], summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      execution_metrics: { tool_calls: {}, total_tool_calls: 0, total_steps: 0, bash_commands_run: 0, errors_encountered: 0, skills_triggered: [], transcript_chars: 0 },
      claims: [], eval_feedback: { suggestions: [], overall: "" },
      failure_feedback: [{
        query: "make slides",
        failure_reason: "Description lacks slide keywords",
        improvement_hint: "Add presentation triggers",
      }],
    }];

    const patterns = extractFailurePatterns(evals, usage, "presenter", gradingResults);
    expect(patterns.length).toBe(1);
    expect(patterns[0].feedback).toBeDefined();
    expect(patterns[0].feedback!.length).toBe(1);
    expect(patterns[0].feedback![0].failure_reason).toBe("Description lacks slide keywords");
  });

  test("no feedback when grading results have no failure_feedback", () => {
    const evals: EvalEntry[] = [makeEval("make slides", true, "implicit")];
    const gradingResults = [{
      session_id: "s1", skill_name: "presenter", transcript_path: "",
      graded_at: "", expectations: [], summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      execution_metrics: { tool_calls: {}, total_tool_calls: 0, total_steps: 0, bash_commands_run: 0, errors_encountered: 0, skills_triggered: [], transcript_chars: 0 },
      claims: [], eval_feedback: { suggestions: [], overall: "" },
    }];

    const patterns = extractFailurePatterns(evals, [], "presenter", gradingResults);
    expect(patterns[0].feedback).toBeUndefined();
  });

  test("feedback not attached when no gradingResults provided", () => {
    const evals: EvalEntry[] = [makeEval("make slides", true, "implicit")];
    const patterns = extractFailurePatterns(evals, [], "presenter");
    expect(patterns[0].feedback).toBeUndefined();
  });

  test("feedback matches by query string", () => {
    const evals: EvalEntry[] = [
      makeEval("make slides", true, "implicit"),
      makeEval("debug python", true, "implicit"),
    ];
    const gradingResults = [{
      session_id: "s1", skill_name: "presenter", transcript_path: "",
      graded_at: "", expectations: [], summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      execution_metrics: { tool_calls: {}, total_tool_calls: 0, total_steps: 0, bash_commands_run: 0, errors_encountered: 0, skills_triggered: [], transcript_chars: 0 },
      claims: [], eval_feedback: { suggestions: [], overall: "" },
      failure_feedback: [{
        query: "make slides",
        failure_reason: "Missing slide keywords",
        improvement_hint: "Add slide triggers",
      }],
    }];

    const patterns = extractFailurePatterns(evals, [], "presenter", gradingResults);
    // Only the pattern containing "make slides" should have feedback
    const withFeedback = patterns.filter(p => p.feedback && p.feedback.length > 0);
    expect(withFeedback.length).toBe(1);
  });
});
