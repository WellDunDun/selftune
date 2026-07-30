import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "@selftune/runtime/command-surface";
import type { CreatePublishResult } from "@selftune/runtime/create/publish";
import type { RunPublishOptions } from "@selftune/runtime/publish";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  decodePublishInternalValue,
  PUBLISH_INTERNAL_HELP_FLAG,
  PUBLISH_INTERNAL_WATCH_FLAG,
} from "../compatibility/publish.js";

export interface PublishInput extends Omit<RunPublishOptions, "watch"> {
  readonly watch: boolean;
  readonly json: boolean;
}

export type PublishAction = (input: PublishInput) => Effect.Effect<void, CLIError>;

interface PublishModule {
  readonly runPublish: (options: RunPublishOptions) => Promise<CreatePublishResult>;
  readonly formatPublishResult: (result: CreatePublishResult) => string;
}

export interface PublishActionDependencies {
  readonly loadModule: () => Promise<PublishModule>;
  readonly isStdoutTTY: () => boolean;
  readonly print: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_PUBLISH_DEPENDENCIES: PublishActionDependencies = {
  loadModule: () => import("@selftune/runtime/publish"),
  isStdoutTTY: () => process.stdout.isTTY === true,
  print: (message) => process.stdout.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

export const PUBLISH_HELP = renderCommandHelp(PUBLIC_COMMAND_SURFACES.publish);

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function publishImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load publish support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toPublishCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Publish failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune publish --help",
      );
}

export const runPublishActionWithDependencies = Effect.fn("selftune.cli.publish")(function* (
  input: PublishInput,
  dependencies: PublishActionDependencies,
) {
  const runtimeModule = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: publishImportFailure,
  });
  const result = yield* Effect.tryPromise({
    try: () =>
      runtimeModule.runPublish({
        skillPath: input.skillPath,
        watch: input.watch,
        ignoreWatchAlerts: input.ignoreWatchAlerts,
      }),
    catch: toPublishCliError,
  });
  yield* Effect.try({
    try: () => {
      const output =
        input.json || !dependencies.isStdoutTTY()
          ? JSON.stringify(result, null, 2)
          : runtimeModule.formatPublishResult(result);
      dependencies.print(output);
      dependencies.setExitCode(result.published ? 0 : 1);
    },
    catch: toPublishCliError,
  });
});

export const runPublishAction: PublishAction = (input) =>
  runPublishActionWithDependencies(input, LIVE_PUBLISH_DEPENDENCIES);

export function makePublishCommand(action: PublishAction = runPublishAction) {
  return Command.make(
    "publish",
    {
      internalHelp: Flag.boolean(PUBLISH_INTERNAL_HELP_FLAG),
      internalWatch: Flag.boolean(PUBLISH_INTERNAL_WATCH_FLAG),
      skillPath: Flag.string("skill-path").pipe(Flag.optional),
      ignoreWatchAlerts: Flag.boolean("ignore-watch-alerts"),
      json: Flag.boolean("json"),
    },
    (input) => {
      if (input.internalHelp) return Console.log(PUBLISH_HELP);
      return action({
        skillPath: decodePublishInternalValue(Option.getOrUndefined(input.skillPath)) ?? "",
        watch: input.internalWatch,
        ignoreWatchAlerts: input.ignoreWatchAlerts,
        json: input.json,
      });
    },
  ).pipe(Command.withDescription("Publish a verified draft package and start watch by default"));
}
