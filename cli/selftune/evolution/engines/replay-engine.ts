/**
 * replay-engine.ts
 *
 * Cohesive module for all replay-based validation logic:
 *   - Host/runtime replay (PRIMARY path — real agent routing decisions)
 *   - Fixture-backed replay (FALLBACK — surface similarity matching)
 *   - Custom replay runner support
 *
 * Host/runtime replay is preferred because it captures actual agent routing
 * behavior. Fixture-backed replay is used as a fallback when no invoker is
 * provided or when the invoker returns an error.
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
import { runHostReplayFixture } from "../validate-host-replay.js";

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
 * Attempt replay-backed validation. Prefers host/runtime replay when a
 * replayRunner is provided; falls back to fixture-based replay when:
 *   - No replayRunner is provided
 *   - The replayRunner throws an error
 *
 * Returns null if no replay path is available (no fixture provided).
 */
export async function runReplayValidation(
  originalContent: string,
  proposedContent: string,
  evalSet: EvalEntry[],
  agent: string,
  options: ReplayValidationOptions = {},
): Promise<ReplayValidationResult | null> {
  if (evalSet.length === 0 || !options.replayFixture) {
    return null;
  }

  const fixture = options.replayFixture;
  const total = evalSet.length;

  // PRIMARY path: Host/runtime replay when a runner is provided
  if (options.replayRunner) {
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

      return computeReplayResult(
        beforeResults,
        afterResults,
        total,
        "host_replay",
        agent,
        fixture.fixture_id,
      );
    } catch {
      // Host replay failed — fall through to fixture-based fallback
    }
  }

  // FALLBACK path: Fixture-backed replay (surface similarity matching)
  const beforeResults = runHostReplayFixture({
    routing: originalContent,
    evalSet,
    fixture,
  });
  const afterResults = runHostReplayFixture({
    routing: proposedContent,
    evalSet,
    fixture,
  });

  return computeReplayResult(
    beforeResults,
    afterResults,
    total,
    "fixture_replay",
    agent,
    fixture.fixture_id,
  );
}
