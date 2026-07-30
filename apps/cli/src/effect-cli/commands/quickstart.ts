import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export type QuickstartAction = () => Effect.Effect<void, CLIError>;

interface QuickstartModule {
  readonly quickstart: () => Promise<void>;
}

export interface QuickstartActionDependencies {
  readonly loadModule: () => Promise<QuickstartModule>;
}

const LIVE_QUICKSTART_DEPENDENCIES: QuickstartActionDependencies = {
  loadModule: () => import("@selftune/orchestration/quickstart"),
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function quickstartImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load quickstart support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toQuickstartCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Quickstart failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune quickstart --help",
      );
}

export const runQuickstartActionWithDependencies = Effect.fn("selftune.cli.quickstart")(function* (
  dependencies: QuickstartActionDependencies,
) {
  const quickstartModule = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: quickstartImportFailure,
  });
  yield* Effect.tryPromise({
    try: quickstartModule.quickstart,
    catch: toQuickstartCliError,
  });
});

export const runQuickstartAction: QuickstartAction = () =>
  runQuickstartActionWithDependencies(LIVE_QUICKSTART_DEPENDENCIES);

export function makeQuickstartCommand(action: QuickstartAction = runQuickstartAction) {
  return Command.make("quickstart", {}, action).pipe(
    Command.withDescription("Run guided onboarding for init, Claude ingestion, and status"),
  );
}
