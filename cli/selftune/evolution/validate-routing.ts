/**
 * validate-routing.ts
 *
 * Validates a routing table evolution proposal by checking structural validity
 * and running trigger accuracy checks against an eval set.
 */

import type { BodyEvolutionProposal, BodyValidationResult, EvalEntry } from "../types.js";
import { callLlm } from "../utils/llm-call.js";
import { buildTriggerCheckPrompt, parseTriggerResponse } from "../utils/trigger-check.js";

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/**
 * Check that a routing table is valid markdown table syntax with
 * `| Trigger | Workflow |` columns.
 */
export function validateRoutingStructure(routing: string): { valid: boolean; reason: string } {
  const lines = routing.trim().split("\n").filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { valid: false, reason: "Routing table must have at least a header and one data row" };
  }

  // Check header row contains Trigger and Workflow columns
  const headerLine = lines[0].trim();
  if (!headerLine.startsWith("|") || !headerLine.endsWith("|")) {
    return { valid: false, reason: "Header row must be a markdown table row starting and ending with |" };
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
): Promise<{ before_pass_rate: number; after_pass_rate: number; improved: boolean }> {
  if (evalSet.length === 0) {
    return { before_pass_rate: 0, after_pass_rate: 0, improved: false };
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
    };
  }

  // Gate 2: Trigger accuracy
  const accuracy = await validateRoutingTriggerAccuracy(
    proposal.original_body,
    proposal.proposed_body,
    evalSet,
    agent,
    modelFlag,
  );
  gateResults.push({
    gate: "trigger_accuracy",
    passed: accuracy.improved,
    reason: accuracy.improved
      ? `Improved: ${(accuracy.before_pass_rate * 100).toFixed(1)}% -> ${(accuracy.after_pass_rate * 100).toFixed(1)}%`
      : `Not improved: ${(accuracy.before_pass_rate * 100).toFixed(1)}% -> ${(accuracy.after_pass_rate * 100).toFixed(1)}%`,
  });

  const gatesPassed = gateResults.filter((g) => g.passed).length;

  return {
    proposal_id: proposal.proposal_id,
    gates_passed: gatesPassed,
    gates_total: 2,
    gate_results: gateResults,
    improved: gatesPassed === 2,
    regressions: [],
  };
}
