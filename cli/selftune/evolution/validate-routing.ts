/**
 * validate-routing.ts
 *
 * Validates a routing table evolution proposal by checking structural validity
 * and running trigger accuracy checks against an eval set.
 */

import type {
  BodyEvolutionProposal,
  BodyValidationResult,
  EvalEntry,
  RoutingReplayEntryResult,
  RoutingReplayFixture,
  ValidationMode,
} from "../types.js";
import { callLlm } from "../utils/llm-call.js";
import { buildTriggerCheckPrompt, parseTriggerResponse } from "../utils/trigger-check.js";
import { runHostReplayFixture } from "./validate-host-replay.js";

export interface RoutingReplayRunnerInput {
  routing: string;
  evalSet: EvalEntry[];
  agent: string;
  fixture: RoutingReplayFixture;
}

export type RoutingReplayRunner = (
  input: RoutingReplayRunnerInput,
) => Promise<RoutingReplayEntryResult[]>;

export interface RoutingValidationOptions {
  replayFixture?: RoutingReplayFixture;
  replayRunner?: RoutingReplayRunner;
}

export interface RoutingTriggerAccuracyResult {
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  validation_mode: ValidationMode;
  validation_agent: string;
  validation_fixture_id?: string;
  per_entry_results?: RoutingReplayEntryResult[];
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
 */
export async function validateRoutingTriggerAccuracy(
  originalRouting: string,
  proposedRouting: string,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
  options: RoutingValidationOptions = {},
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

  if (options.replayFixture && options.replayRunner) {
    const beforeResults = await options.replayRunner({
      routing: originalRouting,
      evalSet,
      agent,
      fixture: options.replayFixture,
    });
    const afterResults = await options.replayRunner({
      routing: proposedRouting,
      evalSet,
      agent,
      fixture: options.replayFixture,
    });
    const beforePassed = beforeResults.filter((result) => result.passed).length;
    const afterPassed = afterResults.filter((result) => result.passed).length;
    const total = evalSet.length;

    return {
      before_pass_rate: beforePassed / total,
      after_pass_rate: afterPassed / total,
      improved: afterPassed > beforePassed,
      validation_mode: "host_replay",
      validation_agent: agent,
      validation_fixture_id: options.replayFixture.fixture_id,
      per_entry_results: afterResults,
    };
  }

  if (options.replayFixture) {
    const beforeResults = await runHostReplayFixture({
      routing: originalRouting,
      evalSet,
      fixture: options.replayFixture,
    });
    const afterResults = await runHostReplayFixture({
      routing: proposedRouting,
      evalSet,
      fixture: options.replayFixture,
    });
    const beforePassed = beforeResults.filter((result) => result.passed).length;
    const afterPassed = afterResults.filter((result) => result.passed).length;
    const total = evalSet.length;

    return {
      before_pass_rate: beforePassed / total,
      after_pass_rate: afterPassed / total,
      improved: afterPassed > beforePassed,
      validation_mode: "host_replay",
      validation_agent: agent,
      validation_fixture_id: options.replayFixture.fixture_id,
      per_entry_results: afterResults,
    };
  }

  const systemPrompt = "You are an evaluation assistant. Answer only YES or NO.";
  let beforePassed = 0;
  let afterPassed = 0;

  for (const entry of evalSet) {
    // Check with original routing
    const beforePrompt = buildTriggerCheckPrompt(originalRouting, entry.query);
    const beforeRaw = await callLlm(systemPrompt, beforePrompt, agent, modelFlag);
    const beforeTriggered = parseTriggerResponse(beforeRaw);
    const beforePass =
      (entry.should_trigger && beforeTriggered) || (!entry.should_trigger && !beforeTriggered);

    // Check with proposed routing
    const afterPrompt = buildTriggerCheckPrompt(proposedRouting, entry.query);
    const afterRaw = await callLlm(systemPrompt, afterPrompt, agent, modelFlag);
    const afterTriggered = parseTriggerResponse(afterRaw);
    const afterPass =
      (entry.should_trigger && afterTriggered) || (!entry.should_trigger && !afterTriggered);

    if (beforePass) beforePassed++;
    if (afterPass) afterPassed++;
  }

  const total = evalSet.length;
  const beforePassRate = beforePassed / total;
  const afterPassRate = afterPassed / total;

  return {
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved: afterPassRate > beforePassRate,
    validation_mode: "llm_judge",
    validation_agent: agent,
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
  options: RoutingValidationOptions = {},
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
  };
}
