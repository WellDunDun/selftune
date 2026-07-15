/**
 * Tests for computeWatchTrustScore — the trust signal derived from watch results.
 */

import { describe, expect, test } from "bun:test";

import { computeWatchTrustScore } from "../../packages/runtime/monitoring/watch.js";
import type { WatchResult } from "../../packages/runtime/monitoring/watch.js";
import type { MonitoringSnapshot } from "../../packages/runtime/types.js";

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    timestamp: "2026-04-15T12:00:00Z",
    skill_name: "test-skill",
    window_sessions: 20,
    skill_checks: 10,
    pass_rate: 0.9,
    false_negative_rate: 0.1,
    by_invocation_type: {
      explicit: { passed: 5, total: 5 },
      implicit: { passed: 3, total: 3 },
      contextual: { passed: 1, total: 1 },
      negative: { passed: 0, total: 1 },
    },
    regression_detected: false,
    baseline_pass_rate: 0.8,
    ...overrides,
  };
}

function makeWatchResult(overrides: Partial<WatchResult> = {}): WatchResult {
  return {
    snapshot: makeSnapshot(),
    alert: null,
    rolledBack: false,
    recommendation: 'Skill "test-skill" is stable.',
    gradeAlert: null,
    gradeRegression: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeWatchTrustScore", () => {
  test("returns 1.0 for a healthy skill with no regressions", () => {
    const result = makeWatchResult();
    expect(computeWatchTrustScore(result)).toBe(1.0);
  });

  test("returns 0.5 for skill with insufficient data", () => {
    const result = makeWatchResult({
      snapshot: makeSnapshot({ skill_checks: 2 }),
    });
    expect(computeWatchTrustScore(result)).toBe(0.5);
  });

  test("penalizes trigger regression by 0.5", () => {
    const result = makeWatchResult({
      snapshot: makeSnapshot({ regression_detected: true }),
      alert: "regression detected",
    });
    expect(computeWatchTrustScore(result)).toBe(0.5);
  });

  test("penalizes grade regression proportional to delta", () => {
    const result = makeWatchResult({
      gradeRegression: { before: 0.9, after: 0.7, delta: 0.2 },
      gradeAlert: "grade regression",
      alert: "grade regression",
    });
    // delta 0.2 * 2 = 0.4 but capped at 0.3
    // No trigger regression, but has alert without trigger regression -> no extra 0.2
    // Wait: alert is present, gradeRegression is present, regression_detected is false
    // Score = 1.0 - 0.3 (grade) = 0.7
    expect(computeWatchTrustScore(result)).toBe(0.7);
  });

  test("compounds trigger and grade regression penalties", () => {
    const result = makeWatchResult({
      snapshot: makeSnapshot({ regression_detected: true }),
      alert: "regression + grade regression",
      gradeRegression: { before: 0.9, after: 0.7, delta: 0.2 },
      gradeAlert: "grade regression",
    });
    // 1.0 - 0.5 (trigger) - 0.3 (grade, delta 0.2*2=0.4 capped at 0.3) = 0.2
    expect(computeWatchTrustScore(result)).toBe(0.2);
  });

  test("rollback adds additional penalty", () => {
    const result = makeWatchResult({
      snapshot: makeSnapshot({ regression_detected: true }),
      alert: "regression detected",
      rolledBack: true,
    });
    // 1.0 - 0.5 (trigger) - 0.2 (rollback) = 0.3
    expect(computeWatchTrustScore(result)).toBe(0.3);
  });

  test("clamps score to 0 minimum", () => {
    const result = makeWatchResult({
      snapshot: makeSnapshot({ regression_detected: true }),
      alert: "regression + grade regression",
      gradeRegression: { before: 0.9, after: 0.4, delta: 0.5 },
      gradeAlert: "grade regression",
      rolledBack: true,
    });
    // 1.0 - 0.5 - 0.3 - 0.2 = 0.0
    expect(computeWatchTrustScore(result)).toBe(0);
  });

  test("small grade regression has proportional penalty", () => {
    const result = makeWatchResult({
      gradeRegression: { before: 0.85, after: 0.8, delta: 0.05 },
      gradeAlert: "grade regression",
      alert: "grade regression",
    });
    // delta 0.05 * 2 = 0.1 (below cap of 0.3)
    // No trigger regression, grade present -> 1.0 - 0.1 = 0.9
    expect(computeWatchTrustScore(result)).toBe(0.9);
  });

  test("alert without specific regression has 0.2 penalty", () => {
    const result = makeWatchResult({
      alert: "some generic alert",
    });
    // No trigger regression, no grade regression, but alert present -> catch-all -0.2
    expect(computeWatchTrustScore(result)).toBe(0.8);
  });
});
