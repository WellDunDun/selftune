import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import type { AlphaUploadInput } from "@selftune/runtime/alpha-program";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export interface AlphaCommandActions {
  readonly upload: (input: AlphaUploadInput) => Effect.Effect<void, CLIError>;
  readonly relink: () => Effect.Effect<void, CLIError>;
}

interface AlphaProgramModule {
  readonly runAlphaUploadProgram: (input: AlphaUploadInput) => Effect.Effect<unknown, CLIError>;
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

function alphaImportFailure(action: "upload" | "relink", cause: unknown): CLIError {
  return new CLIError(
    `Unable to load alpha ${action} support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export const runAlphaUploadActionWithDependencies = Effect.fn("selftune.cli.alpha.upload")(
  function* (input: AlphaUploadInput, dependencies: AlphaActionDependencies) {
    const alpha = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: (cause) => alphaImportFailure("upload", cause),
    });
    yield* alpha.runAlphaUploadProgram(input);
  },
);

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
  upload: (input) => runAlphaUploadActionWithDependencies(input, LIVE_ALPHA_DEPENDENCIES),
  relink: () => runAlphaRelinkActionWithDependencies(LIVE_ALPHA_DEPENDENCIES),
};

export function makeAlphaCommand(actions: AlphaCommandActions = liveAlphaCommandActions) {
  const upload = Command.make(
    "upload",
    {
      dryRun: Flag.boolean("dry-run").pipe(
        Flag.withDescription("Stage and summarize records without sending them"),
      ),
    },
    (input) => actions.upload({ dryRun: input.dryRun }),
  ).pipe(
    Command.withDescription("Run a manual alpha data upload cycle"),
    Command.withExamples([
      {
        command: "selftune alpha upload --dry-run",
        description: "Preview the records staged for upload",
      },
    ]),
  );

  const relink = Command.make("relink", {}, actions.relink).pipe(
    Command.withDescription("Re-authenticate with the cloud using device-code approval"),
    Command.withExamples([
      {
        command: "selftune alpha relink",
        description: "Replace the local upload key after browser approval",
      },
    ]),
  );

  return Command.make("alpha").pipe(
    Command.withSubcommands([upload, relink]),
    Command.withDescription("Manage alpha uploads and cloud authentication"),
  );
}
