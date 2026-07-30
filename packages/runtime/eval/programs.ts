import * as Effect from "effect/Effect";

import { CLIError } from "../utils/cli-error.js";
import type { EvalCommandRequest } from "./cli-contract.js";

function toEvalCliError(cause: unknown, action: EvalCommandRequest["action"]): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        cause instanceof Error ? cause.message : String(cause),
        "OPERATION_FAILED",
        `selftune eval ${action} --help`,
      );
}

export const runEvalProgram = Effect.fn("selftune.eval.run")(function* (
  request: EvalCommandRequest,
) {
  switch (request.action) {
    case "generate": {
      const generator = yield* Effect.promise(() => import("./hooks-to-evals.js"));
      yield* Effect.tryPromise({
        try: () => generator.runEvalGenerate(request.input),
        catch: (cause) => toEvalCliError(cause, request.action),
      });
      return;
    }
    case "unit-test": {
      const unitTests = yield* Effect.promise(() => import("./unit-test-cli.js"));
      yield* Effect.tryPromise({
        try: () => unitTests.runEvalUnitTests(request.input),
        catch: (cause) => toEvalCliError(cause, request.action),
      });
      return;
    }
    case "import": {
      const importer = yield* Effect.promise(() => import("./import-skillsbench.js"));
      yield* Effect.try({
        try: () => importer.runEvalImport(request.input),
        catch: (cause) => toEvalCliError(cause, request.action),
      });
      return;
    }
    case "composability": {
      const composability = yield* Effect.promise(() => import("./composability-program.js"));
      yield* composability.runComposabilityProgram(request.input);
      return;
    }
    case "family-overlap": {
      const familyOverlap = yield* Effect.promise(() => import("./family-overlap.js"));
      yield* Effect.tryPromise({
        try: () => familyOverlap.runEvalFamilyOverlap(request.input),
        catch: (cause) => toEvalCliError(cause, request.action),
      });
    }
  }
});
