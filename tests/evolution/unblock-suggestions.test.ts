import { describe, expect, test } from "bun:test";

import type { EvolveResult } from "../../cli/selftune/evolution/evolve.js";
import { buildUnblockSuggestions } from "../../cli/selftune/evolution/unblock-suggestions.js";

/** Minimal EvolveResult stub for testing. */
function stubResult(overrides: Partial<EvolveResult> = {}): EvolveResult {
  return {
    proposal: null,
    validation: null,
    deployed: false,
    auditEntries: [],
    reason: "",
    llmCallCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("buildUnblockSuggestions", () => {
  // --- Path/config failures ---

  test("SKILL.md not found suggests verifying path and re-init", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "SKILL.md not found at /foo/SKILL.md" }),
      "my-skill",
    );
    expect(s.length).toBe(2);
    expect(s[0]).toContain("--skill-path");
    expect(s[1]).toContain("selftune init");
  });

  test("failed eval set suggests sync", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Failed to load eval set: file missing" }),
      "my-skill",
    );
    expect(s.length).toBe(2);
    expect(s[0]).toContain("selftune sync");
    expect(s[1]).toContain("selftune evolve --skill my-skill");
  });

  test("not a JSON array suggests sync", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Eval set at /foo is not a JSON array" }),
      "my-skill",
    );
    expect(s[0]).toContain("selftune sync");
  });

  // --- No signal failures ---

  test("no failure patterns suggests checking status", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "No failure patterns found" }),
      "my-skill",
    );
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s[0]).toContain("selftune status");
    expect(s[1]).toContain("sessions");
  });

  test("no failure patterns with low quality score includes quality hints", () => {
    const s = buildUnblockSuggestions(
      stubResult({
        reason: "No failure patterns found",
        descriptionQualityBefore: 0.3,
        proposal: {
          proposal_id: "test",
          skill_name: "my-skill",
          skill_path: "/test",
          original_description: "stuff",
          proposed_description: "stuff",
          rationale: "",
          failure_patterns: [],
          eval_results: {
            before: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
            after: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
          },
          confidence: 0.5,
          created_at: "",
          status: "pending",
        },
      }),
      "my-skill",
    );
    expect(s.some((h) => h.includes("Description quality"))).toBe(true);
  });

  // --- Confidence failures ---

  test("confidence threshold suggests lowering threshold", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Confidence 0.45 below threshold 0.6" }),
      "my-skill",
    );
    expect(s[0]).toContain("--confidence 0.4");
  });

  test("no candidates met confidence suggests more candidates", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "No candidates met confidence threshold 0.6" }),
      "my-skill",
    );
    expect(s[0]).toContain("--confidence 0.4");
    expect(s[1]).toContain("--candidates");
  });

  // --- Validation failures ---

  test("validation failed suggests verbose and pareto", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Validation failed after 3 iterations: net_change=-0.050" }),
      "my-skill",
    );
    expect(s[0]).toContain("--verbose");
    expect(s[1]).toContain("--pareto");
  });

  test("validation failed with regressions mentions regression count", () => {
    const s = buildUnblockSuggestions(
      stubResult({
        reason: "Validation failed after 3 iterations: net_change=-0.050",
        validation: {
          proposal_id: "test",
          before_pass_rate: 0.8,
          after_pass_rate: 0.7,
          improved: false,
          regressions: [{ query: "q1", should_trigger: true }] as any,
          new_passes: [],
          net_change: -0.1,
        },
      }),
      "my-skill",
    );
    expect(s.some((h) => h.includes("1 regressions"))).toBe(true);
  });

  test("no Pareto candidates suggests rebalancing", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "No Pareto candidates improved validation" }),
      "my-skill",
    );
    expect(s[0]).toContain("rebalancing");
    expect(s[1]).toContain("selftune sync --force");
  });

  // --- Gate failures ---

  test("baseline gate failed suggests collecting more data", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Baseline gate failed: lift=0.030 below 0.05 threshold" }),
      "my-skill",
    );
    expect(s[0]).toContain("marginal");
    expect(s[1]).toContain("session data");
  });

  test("gate validation failed suggests no-gate", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Gate validation failed (sonnet): net_change=-0.02" }),
      "my-skill",
    );
    expect(s[1]).toContain("--full-model");
  });

  // --- Constitutional ---

  test("constitutional rejection suggests manual adjustment", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Constitutional: description too broad" }),
      "my-skill",
    );
    expect(s[0]).toContain("safety constraints");
    expect(s[1]).toContain("manually adjust");
  });

  // --- Dry run ---

  test("dry run suggests removing flag", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Dry run - proposal validated but not deployed" }),
      "my-skill",
    );
    expect(s[0]).toContain("remove --dry-run");
  });

  // --- Error ---

  test("error suggests verbose and doctor", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Error during evolution: ENOENT" }),
      "my-skill",
    );
    expect(s[0]).toContain("--verbose");
    expect(s[1]).toContain("selftune doctor");
  });

  // --- Unknown reason ---

  test("unknown reason returns empty suggestions", () => {
    const s = buildUnblockSuggestions(
      stubResult({ reason: "Something completely unexpected happened" }),
      "my-skill",
    );
    expect(s).toEqual([]);
  });
});
