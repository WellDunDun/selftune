import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "@selftune/runtime/command-surface";
import type { RunVerifyOptions, VerifyResult } from "@selftune/runtime/verify";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { VERIFY_INTERNAL_HELP_FLAG } from "../compatibility/verify.js";

export interface VerifyCommandInput extends RunVerifyOptions {
  readonly json: boolean;
}

export type VerifyAction = (input: VerifyCommandInput) => Effect.Effect<void, CLIError>;

interface VerifyModule {
  readonly runVerify: (options: RunVerifyOptions) => Promise<VerifyResult>;
  readonly formatVerifyResult: (result: VerifyResult, jsonOutput: boolean) => string;
}

export interface VerifyActionDependencies {
  readonly loadModule: () => Promise<VerifyModule>;
  readonly isStdoutTTY: () => boolean;
  readonly print: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_VERIFY_DEPENDENCIES: VerifyActionDependencies = {
  loadModule: () => import("@selftune/runtime/verify"),
  isStdoutTTY: () => process.stdout.isTTY === true,
  print: (message) => process.stdout.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

export const VERIFY_HELP = renderCommandHelp(PUBLIC_COMMAND_SURFACES.verify);

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function verifyImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load verify support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toVerifyCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Verify failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune verify --help",
      );
}

export const runVerifyActionWithDependencies = Effect.fn("selftune.cli.verify")(function* (
  input: VerifyCommandInput,
  dependencies: VerifyActionDependencies,
) {
  const verifyModule = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: verifyImportFailure,
  });
  const result = yield* Effect.tryPromise({
    try: () =>
      verifyModule.runVerify({
        skillPath: input.skillPath,
        agent: input.agent,
        evalSetPath: input.evalSetPath,
        autoFix: input.autoFix,
      }),
    catch: toVerifyCliError,
  });
  const output = yield* Effect.try({
    try: () => verifyModule.formatVerifyResult(result, input.json || !dependencies.isStdoutTTY()),
    catch: toVerifyCliError,
  });
  yield* Effect.try({
    try: () => {
      dependencies.print(output);
      dependencies.setExitCode(result.verified ? 0 : 1);
    },
    catch: toVerifyCliError,
  });
});

export const runVerifyAction: VerifyAction = (input) =>
  runVerifyActionWithDependencies(input, LIVE_VERIFY_DEPENDENCIES);

function decodeInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function makeVerifyCommand(action: VerifyAction = runVerifyAction) {
  return Command.make(
    "verify",
    {
      internalHelp: Flag.boolean(VERIFY_INTERNAL_HELP_FLAG),
      skillPath: Flag.string("skill-path").pipe(
        Flag.withDescription("Path to a skill directory or SKILL.md file (required)"),
        Flag.optional,
      ),
      agent: Flag.string("agent").pipe(
        Flag.withDescription("Runtime agent to use for package evaluation once readiness passes"),
        Flag.optional,
      ),
      evalSet: Flag.string("eval-set").pipe(
        Flag.withDescription("Override the eval-set path instead of using the canonical one"),
        Flag.optional,
      ),
      noAutoFix: Flag.boolean("no-auto-fix").pipe(
        Flag.withDescription("Skip automatic evidence generation when readiness checks fail"),
      ),
      json: Flag.boolean("json").pipe(
        Flag.withDescription("Emit readiness plus report data as JSON"),
      ),
    },
    (input) => {
      if (input.internalHelp) return Console.log(VERIFY_HELP);
      return action({
        skillPath: decodeInternalValue(Option.getOrUndefined(input.skillPath)) ?? "",
        agent: decodeInternalValue(Option.getOrUndefined(input.agent)),
        evalSetPath: decodeInternalValue(Option.getOrUndefined(input.evalSet)),
        autoFix: !input.noAutoFix,
        json: input.json,
      });
    },
  ).pipe(
    Command.withDescription(
      "Verify a draft skill package and report whether it is ready to publish",
    ),
  );
}
