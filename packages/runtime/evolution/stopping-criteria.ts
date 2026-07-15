/**
 * stopping-criteria.ts
 *
 * Evaluates whether the evolution loop should stop based on convergence,
 * iteration limits, and plateau detection.
 * Pure function module with no external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoppingDecision {
  shouldStop: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Stopping criteria evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the evolution loop should stop.
 *
 * Checks conditions in priority order:
 *   1. Converged (pass rate >= 95%)
 *   2. Max iterations reached
 *   3. Plateau (< 1% variation over last 3 iterations)
 *   4. Continue (none of the above)
 */
export function evaluateStoppingCriteria(
  currentPassRate: number,
  previousPassRates: number[],
  iterationCount: number,
  maxIterations: number,
): StoppingDecision {
  // 1. Converged
  if (currentPassRate >= 0.95) {
    return { shouldStop: true, reason: "Converged: pass rate \u2265 95%" };
  }

  // 2. Max iterations
  if (iterationCount >= maxIterations) {
    return { shouldStop: true, reason: "Max iterations reached" };
  }

  // 3. Plateau detection: need at least 2 previous rates to form 3 data points
  if (previousPassRates.length >= 2) {
    const last2Previous = previousPassRates.slice(-2);
    const window = [...last2Previous, currentPassRate];
    const min = Math.min(...window);
    const max = Math.max(...window);

    if (max - min < 0.01) {
      return { shouldStop: true, reason: "Plateau: no improvement in last 3 iterations" };
    }
  }

  // 4. Continue
  return { shouldStop: false, reason: "Continuing: improvement possible" };
}
