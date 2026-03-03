/**
 * validate-proposal.ts
 *
 * Validates an evolution proposal by running trigger checks against an eval set.
 * Compares trigger accuracy between the original and proposed skill descriptions
 * to determine whether the proposal is an improvement.
 */

import type { EvalEntry, EvolutionProposal, InvocationTypeScores, InvocationType } from "../types.js";
import { callLlm } from "../utils/llm-call.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  proposal_id: string;
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  regressions: EvalEntry[]; // passed before, fail after
  new_passes: EvalEntry[]; // failed before, pass after
  net_change: number; // after - before pass rate
  by_invocation_type?: InvocationTypeScores;
  per_entry_results?: Array<{ entry: EvalEntry; before_pass: boolean; after_pass: boolean }>;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** Build the trigger check prompt for the LLM. */
export function buildTriggerCheckPrompt(description: string, query: string): string {
  return [
    "Given this skill description, would the following user query trigger this skill?",
    "Respond YES or NO only.",
    "",
    "Skill description:",
    description,
    "",
    "User query:",
    query,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Parse YES/NO from LLM response. */
export function parseTriggerResponse(response: string): boolean {
  const normalized = response.trim().toUpperCase();
  if (normalized.startsWith("YES")) return true;
  if (normalized.startsWith("NO")) return false;
  return false; // conservative default
}

// ---------------------------------------------------------------------------
// Proposal validation
// ---------------------------------------------------------------------------

/** Validate a proposal by running trigger checks against the eval set. */
export async function validateProposal(
  proposal: EvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
): Promise<ValidationResult> {
  if (evalSet.length === 0) {
    return {
      proposal_id: proposal.proposal_id,
      before_pass_rate: 0,
      after_pass_rate: 0,
      improved: false,
      regressions: [],
      new_passes: [],
      net_change: 0,
    };
  }

  const systemPrompt = "You are an evaluation assistant. Answer only YES or NO.";
  const regressions: EvalEntry[] = [];
  const newPasses: EvalEntry[] = [];
  const perEntryResults: Array<{ entry: EvalEntry; before_pass: boolean; after_pass: boolean }> = [];
  let beforePassed = 0;
  let afterPassed = 0;

  for (const entry of evalSet) {
    // Check with original description
    const beforePrompt = buildTriggerCheckPrompt(proposal.original_description, entry.query);
    const beforeRaw = await callLlm(systemPrompt, beforePrompt, agent);
    const beforeTriggered = parseTriggerResponse(beforeRaw);
    const beforePass =
      (entry.should_trigger && beforeTriggered) || (!entry.should_trigger && !beforeTriggered);

    // Check with proposed description
    const afterPrompt = buildTriggerCheckPrompt(proposal.proposed_description, entry.query);
    const afterRaw = await callLlm(systemPrompt, afterPrompt, agent);
    const afterTriggered = parseTriggerResponse(afterRaw);
    const afterPass =
      (entry.should_trigger && afterTriggered) || (!entry.should_trigger && !afterTriggered);

    if (beforePass) beforePassed++;
    if (afterPass) afterPassed++;

    // Regression: passed before, fails after
    if (beforePass && !afterPass) {
      regressions.push(entry);
    }

    // New pass: failed before, passes after
    if (!beforePass && afterPass) {
      newPasses.push(entry);
    }

    perEntryResults.push({ entry, before_pass: beforePass, after_pass: afterPass });
  }

  const total = evalSet.length;
  const beforePassRate = beforePassed / total;
  const afterPassRate = afterPassed / total;
  const netChange = afterPassRate - beforePassRate;

  // A proposal is improved when ALL of:
  //   - after_pass_rate > before_pass_rate
  //   - regressions count < 5% of total eval entries
  //   - Either net improvement >= 0.10 OR new_passes.length >= 2
  const improved =
    afterPassRate > beforePassRate &&
    regressions.length < total * 0.05 &&
    (netChange >= 0.1 || newPasses.length >= 2);

  // Compute per-invocation-type scores
  const byInvocationType: Record<string, { passed: number; total: number }> = {};
  for (const r of perEntryResults) {
    const type = r.entry.invocation_type ?? "implicit";
    if (!byInvocationType[type]) byInvocationType[type] = { passed: 0, total: 0 };
    byInvocationType[type].total++;
    if (r.after_pass) byInvocationType[type].passed++;
  }

  const invocationScores: Record<string, { passed: number; total: number; pass_rate: number }> = {};
  for (const [type, counts] of Object.entries(byInvocationType)) {
    invocationScores[type] = {
      ...counts,
      pass_rate: counts.total > 0 ? counts.passed / counts.total : 0,
    };
  }

  return {
    proposal_id: proposal.proposal_id,
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved,
    regressions,
    new_passes: newPasses,
    net_change: netChange,
    by_invocation_type: invocationScores as unknown as InvocationTypeScores,
    per_entry_results: perEntryResults,
  };
}
