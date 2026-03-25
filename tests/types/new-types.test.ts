import { describe, expect, test } from "bun:test";

import type {
  FailureFeedback,
  FailurePattern,
  GraderOutput,
  GradingExpectation,
  GradingSummary,
  InvocationTypeScores,
  ParetoCandidate,
  ParetoSelectionResult,
} from "../../cli/selftune/types.js";

describe("new type definitions", () => {
  test("GradingExpectation accepts optional score and source", () => {
    const exp: GradingExpectation = { text: "test", passed: true, evidence: "found" };
    expect(exp.score).toBeUndefined();
    expect(exp.source).toBeUndefined();

    const expWithScore: GradingExpectation = {
      text: "test",
      passed: true,
      evidence: "found",
      score: 0.85,
      source: "pre-gate",
    };
    expect(expWithScore.score).toBe(0.85);
    expect(expWithScore.source).toBe("pre-gate");
  });

  test("GradingSummary accepts optional mean_score and score_std_dev", () => {
    const summary: GradingSummary = { passed: 5, failed: 1, total: 6, pass_rate: 0.83 };
    expect(summary.mean_score).toBeUndefined();

    const summaryWithScores: GradingSummary = {
      passed: 5,
      failed: 1,
      total: 6,
      pass_rate: 0.83,
      mean_score: 0.78,
      score_std_dev: 0.12,
    };
    expect(summaryWithScores.mean_score).toBe(0.78);
  });

  test("FailureFeedback interface compiles correctly", () => {
    const feedback: FailureFeedback = {
      query: "make a slide deck",
      failure_reason: "Description lacks slide keywords",
      improvement_hint: "Add presentation/slides triggers",
    };
    expect(feedback.query).toBe("make a slide deck");
    expect(feedback.invocation_type).toBeUndefined();
  });

  test("GraderOutput and GradingResult accept optional failure_feedback", () => {
    const output: GraderOutput = {
      expectations: [],
      summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "" },
    };
    expect(output.failure_feedback).toBeUndefined();
  });

  test("FailurePattern accepts optional feedback field", () => {
    const pattern: FailurePattern = {
      pattern_id: "fp-1",
      skill_name: "test",
      invocation_type: "implicit",
      missed_queries: ["q1"],
      frequency: 1,
      sample_sessions: [],
      extracted_at: new Date().toISOString(),
    };
    expect(pattern.feedback).toBeUndefined();
  });

  test("InvocationTypeScores has all four dimensions", () => {
    const scores: InvocationTypeScores = {
      explicit: { passed: 5, total: 6, pass_rate: 0.83 },
      implicit: { passed: 4, total: 5, pass_rate: 0.8 },
      contextual: { passed: 3, total: 4, pass_rate: 0.75 },
      negative: { passed: 2, total: 3, pass_rate: 0.67 },
    };
    expect(scores.explicit.pass_rate).toBe(0.83);
  });

  test("ParetoCandidate compiles with all required fields", () => {
    const candidate: ParetoCandidate = {
      proposal: {
        proposal_id: "evo-1",
        skill_name: "test",
        skill_path: "/test",
        original_description: "old",
        proposed_description: "new",
        rationale: "r",
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
        proposal_id: "evo-1",
        before_pass_rate: 0.5,
        after_pass_rate: 0.8,
        improved: true,
        regressions: [],
        new_passes: [],
        net_change: 0.3,
      },
      invocation_scores: {
        explicit: { passed: 5, total: 6, pass_rate: 0.83 },
        implicit: { passed: 4, total: 5, pass_rate: 0.8 },
        contextual: { passed: 3, total: 4, pass_rate: 0.75 },
        negative: { passed: 2, total: 3, pass_rate: 0.67 },
      },
      dominates_on: ["explicit", "implicit"],
    };
    expect(candidate.dominates_on).toHaveLength(2);
  });

  test("ParetoSelectionResult compiles correctly", () => {
    const result: ParetoSelectionResult = {
      selected_proposal: {
        proposal_id: "evo-1",
        skill_name: "test",
        skill_path: "/test",
        original_description: "old",
        proposed_description: "new",
        rationale: "r",
        failure_patterns: [],
        eval_results: {
          before: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
          after: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
        },
        confidence: 0.8,
        created_at: "",
        status: "pending",
      },
      frontier: [],
      merge_applied: false,
      merge_sources: [],
    };
    expect(result.merge_applied).toBe(false);
  });

  test("backward compatibility: existing types work without new fields", () => {
    const oldExpectation: GradingExpectation = { text: "test", passed: true, evidence: "ok" };
    const oldSummary: GradingSummary = { passed: 1, failed: 0, total: 1, pass_rate: 1 };
    const oldPattern: FailurePattern = {
      pattern_id: "fp-1",
      skill_name: "s",
      invocation_type: "explicit",
      missed_queries: [],
      frequency: 0,
      sample_sessions: [],
      extracted_at: "",
    };
    expect(oldExpectation.text).toBe("test");
    expect(oldSummary.pass_rate).toBe(1);
    expect(oldPattern.pattern_id).toBe("fp-1");
  });
});
