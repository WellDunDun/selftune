import type { EvalEntry, ValidationMode } from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import {
  runReplayValidation,
  type ReplayValidationOptions,
  type ReplayValidationResult,
} from "./engines/replay-engine.js";

export type ValidationStrategy = "auto" | "replay" | "judge";

export const DEFAULT_VALIDATION_STRATEGY: ValidationStrategy = "auto";

export interface ValidationExecutionResult<TResult> {
  result: TResult;
  modeUsed: ValidationMode;
  fallbackReason?: string;
}

export interface ValidationContractOptions<TResult> {
  mode?: ValidationStrategy;
  originalContent: string;
  proposedContent: string;
  evalSet: EvalEntry[];
  agent: string;
  replayOptions?: ReplayValidationOptions;
  runJudge: () => Promise<ValidationExecutionResult<TResult>>;
  adaptReplayResult: (replayResult: ReplayValidationResult) => TResult;
  onReplayFallback?: (reason?: string) => void;
}

export function hasReplayValidationPath(
  replayOptions?: ReplayValidationOptions,
): replayOptions is ReplayValidationOptions {
  return Boolean(replayOptions?.replayFixture || replayOptions?.replayRunner);
}

export function createReplayUnavailableError(reason?: string): CLIError {
  const message = reason
    ? `Replay validation requested but real host/runtime replay is unavailable: ${reason}`
    : "Replay validation requested but real host/runtime replay is unavailable.";
  return new CLIError(
    message,
    "REPLAY_UNAVAILABLE",
    "Use --validation-mode auto to allow LLM judge fallback, or run selftune on a host/agent with runtime replay support for this skill.",
  );
}

export async function runValidationContract<TResult>(
  options: ValidationContractOptions<TResult>,
): Promise<ValidationExecutionResult<TResult>> {
  const mode = options.mode ?? DEFAULT_VALIDATION_STRATEGY;

  if (mode === "judge") {
    return options.runJudge();
  }

  if (hasReplayValidationPath(options.replayOptions)) {
    const replayAttempt = await runReplayValidation(
      options.originalContent,
      options.proposedContent,
      options.evalSet,
      options.agent,
      options.replayOptions,
    );

    if (replayAttempt.result) {
      return {
        result: options.adaptReplayResult(replayAttempt.result),
        modeUsed: replayAttempt.result.validation_mode,
      };
    }

    if (mode === "replay") {
      throw createReplayUnavailableError(replayAttempt.fallbackReason);
    }

    options.onReplayFallback?.(replayAttempt.fallbackReason);
    const judgeResult = await options.runJudge();
    return {
      ...judgeResult,
      fallbackReason: replayAttempt.fallbackReason,
    };
  }

  if (mode === "replay") {
    throw createReplayUnavailableError();
  }

  options.onReplayFallback?.();
  return options.runJudge();
}
