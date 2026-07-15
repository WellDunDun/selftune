/**
 * replay-engine.ts
 *
 * Cohesive module for all replay-based validation logic:
 *   - Host/runtime replay (PRIMARY path — real agent routing decisions)
 *   - Custom replay runner support
 *
 * Host/runtime replay is preferred because it captures actual agent routing
 * behavior. If the runtime path is unavailable or fails, callers must fall
 * back explicitly to another validation mode instead of treating simulated
 * fixture matching as equivalent replay evidence.
 *
 * Extracted from validate-routing.ts and validate-body.ts to isolate
 * replay-specific concerns from judge-specific concerns.
 */

import type {
  EvalEntry,
  RoutingReplayEntryResult,
  RoutingReplayFixture,
  ValidationMode,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayRunnerInput {
  routing: string;
  evalSet: EvalEntry[];
  agent: string;
  fixture: RoutingReplayFixture;
}

export type ReplayRunner = (input: ReplayRunnerInput) => Promise<RoutingReplayEntryResult[]>;

export interface ReplayValidationOptions {
  replayFixture?: RoutingReplayFixture;
  /** Host/runtime replay runner — PRIMARY validation path when provided. */
  replayRunner?: ReplayRunner;
}

export interface ReplayValidationResult {
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  validation_mode: ValidationMode;
  validation_agent: string;
  validation_fixture_id?: string;
  per_entry_results?: RoutingReplayEntryResult[];
  /** Before-phase per-entry results for structured persistence. */
  before_entry_results?: RoutingReplayEntryResult[];
}

export interface ReplayValidationAttempt {
  result: ReplayValidationResult | null;
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeReplayResult(
  beforeResults: RoutingReplayEntryResult[],
  afterResults: RoutingReplayEntryResult[],
  total: number,
  mode: ValidationMode,
  agent: string,
  fixtureId: string,
): ReplayValidationResult {
  const beforePassed = beforeResults.filter((result) => result.passed).length;
  const afterPassed = afterResults.filter((result) => result.passed).length;
  const beforePassRate = beforePassed / total;
  const afterPassRate = afterPassed / total;
  const netChange = afterPassRate - beforePassRate;
  const beforePassedByQuery = new Map<string, boolean>();
  let regressionCount = 0;
  let newPassCount = 0;

  for (const result of beforeResults) {
    beforePassedByQuery.set(result.query, result.passed);
  }

  for (const result of afterResults) {
    const beforePass = beforePassedByQuery.get(result.query) ?? false;
    const afterPass = result.passed;
    if (beforePass && !afterPass) regressionCount++;
    if (!beforePass && afterPass) newPassCount++;
  }

  return {
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved:
      afterPassRate > beforePassRate &&
      regressionCount < total * 0.05 &&
      (netChange >= 0.1 || newPassCount >= 2),
    validation_mode: mode,
    validation_agent: agent,
    validation_fixture_id: fixtureId,
    per_entry_results: afterResults,
    before_entry_results: beforeResults,
  };
}

// ---------------------------------------------------------------------------
// Replay validation engine
// ---------------------------------------------------------------------------

/**
 * Attempt replay-backed validation using a real host/runtime runner.
 *
 * Returns a null result with a fallback reason when runtime replay is
 * unavailable or fails. Callers decide whether to fall back to a judge-based
 * validator (`auto`) or surface an explicit unavailable error (`replay`).
 */
export async function runReplayValidation(
  originalContent: string,
  proposedContent: string,
  evalSet: EvalEntry[],
  agent: string,
  options: ReplayValidationOptions = {},
): Promise<ReplayValidationAttempt> {
  if (evalSet.length === 0) {
    return { result: null };
  }

  if (!options.replayFixture) {
    return {
      result: null,
      fallbackReason: "no replay fixture is available for runtime validation",
    };
  }

  if (!options.replayRunner) {
    return {
      result: null,
      fallbackReason: "no real host/runtime replay runner is configured",
    };
  }

  const fixture = options.replayFixture;
  const total = evalSet.length;

  try {
    const beforeResults = await options.replayRunner({
      routing: originalContent,
      evalSet,
      agent,
      fixture,
    });
    const afterResults = await options.replayRunner({
      routing: proposedContent,
      evalSet,
      agent,
      fixture,
    });

    return {
      result: computeReplayResult(
        beforeResults,
        afterResults,
        total,
        "host_replay",
        agent,
        fixture.fixture_id,
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "runtime replay failed before producing a routing decision";
    return {
      result: null,
      fallbackReason: `real host/runtime replay failed: ${message}`,
    };
  }
}
