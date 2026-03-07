/**
 * validate-proposal.ts
 *
 * Validates an evolution proposal by running trigger checks against an eval set.
 * Compares trigger accuracy between the original and proposed skill descriptions
 * to determine whether the proposal is an improvement.
 */

import type { EvalEntry, EvolutionProposal, InvocationTypeScores } from "../types.js";
import { callLlm } from "../utils/llm-call.js";
import {
  buildBatchTriggerCheckPrompt,
  buildTriggerCheckPrompt,
  parseBatchTriggerResponse,
  parseTriggerResponse,
} from "../utils/trigger-check.js";

// Re-export so existing consumers don't break
export { buildTriggerCheckPrompt, parseTriggerResponse };

/** Number of eval queries to batch into a single LLM call.
 * Higher = fewer claude -p spawns = much faster (each spawn has ~30-60s overhead).
 * Haiku handles 50+ YES/NO checks in a single call easily. */
export const TRIGGER_CHECK_BATCH_SIZE = 50;

/** Number of times to run each batch and majority-vote to reduce LLM variance. */
export const VALIDATION_RUNS = 3;

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
// Proposal validation
// ---------------------------------------------------------------------------

/** Validate a proposal sequentially (one LLM call per query). Kept for backward compat. */
export async function validateProposalSequential(
  proposal: EvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
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
  const perEntryResults: Array<{ entry: EvalEntry; before_pass: boolean; after_pass: boolean }> =
    [];
  let beforePassed = 0;
  let afterPassed = 0;

  for (const entry of evalSet) {
    // Check with original description
    const beforePrompt = buildTriggerCheckPrompt(proposal.original_description, entry.query);
    const beforeRaw = await callLlm(systemPrompt, beforePrompt, agent, modelFlag);
    const beforeTriggered = parseTriggerResponse(beforeRaw);
    const beforePass =
      (entry.should_trigger && beforeTriggered) || (!entry.should_trigger && !beforeTriggered);

    // Check with proposed description
    const afterPrompt = buildTriggerCheckPrompt(proposal.proposed_description, entry.query);
    const afterRaw = await callLlm(systemPrompt, afterPrompt, agent, modelFlag);
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

  // Compute per-invocation-type scores (initialize all required keys)
  const byInvocationType: Record<string, { passed: number; total: number }> = {
    explicit: { passed: 0, total: 0 },
    implicit: { passed: 0, total: 0 },
    contextual: { passed: 0, total: 0 },
    negative: { passed: 0, total: 0 },
  };
  for (const r of perEntryResults) {
    const type = r.entry.invocation_type ?? "implicit";
    if (!byInvocationType[type]) byInvocationType[type] = { passed: 0, total: 0 };
    byInvocationType[type].total++;
    if (r.after_pass) byInvocationType[type].passed++;
  }

  const invocationScores: InvocationTypeScores = {
    explicit: {
      ...byInvocationType.explicit,
      pass_rate:
        byInvocationType.explicit.total > 0
          ? byInvocationType.explicit.passed / byInvocationType.explicit.total
          : 0,
    },
    implicit: {
      ...byInvocationType.implicit,
      pass_rate:
        byInvocationType.implicit.total > 0
          ? byInvocationType.implicit.passed / byInvocationType.implicit.total
          : 0,
    },
    contextual: {
      ...byInvocationType.contextual,
      pass_rate:
        byInvocationType.contextual.total > 0
          ? byInvocationType.contextual.passed / byInvocationType.contextual.total
          : 0,
    },
    negative: {
      ...byInvocationType.negative,
      pass_rate:
        byInvocationType.negative.total > 0
          ? byInvocationType.negative.passed / byInvocationType.negative.total
          : 0,
    },
  };

  return {
    proposal_id: proposal.proposal_id,
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved,
    regressions,
    new_passes: newPasses,
    net_change: netChange,
    by_invocation_type: invocationScores,
    per_entry_results: perEntryResults,
  };
}

// ---------------------------------------------------------------------------
// Batched proposal validation
// ---------------------------------------------------------------------------

/** Chunk an array into groups of `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Majority-vote across multiple boolean arrays. Returns true if >50% of runs agree. */
function majorityVote(runs: boolean[][], index: number): boolean {
  let yesCount = 0;
  for (const run of runs) {
    if (run[index]) yesCount++;
  }
  return yesCount > runs.length / 2;
}

/**
 * Validate a proposal by batching trigger checks.
 * Instead of 2 LLM calls per entry, this makes 2 calls per batch
 * (one for "before", one for "after"), reducing total calls from 2N to ~2*(N/batchSize).
 */
export async function validateProposalBatched(
  proposal: EvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
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

  const systemPrompt =
    "You are an evaluation assistant. For each numbered query, respond with the number followed by YES or NO.";

  const regressions: EvalEntry[] = [];
  const newPasses: EvalEntry[] = [];
  const perEntryResults: Array<{ entry: EvalEntry; before_pass: boolean; after_pass: boolean }> =
    [];
  let beforePassed = 0;
  let afterPassed = 0;

  const batches = chunk(evalSet, TRIGGER_CHECK_BATCH_SIZE);

  for (const batch of batches) {
    const queries = batch.map((e) => e.query);

    const beforePrompt = buildBatchTriggerCheckPrompt(proposal.original_description, queries);
    const afterPrompt = buildBatchTriggerCheckPrompt(proposal.proposed_description, queries);

    // Run VALIDATION_RUNS times in parallel and majority-vote to reduce LLM variance
    const allCalls: Promise<string>[] = [];
    for (let r = 0; r < VALIDATION_RUNS; r++) {
      allCalls.push(callLlm(systemPrompt, beforePrompt, agent, modelFlag));
      allCalls.push(callLlm(systemPrompt, afterPrompt, agent, modelFlag));
    }
    const allRaw = await Promise.all(allCalls);

    // Parse into arrays of [before, after] per run
    const beforeRuns: boolean[][] = [];
    const afterRuns: boolean[][] = [];
    for (let r = 0; r < VALIDATION_RUNS; r++) {
      beforeRuns.push(parseBatchTriggerResponse(allRaw[r * 2], queries.length));
      afterRuns.push(parseBatchTriggerResponse(allRaw[r * 2 + 1], queries.length));
    }

    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      const beforeTriggered = majorityVote(beforeRuns, i);
      const afterTriggered = majorityVote(afterRuns, i);

      const beforePass =
        (entry.should_trigger && beforeTriggered) || (!entry.should_trigger && !beforeTriggered);
      const afterPass =
        (entry.should_trigger && afterTriggered) || (!entry.should_trigger && !afterTriggered);

      if (beforePass) beforePassed++;
      if (afterPass) afterPassed++;

      if (beforePass && !afterPass) regressions.push(entry);
      if (!beforePass && afterPass) newPasses.push(entry);

      perEntryResults.push({ entry, before_pass: beforePass, after_pass: afterPass });
    }
  }

  const total = evalSet.length;
  const beforePassRate = beforePassed / total;
  const afterPassRate = afterPassed / total;
  const netChange = afterPassRate - beforePassRate;

  const improved =
    afterPassRate > beforePassRate &&
    regressions.length < total * 0.05 &&
    (netChange >= 0.1 || newPasses.length >= 2);

  // Compute per-invocation-type scores (initialize all required keys)
  const byInvocationType: Record<string, { passed: number; total: number }> = {
    explicit: { passed: 0, total: 0 },
    implicit: { passed: 0, total: 0 },
    contextual: { passed: 0, total: 0 },
    negative: { passed: 0, total: 0 },
  };
  for (const r of perEntryResults) {
    const type = r.entry.invocation_type ?? "implicit";
    if (!byInvocationType[type]) byInvocationType[type] = { passed: 0, total: 0 };
    byInvocationType[type].total++;
    if (r.after_pass) byInvocationType[type].passed++;
  }

  const invocationScores: InvocationTypeScores = {
    explicit: {
      ...byInvocationType.explicit,
      pass_rate:
        byInvocationType.explicit.total > 0
          ? byInvocationType.explicit.passed / byInvocationType.explicit.total
          : 0,
    },
    implicit: {
      ...byInvocationType.implicit,
      pass_rate:
        byInvocationType.implicit.total > 0
          ? byInvocationType.implicit.passed / byInvocationType.implicit.total
          : 0,
    },
    contextual: {
      ...byInvocationType.contextual,
      pass_rate:
        byInvocationType.contextual.total > 0
          ? byInvocationType.contextual.passed / byInvocationType.contextual.total
          : 0,
    },
    negative: {
      ...byInvocationType.negative,
      pass_rate:
        byInvocationType.negative.total > 0
          ? byInvocationType.negative.passed / byInvocationType.negative.total
          : 0,
    },
  };

  return {
    proposal_id: proposal.proposal_id,
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved,
    regressions,
    new_passes: newPasses,
    net_change: netChange,
    by_invocation_type: invocationScores,
    per_entry_results: perEntryResults,
  };
}

// ---------------------------------------------------------------------------
// Default export — batched is the default
// ---------------------------------------------------------------------------

/** Validate a proposal by running trigger checks against the eval set (batched by default). */
export async function validateProposal(
  proposal: EvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
): Promise<ValidationResult> {
  return validateProposalBatched(proposal, evalSet, agent, modelFlag);
}
