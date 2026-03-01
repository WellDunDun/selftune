import { describe, expect, test } from "bun:test";
import { evaluateStoppingCriteria } from "../../cli/selftune/evolution/stopping-criteria.js";

// ---------------------------------------------------------------------------
// evaluateStoppingCriteria
// ---------------------------------------------------------------------------

describe("evaluateStoppingCriteria", () => {
  // ---- Converged ----

  test("stops when pass rate >= 0.95 (converged)", () => {
    const result = evaluateStoppingCriteria(0.96, [0.8, 0.9], 2, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Converged");
  });

  test("stops at exactly 0.95 (boundary)", () => {
    const result = evaluateStoppingCriteria(0.95, [0.8, 0.9], 2, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Converged");
  });

  test("converged takes priority over max iterations", () => {
    const result = evaluateStoppingCriteria(0.98, [0.95], 5, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Converged");
  });

  // ---- Max iterations ----

  test("stops when max iterations reached", () => {
    const result = evaluateStoppingCriteria(0.7, [0.6, 0.65], 5, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Max iterations");
  });

  test("stops when iteration count exceeds max iterations", () => {
    const result = evaluateStoppingCriteria(0.7, [0.6, 0.65], 7, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Max iterations");
  });

  // ---- Low confidence ----

  test("stops when confidence below threshold", () => {
    const result = evaluateStoppingCriteria(0.7, [0.6, 0.65], 2, 5, 0.6, 0.5);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Confidence below threshold");
  });

  test("does not stop when confidence equals threshold", () => {
    const result = evaluateStoppingCriteria(0.75, [0.6, 0.7], 2, 5, 0.6, 0.6);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toContain("Continuing");
  });

  // ---- Plateau ----

  test("stops on plateau (3 iterations no improvement)", () => {
    const result = evaluateStoppingCriteria(0.7, [0.7, 0.7], 3, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Plateau");
  });

  test("stops on plateau with near-identical values (< 1% variation)", () => {
    const result = evaluateStoppingCriteria(0.705, [0.7, 0.702], 3, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Plateau");
  });

  test("plateau not detected with fewer than 3 data points", () => {
    // Only 1 previous rate + current = 2 data points, need 3
    const result = evaluateStoppingCriteria(0.7, [0.7], 2, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toContain("Continuing");
  });

  // ---- Continue ----

  test("continues when improvement is possible", () => {
    const result = evaluateStoppingCriteria(0.75, [0.6, 0.7], 2, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toContain("Continuing");
  });

  test("continues with empty previous rates", () => {
    const result = evaluateStoppingCriteria(0.5, [], 1, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(false);
  });

  test("continues when steady improvement across iterations", () => {
    // Clear upward trend: 0.6 -> 0.7 -> 0.8, variation = 0.2 which is >= 0.01
    const result = evaluateStoppingCriteria(0.8, [0.6, 0.7], 3, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toContain("Continuing");
  });

  // ---- Priority order ----

  test("converged takes priority over low confidence", () => {
    // Pass rate 0.96 (converged) but confidence 0.3 (below 0.6 threshold)
    const result = evaluateStoppingCriteria(0.96, [0.8, 0.9], 2, 5, 0.6, 0.3);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Converged");
  });

  test("max iterations takes priority over plateau", () => {
    // Max iterations reached AND plateau detected
    const result = evaluateStoppingCriteria(0.7, [0.7, 0.7], 5, 5, 0.6, 0.8);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain("Max iterations");
  });
});
