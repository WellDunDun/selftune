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
    case "run": {
      const runner = yield* Effect.promise(() => import("./output-quality.js"));
      if (!request.input.skillPath) {
        return yield* Effect.fail(
          new CLIError(
            "--skill-path <path> is required",
            "MISSING_FLAG",
            "selftune eval run --skill-path /path/to/SKILL.md",
          ),
        );
      }
      const result = yield* Effect.tryPromise({
        try: () =>
          runner.runOutputQualityEvaluation({
            skillPath: request.input.skillPath!,
            evalsPath: request.input.evals,
            workspacePath: request.input.workspace,
            baselineSkillPath: request.input.baselineSkillPath,
            feedbackPath: request.input.feedback,
            agent: request.input.agent,
            model: request.input.model,
          }),
        catch: (cause) => toEvalCliError(cause, request.action),
      });
      console.log(
        request.input.json
          ? JSON.stringify(result, null, 2)
          : `Evaluation iteration written to ${result.iteration_dir}`,
      );
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
