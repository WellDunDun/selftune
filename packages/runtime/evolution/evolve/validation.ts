import type { EvalEntry, EvolutionProposal } from "../../types.js";
import type { EffortLevel } from "../../utils/llm-call.js";
import type { ReplayValidationOptions, ReplayValidationResult } from "../engines/replay-engine.js";
import { runValidationContract, type ValidationStrategy } from "../validation-contract.js";
import {
  TRIGGER_CHECK_BATCH_SIZE,
  VALIDATION_RUNS,
  validateProposal,
} from "../validate-proposal.js";
import type { ValidationResult } from "../validate-proposal.js";
import type { EvolveOptions } from "./contracts.js";

export function countValidationLlmCalls(evalSetSize: number): number {
  if (evalSetSize === 0) return 0;
  return Math.ceil(evalSetSize / TRIGGER_CHECK_BATCH_SIZE) * 2 * VALIDATION_RUNS;
}

interface GateDecision {
  model: string;
  effort?: EffortLevel;
  riskSignals: string[];
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

export function resolveGateDecision(
  options: EvolveOptions,
  proposal: EvolutionProposal,
  validation: ValidationResult,
  currentDescription: string,
  confidenceThreshold: number,
): GateDecision | undefined {
  const baseModel = options.gateModel;
  if (!baseModel) return undefined;

  const baseDecision: GateDecision = {
    model: baseModel,
    effort: options.gateEffort,
    riskSignals: [],
  };

  if (!options.adaptiveGate) return baseDecision;

  const riskSignals: string[] = [];
  const originalWords = countWords(currentDescription);
  const proposedWords = countWords(proposal.proposed_description);
  const wordGrowth = originalWords === 0 ? 1 : proposedWords / originalWords;
  const lowLift = validation.net_change < 0.15;
  const hasRegressions = validation.regressions.length > 0;
  const lowConfidence = proposal.confidence < Math.max(confidenceThreshold + 0.05, 0.75);
  const broadeningRisk = wordGrowth > 1.8 || proposedWords - originalWords > 32;
  const notYetStrong = validation.after_pass_rate < 0.9;

  if (hasRegressions) riskSignals.push(`regressions=${validation.regressions.length}`);
  if (lowLift) riskSignals.push(`low_lift=${validation.net_change.toFixed(3)}`);
  if (lowConfidence) riskSignals.push(`confidence=${proposal.confidence.toFixed(2)}`);
  if (broadeningRisk) riskSignals.push(`word_growth=${wordGrowth.toFixed(2)}x`);
  if (notYetStrong) riskSignals.push(`after_pass_rate=${validation.after_pass_rate.toFixed(2)}`);

  const shouldEscalate = hasRegressions || validation.net_change < 0.1 || riskSignals.length >= 2;
  if (!shouldEscalate) {
    return {
      ...baseDecision,
      riskSignals,
    };
  }

  return {
    model: "opus",
    effort: options.gateEffort === "max" ? "max" : "high",
    riskSignals,
  };
}

// ---------------------------------------------------------------------------
// Validation mode router
// ---------------------------------------------------------------------------

/**
 * Route description validation to the correct engine based on the
 * --validation-mode flag.
 *
 *   - "judge"  → LLM judge only (legacy path via validateProposal)
 *   - "replay" → Replay engine only; throws if no fixture/runner available
 *   - "auto"   → Try replay first, fall back to judge if unavailable
 *
 * Returns a ValidationResult and the actual mode used.
 */
export async function validateWithMode(
  mode: ValidationStrategy,
  proposal: EvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
  replayOptions: ReplayValidationOptions | undefined,
  validateFn: typeof validateProposal,
  modelFlag?: string,
): Promise<{
  result: ValidationResult;
  modeUsed: ValidationResult["validation_mode"] extends infer T ? Exclude<T, undefined> : never;
}> {
  return runValidationContract({
    mode,
    originalContent: proposal.original_description,
    proposedContent: proposal.proposed_description,
    evalSet,
    agent,
    replayOptions,
    runJudge: async () => {
      const result = await validateFn(proposal, evalSet, agent, modelFlag);
      return { result, modeUsed: result.validation_mode ?? "llm_judge" };
    },
    adaptReplayResult: (replayResult) =>
      adaptReplayResultToValidationResult(proposal, replayResult, evalSet),
    onReplayFallback: (reason) => {
      if (reason) {
        console.error(
          `[evolve] Replay not available (${reason}), falling back to LLM judge validation.`,
        );
        return;
      }
      console.error("[evolve] Replay not available, falling back to LLM judge validation.");
    },
  }).then(({ result, modeUsed, fallbackReason }) => ({
    result: fallbackReason ? { ...result, validation_fallback_reason: fallbackReason } : result,
    modeUsed,
  }));
}

function adaptReplayResultToValidationResult(
  proposal: EvolutionProposal,
  replayResult: ReplayValidationResult,
  evalSet: EvalEntry[],
): ValidationResult {
  const evalEntryByQuery = new Map<string, EvalEntry>();
  for (const entry of evalSet) {
    evalEntryByQuery.set(entry.query, entry);
  }

  // Build lookups from before/after replay results keyed by query.
  const beforeByQuery = new Map<string, boolean>();
  for (const r of replayResult.before_entry_results ?? []) {
    beforeByQuery.set(r.query, r.passed);
  }
  const afterByQuery = new Map<string, boolean>();
  for (const r of replayResult.per_entry_results ?? []) {
    afterByQuery.set(r.query, r.passed);
  }

  const entryForReplayResult = (result: { query: string; should_trigger: boolean }): EvalEntry => ({
    ...(evalEntryByQuery.get(result.query) ?? {
      query: result.query,
      should_trigger: result.should_trigger,
    }),
  });

  // Merge before + after into unified per_entry_results with both fields populated
  const regressions: EvalEntry[] = [];
  const newPasses: EvalEntry[] = [];
  const perEntryResults = replayResult.per_entry_results?.map((result) => {
    const beforePass = beforeByQuery.get(result.query) ?? false;
    const afterPass = result.passed;
    const entry = entryForReplayResult(result);

    if (beforePass && !afterPass) regressions.push(entry);
    if (!beforePass && afterPass) newPasses.push(entry);

    return { entry, before_pass: beforePass, after_pass: afterPass };
  });
  const beforeEntryResults = replayResult.before_entry_results?.map((result) => ({
    entry: entryForReplayResult(result),
    before_pass: result.passed,
    after_pass: afterByQuery.get(result.query) ?? false,
  }));

  return {
    proposal_id: proposal.proposal_id,
    before_pass_rate: replayResult.before_pass_rate,
    after_pass_rate: replayResult.after_pass_rate,
    improved: replayResult.improved,
    regressions,
    new_passes: newPasses,
    net_change: replayResult.after_pass_rate - replayResult.before_pass_rate,
    validation_mode: replayResult.validation_mode,
    validation_agent: replayResult.validation_agent,
    validation_fixture_id: replayResult.validation_fixture_id,
    per_entry_results: perEntryResults,
    before_entry_results: beforeEntryResults,
  };
}
