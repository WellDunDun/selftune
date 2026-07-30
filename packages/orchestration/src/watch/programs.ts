import { Effect, Layer } from "effect";

import { buildWatchResult } from "@selftune/runtime/monitoring/watch";

import type { WatchProgramDiagnostic, WatchProgramInput } from "./model.js";
import { toWatchEvaluationOptions } from "./model.js";
import { buildWatchProgramResult, formatWatchDiagnostic } from "./output.js";
import {
  WatchDiagnostics,
  WatchEvaluation,
  WatchMemory,
  WatchRollback,
  WatchSourceSync,
} from "./services.js";

function memoryFailureDiagnostic(skillName: string, message: string): WatchProgramDiagnostic {
  return {
    code: "memory_write_failed",
    message: `Failed to update memory after watch for "${skillName}": ${message}`,
  };
}

export const runWatchProgram = Effect.fn("selftune.orchestration.watch.run")(function* (
  input: WatchProgramInput,
) {
  const sourceSync = yield* WatchSourceSync;
  const evaluationService = yield* WatchEvaluation;
  const rollbackService = yield* WatchRollback;
  const memory = yield* WatchMemory;
  const diagnostics = yield* WatchDiagnostics;

  const syncResult = input.syncFirst ? yield* sourceSync.run(input.syncForce) : undefined;
  const evaluation = yield* evaluationService.run(toWatchEvaluationOptions(input), (diagnostic) =>
    diagnostics.report(formatWatchDiagnostic(diagnostic)),
  );

  const rollbackResult =
    evaluation.alert && input.autoRollback
      ? yield* rollbackService.run({
          skillName: input.skillName,
          skillPath: input.skillPath,
          ...(evaluation.proposalId ? { proposalId: evaluation.proposalId } : {}),
        })
      : undefined;

  yield* memory
    .update({ skillName: input.skillName, snapshot: evaluation.snapshot })
    .pipe(
      Effect.catch((failure) =>
        Effect.sync(() =>
          diagnostics.report(
            formatWatchDiagnostic(memoryFailureDiagnostic(input.skillName, failure.message)),
          ),
        ),
      ),
    );

  const watch = buildWatchResult(evaluation, rollbackResult?.rolledBack ?? false, syncResult);
  return buildWatchProgramResult(watch);
});

export function makeWatchDiagnosticsLayer(
  report: (message: string) => void,
): Layer.Layer<WatchDiagnostics> {
  return Layer.succeed(WatchDiagnostics, WatchDiagnostics.of({ report }));
}

export { watchLiveLayer } from "./live.js";
export type { WatchProgramInput, WatchProgramResult } from "./model.js";
export {
  isWatchInternalFailure,
  WatchDiagnostics,
  WatchEvaluation,
  WatchInternalFailure,
  WatchMemory,
  WatchRollback,
  WatchSourceSync,
  type WatchProgramRuntime,
  type WatchRuntime,
} from "./services.js";
