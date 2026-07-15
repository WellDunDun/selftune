/**
 * judge-engine.ts
 *
 * LLM judge validation engine: runs trigger accuracy checks using
 * an LLM as a YES/NO judge for each eval entry.
 *
 * Extracted from validate-routing.ts and validate-body.ts to isolate
 * LLM-judge-specific concerns from replay-specific concerns.
 */

import type { EvalEntry, ValidationMode } from "../../types.js";
import { callLlm } from "../../utils/llm-call.js";
import { buildTriggerCheckPrompt, parseTriggerResponse } from "../../utils/trigger-check.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JudgeValidationResult {
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  regressions: string[];
  validation_mode: ValidationMode;
  validation_agent: string;
}

// ---------------------------------------------------------------------------
// Judge validation engine
// ---------------------------------------------------------------------------

/**
 * Run LLM-judge-based trigger accuracy checks on an eval set.
 * For each entry, asks the LLM whether the content would trigger
 * the skill for the given query, comparing original vs proposed.
 */
export async function runJudgeValidation(
  originalContent: string,
  proposedContent: string,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
): Promise<JudgeValidationResult> {
  if (evalSet.length === 0) {
    return {
      before_pass_rate: 0,
      after_pass_rate: 0,
      improved: false,
      regressions: [],
      validation_mode: "llm_judge",
      validation_agent: agent,
    };
  }

  const systemPrompt = "You are an evaluation assistant. Answer only YES or NO.";
  let beforePassed = 0;
  let afterPassed = 0;
  const regressions: string[] = [];

  for (const entry of evalSet) {
    // Check with original content
    const beforePrompt = buildTriggerCheckPrompt(originalContent, entry.query);
    const beforeRaw = await callLlm(systemPrompt, beforePrompt, agent, modelFlag);
    const beforeTriggered = parseTriggerResponse(beforeRaw);
    const beforePass =
      (entry.should_trigger && beforeTriggered) || (!entry.should_trigger && !beforeTriggered);

    // Check with proposed content
    const afterPrompt = buildTriggerCheckPrompt(proposedContent, entry.query);
    const afterRaw = await callLlm(systemPrompt, afterPrompt, agent, modelFlag);
    const afterTriggered = parseTriggerResponse(afterRaw);
    const afterPass =
      (entry.should_trigger && afterTriggered) || (!entry.should_trigger && !afterTriggered);

    if (beforePass) beforePassed++;
    if (afterPass) afterPassed++;

    // Track regressions
    if (beforePass && !afterPass) {
      regressions.push(entry.query);
    }
  }

  const total = evalSet.length;
  const beforePassRate = beforePassed / total;
  const afterPassRate = afterPassed / total;

  return {
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved: afterPassRate > beforePassRate,
    regressions,
    validation_mode: "llm_judge",
    validation_agent: agent,
  };
}
