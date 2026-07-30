import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { CONTRIBUTE_HELP } from "@selftune/runtime/contribute/help";
import type {
  ContributeResult,
  FormattedContributeResult,
  RunContributeOptions,
} from "@selftune/runtime/contribute/program";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  CONTRIBUTE_INTERNAL_HELP_FLAG,
  decodeContributeInternalValue,
} from "../compatibility/contribute.js";

export type ContributeCommandInput = RunContributeOptions;

export type ContributeAction = (input: ContributeCommandInput) => Effect.Effect<void, CLIError>;

interface ContributeModule {
  readonly runContribute: (options: RunContributeOptions) => Promise<ContributeResult>;
  readonly formatContributeResult: (result: ContributeResult) => FormattedContributeResult;
}

export interface ContributeActionDependencies {
  readonly loadModule: () => Promise<ContributeModule>;
  readonly print: (message: string) => void;
  readonly printError: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_CONTRIBUTE_DEPENDENCIES: ContributeActionDependencies = {
  loadModule: () => import("@selftune/runtime/contribute/contribute"),
  print: (message) => process.stdout.write(`${message}\n`),
  printError: (message) => process.stderr.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load contribute support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toContributeCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Contribute failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune contribute --help",
      );
}

export const runContributeActionWithDependencies = Effect.fn("selftune.cli.contribute")(function* (
  input: ContributeCommandInput,
  dependencies: ContributeActionDependencies,
) {
  const runtimeModule = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: importFailure,
  });
  const result = yield* Effect.tryPromise({
    try: () => runtimeModule.runContribute(input),
    catch: toContributeCliError,
  });
  const formatted = yield* Effect.try({
    try: () => runtimeModule.formatContributeResult(result),
    catch: toContributeCliError,
  });
  yield* Effect.try({
    try: () => {
      for (const line of formatted.stdout) dependencies.print(line);
      for (const line of formatted.stderr) dependencies.printError(line);
      dependencies.setExitCode(result.exitCode);
    },
    catch: toContributeCliError,
  });
});

export const runContributeAction: ContributeAction = (input) =>
  runContributeActionWithDependencies(input, LIVE_CONTRIBUTE_DEPENDENCIES);

function decode(value: Option.Option<string>): string | undefined {
  return decodeContributeInternalValue(Option.getOrUndefined(value));
}

export function makeContributeCommand(action: ContributeAction = runContributeAction) {
  return Command.make(
    "contribute",
    {
      internalHelp: Flag.boolean(CONTRIBUTE_INTERNAL_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.optional),
      output: Flag.string("output").pipe(Flag.optional),
      preview: Flag.boolean("preview"),
      sanitize: Flag.string("sanitize").pipe(Flag.optional),
      since: Flag.string("since").pipe(Flag.optional),
      submit: Flag.boolean("submit"),
      endpoint: Flag.string("endpoint").pipe(Flag.optional),
      github: Flag.boolean("github"),
    },
    (input) => {
      if (input.internalHelp) return Console.log(CONTRIBUTE_HELP);
      return action({
        skillName: decode(input.skill) ?? "selftune",
        outputPath: decode(input.output),
        preview: input.preview,
        sanitizationLevel: decode(input.sanitize) ?? "conservative",
        since: decode(input.since),
        submit: input.submit,
        endpoint: decode(input.endpoint),
        github: input.github,
      });
    },
  ).pipe(Command.withDescription("Export anonymized skill data for community contribution"));
}
