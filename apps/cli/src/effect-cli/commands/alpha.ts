import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export interface AlphaCommandActions {
  readonly relink: () => Effect.Effect<void, CLIError>;
}

interface AlphaProgramModule {
  readonly runAlphaRelinkProgram: () => Effect.Effect<unknown, CLIError>;
}

export interface AlphaActionDependencies {
  readonly loadModule: () => Promise<AlphaProgramModule>;
}

const LIVE_ALPHA_DEPENDENCIES: AlphaActionDependencies = {
  loadModule: () => import("@selftune/runtime/alpha-program"),
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function alphaImportFailure(action: "relink", cause: unknown): CLIError {
  return new CLIError(
    `Unable to load alpha ${action} support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export const runAlphaRelinkActionWithDependencies = Effect.fn("selftune.cli.alpha.relink")(
  function* (dependencies: AlphaActionDependencies) {
    const alpha = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: (cause) => alphaImportFailure("relink", cause),
    });
    yield* alpha.runAlphaRelinkProgram();
  },
);

export const liveAlphaCommandActions: AlphaCommandActions = {
  relink: () => runAlphaRelinkActionWithDependencies(LIVE_ALPHA_DEPENDENCIES),
};

export function makeAlphaCommand(actions: AlphaCommandActions = liveAlphaCommandActions) {
  const relink = Command.make("relink", {}, actions.relink).pipe(
    Command.withDescription("Re-authenticate with the cloud using device-code approval"),
    Command.withExamples([
      {
        command: "selftune alpha relink",
        description: "Replace the local cloud credential after browser approval",
      },
    ]),
  );

  return Command.make("alpha").pipe(
    Command.withSubcommands([relink]),
    Command.withDescription("Manage cloud authentication"),
  );
}
