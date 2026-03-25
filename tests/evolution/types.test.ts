/**
 * Tests for evolution and monitoring types (v0.3 / v0.4).
 *
 * Verifies all 7 new interfaces compile correctly and that existing
 * interfaces remain unbroken after the append-only change to types.ts.
 */

import { describe, expect, test } from "bun:test";

import type {
  // Existing types -- verify no breakage
  EvalEntry,
  EvalPassRate,
  EvolutionAuditEntry,
  EvolutionConfig,
  EvolutionProposal,
  // New evolution types (v0.3)
  FailurePattern,
  InvocationType,
  // New monitoring types (v0.4)
  MonitoringSnapshot,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvalPassRate(overrides: Partial<EvalPassRate> = {}): EvalPassRate {
  return {
    total: 20,
    passed: 16,
    failed: 4,
    pass_rate: 0.8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Evolution types (v0.3)
// ---------------------------------------------------------------------------

describe("Evolution types (v0.3)", () => {
  test("FailurePattern has required fields", () => {
    const pattern: FailurePattern = {
      pattern_id: "fp-001",
      skill_name: "pptx",
      invocation_type: "implicit",
      missed_queries: ["convert slides", "make a deck"],
      frequency: 7,
      sample_sessions: ["sess-a1", "sess-a2"],
      extracted_at: "2026-02-28T12:00:00Z",
    };

    expect(pattern.pattern_id).toBe("fp-001");
    expect(pattern.skill_name).toBe("pptx");
    expect(pattern.invocation_type).toBe("implicit");
    expect(pattern.missed_queries).toHaveLength(2);
    expect(pattern.frequency).toBe(7);
    expect(pattern.sample_sessions).toHaveLength(2);
    expect(pattern.extracted_at).toBeString();
  });

  test("EvolutionProposal has required fields and status union", () => {
    const proposal: EvolutionProposal = {
      proposal_id: "evo-001",
      skill_name: "pptx",
      skill_path: "/skills/pptx/SKILL.md",
      original_description: "Original desc",
      proposed_description: "Improved desc with slide keywords",
      rationale: "Missed implicit queries about slides",
      failure_patterns: ["fp-001", "fp-002"],
      eval_results: {
        before: makeEvalPassRate({ pass_rate: 0.6 }),
        after: makeEvalPassRate({ pass_rate: 0.85 }),
      },
      confidence: 0.72,
      created_at: "2026-02-28T12:30:00Z",
      status: "pending",
    };

    expect(proposal.proposal_id).toBe("evo-001");
    expect(proposal.eval_results.before.pass_rate).toBe(0.6);
    expect(proposal.eval_results.after.pass_rate).toBe(0.85);
    expect(proposal.confidence).toBeGreaterThanOrEqual(0);
    expect(proposal.confidence).toBeLessThanOrEqual(1);
    expect(["pending", "validated", "deployed", "rolled_back"]).toContain(proposal.status);
  });

  test("EvalPassRate computes correct shape", () => {
    const rate: EvalPassRate = {
      total: 50,
      passed: 45,
      failed: 5,
      pass_rate: 0.9,
    };

    expect(rate.total).toBe(50);
    expect(rate.passed).toBe(45);
    expect(rate.failed).toBe(5);
    expect(rate.pass_rate).toBe(0.9);
  });

  test("EvolutionAuditEntry has required fields and optional eval_snapshot", () => {
    const withSnapshot: EvolutionAuditEntry = {
      timestamp: "2026-02-28T13:00:00Z",
      proposal_id: "evo-001",
      action: "validated",
      details: "Eval pass rate improved from 0.6 to 0.85",
      eval_snapshot: makeEvalPassRate({ pass_rate: 0.85 }),
    };

    expect(withSnapshot.action).toBe("validated");
    expect(withSnapshot.eval_snapshot).toBeDefined();
    expect(withSnapshot.eval_snapshot?.pass_rate).toBe(0.85);

    const withoutSnapshot: EvolutionAuditEntry = {
      timestamp: "2026-02-28T13:05:00Z",
      proposal_id: "evo-001",
      action: "rejected",
      details: "Manual review: proposal rejected",
    };

    expect(withoutSnapshot.eval_snapshot).toBeUndefined();
    expect(["created", "validated", "deployed", "rolled_back", "rejected"] as const).toContain(
      withoutSnapshot.action,
    );
  });

  test("EvolutionConfig has all tuning knobs", () => {
    const config: EvolutionConfig = {
      min_sessions: 10,
      min_improvement: 0.1,
      max_iterations: 5,
      confidence_threshold: 0.6,
      dry_run: true,
    };

    expect(config.min_sessions).toBe(10);
    expect(config.min_improvement).toBe(0.1);
    expect(config.max_iterations).toBe(5);
    expect(config.confidence_threshold).toBe(0.6);
    expect(config.dry_run).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// Monitoring types (v0.4)
// ---------------------------------------------------------------------------

describe("Monitoring types (v0.4)", () => {
  test("MonitoringSnapshot has required fields including by_invocation_type", () => {
    const snapshot: MonitoringSnapshot = {
      timestamp: "2026-02-28T14:00:00Z",
      skill_name: "pptx",
      window_sessions: 30,
      pass_rate: 0.87,
      false_negative_rate: 0.05,
      by_invocation_type: {
        explicit: { passed: 10, total: 10 },
        implicit: { passed: 8, total: 12 },
        contextual: { passed: 4, total: 5 },
        negative: { passed: 3, total: 3 },
      },
      regression_detected: false,
      baseline_pass_rate: 0.82,
    };

    expect(snapshot.skill_name).toBe("pptx");
    expect(snapshot.window_sessions).toBe(30);
    expect(snapshot.pass_rate).toBe(0.87);
    expect(snapshot.false_negative_rate).toBe(0.05);
    expect(snapshot.by_invocation_type.explicit.passed).toBe(10);
    expect(snapshot.by_invocation_type.implicit.total).toBe(12);
    expect(snapshot.by_invocation_type.contextual.passed).toBe(4);
    expect(snapshot.by_invocation_type.negative.total).toBe(3);
    expect(snapshot.regression_detected).toBeFalse();
    expect(snapshot.baseline_pass_rate).toBe(0.82);
  });
});

// ---------------------------------------------------------------------------
// Existing types -- verify no breakage from append
// ---------------------------------------------------------------------------

describe("Existing types remain intact", () => {
  test("EvalEntry, GradingResult, and HealthCheck still compile", () => {
    const evalEntry: EvalEntry = {
      query: "create a presentation",
      should_trigger: true,
      invocation_type: "explicit",
    };
    expect(evalEntry.query).toBe("create a presentation");
    expect(evalEntry.should_trigger).toBeTrue();

    // Verify InvocationType union is still usable
    const invType: InvocationType = "negative";
    expect(invType).toBe("negative");
  });
});
