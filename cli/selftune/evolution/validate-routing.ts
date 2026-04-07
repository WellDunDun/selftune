/**
 * validate-routing.ts
 *
 * Validates a routing table evolution proposal by checking structural validity
 * and running trigger accuracy checks against an eval set.
 *
 * Delegates replay-based and judge-based validation to dedicated engines
 * (engines/replay-engine.ts and engines/judge-engine.ts).
 */

import type {
  BodyEvolutionProposal,
  BodyValidationResult,
  EvalEntry,
  RoutingReplayEntryResult,
  ValidationMode,
} from "../types.js";
import { runJudgeValidation } from "./engines/judge-engine.js";
import {
  runReplayValidation,
  type ReplayRunner,
  type ReplayRunnerInput,
  type ReplayValidationOptions,
} from "./engines/replay-engine.js";

// Re-export engine types for backward compatibility
export type { ReplayRunnerInput as RoutingReplayRunnerInput };
export type { ReplayRunner as RoutingReplayRunner };
export type { ReplayValidationOptions as RoutingValidationOptions };

export interface RoutingTriggerAccuracyResult {
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  validation_mode: ValidationMode;
  validation_agent: string;
  validation_fixture_id?: string;
  per_entry_results?: RoutingReplayEntryResult[];
  before_entry_results?: RoutingReplayEntryResult[];
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/**
 * Check that a routing table is valid markdown table syntax with
 * `| Trigger | Workflow |` columns.
 */
export function validateRoutingStructure(routing: string): { valid: boolean; reason: string } {
  const lines = routing
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { valid: false, reason: "Routing table must have at least a header and one data row" };
  }

  // Check header row contains Trigger and Workflow columns
  const headerLine = lines[0].trim();
  if (!headerLine.startsWith("|") || !headerLine.endsWith("|")) {
    return {
      valid: false,
      reason: "Header row must be a markdown table row starting and ending with |",
    };
  }

  const headerLower = headerLine.toLowerCase();
  if (!headerLower.includes("trigger") || !headerLower.includes("workflow")) {
    return { valid: false, reason: "Header must contain 'Trigger' and 'Workflow' columns" };
  }

  // Check separator row (line 2) has dashes
  const separatorLine = lines[1].trim();
  if (!separatorLine.includes("---")) {
    return { valid: false, reason: "Second row must be a markdown table separator (contains ---)" };
  }

  // Check at least one data row
  if (lines.length < 3) {
    return { valid: false, reason: "Routing table must have at least one data row" };
  }

  // Check data rows are pipe-delimited
  for (let i = 2; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row.startsWith("|") || !row.endsWith("|")) {
      return { valid: false, reason: `Data row ${i - 1} is not a valid markdown table row` };
    }
  }

  return { valid: true, reason: "Valid markdown routing table" };
}

// ---------------------------------------------------------------------------
// Trigger accuracy validation
// ---------------------------------------------------------------------------

/**
 * Run before/after trigger checks on the eval set using the routing content.
 * Returns pass rates for comparison.
 *
 * Prefers replay-backed validation when a fixture is available,
 * falls back to LLM judge otherwise.
 */
export async function validateRoutingTriggerAccuracy(
  originalRouting: string,
  proposedRouting: string,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
  options: ReplayValidationOptions = {},
): Promise<RoutingTriggerAccuracyResult> {
  if (evalSet.length === 0) {
    return {
      before_pass_rate: 0,
      after_pass_rate: 0,
      improved: false,
      validation_mode: "structural_guard",
      validation_agent: agent,
    };
  }

  // Try replay-backed validation first
  const replayResult = await runReplayValidation(
    originalRouting,
    proposedRouting,
    evalSet,
    agent,
    options,
  );

  if (replayResult) {
    return replayResult;
  }

  // Fall back to LLM judge
  const judgeResult = await runJudgeValidation(
    originalRouting,
    proposedRouting,
    evalSet,
    agent,
    modelFlag,
  );

  return {
    before_pass_rate: judgeResult.before_pass_rate,
    after_pass_rate: judgeResult.after_pass_rate,
    improved: judgeResult.improved,
    validation_mode: judgeResult.validation_mode,
    validation_agent: judgeResult.validation_agent,
  };
}

// ---------------------------------------------------------------------------
// Full routing validation
// ---------------------------------------------------------------------------

/** Validate a routing table proposal: structural check + trigger accuracy. */
export async function validateRoutingProposal(
  proposal: BodyEvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
  options: ReplayValidationOptions = {},
): Promise<BodyValidationResult> {
  const gateResults: Array<{ gate: string; passed: boolean; reason: string }> = [];

  // Gate 1: Structural validation
  const structural = validateRoutingStructure(proposal.proposed_body);
  gateResults.push({
    gate: "structural",
    passed: structural.valid,
    reason: structural.reason,
  });

  if (!structural.valid) {
    return {
      proposal_id: proposal.proposal_id,
      gates_passed: 0,
      gates_total: 2,
      gate_results: gateResults,
      improved: false,
      regressions: [],
      validation_mode: "structural_guard",
      validation_agent: agent,
    };
  }

  // Gate 2: Trigger accuracy
  const accuracy = await validateRoutingTriggerAccuracy(
    proposal.original_body,
    proposal.proposed_body,
    evalSet,
    agent,
    modelFlag,
    options,
  );
  gateResults.push({
    gate: "trigger_accuracy",
    passed: accuracy.improved,
    reason: accuracy.improved
      ? `Improved via ${accuracy.validation_mode}: ${(accuracy.before_pass_rate * 100).toFixed(1)}% -> ${(accuracy.after_pass_rate * 100).toFixed(1)}%`
      : `Not improved via ${accuracy.validation_mode}: ${(accuracy.before_pass_rate * 100).toFixed(1)}% -> ${(accuracy.after_pass_rate * 100).toFixed(1)}%`,
  });

  const gatesPassed = gateResults.filter((g) => g.passed).length;

  return {
    proposal_id: proposal.proposal_id,
    gates_passed: gatesPassed,
    gates_total: 2,
    gate_results: gateResults,
    improved: gatesPassed === 2,
    regressions: [],
    validation_mode: accuracy.validation_mode,
    validation_agent: accuracy.validation_agent,
    validation_fixture_id: accuracy.validation_fixture_id,
    before_pass_rate: accuracy.before_pass_rate,
    after_pass_rate: accuracy.after_pass_rate,
    per_entry_results: accuracy.per_entry_results,
    before_entry_results: accuracy.before_entry_results,
  };
}
