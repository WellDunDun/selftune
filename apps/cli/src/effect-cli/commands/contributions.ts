import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  CONTRIBUTIONS_HELP,
  CONTRIBUTIONS_UPLOAD_HELP,
} from "@selftune/runtime/contributions/help";
import type {
  ContributionsDefaultResult,
  ContributionsPreferenceResult,
  ContributionsPreviewResult,
  ContributionsStatusResult,
  ContributionsUploadArgs,
  ContributionsUploadResult,
} from "@selftune/runtime/contributions";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG,
  CONTRIBUTIONS_INTERNAL_UPLOAD_HELP_FLAG,
  decodeContributionsInternalValue,
} from "../compatibility/contributions.js";

export interface ContributionsCommandActions {
  readonly status: () => Effect.Effect<void, CLIError>;
  readonly preview: (skill: string) => Effect.Effect<void, CLIError>;
  readonly approve: (skill: string) => Effect.Effect<void, CLIError>;
  readonly revoke: (skill: string) => Effect.Effect<void, CLIError>;
  readonly setDefault: (value: string | undefined) => Effect.Effect<void, CLIError>;
  readonly upload: (options: ContributionsUploadArgs) => Effect.Effect<void, CLIError>;
  readonly reset: () => Effect.Effect<void, CLIError>;
}

interface ContributionsModule {
  readonly runContributionsStatusProgram: () => ContributionsStatusResult;
  readonly formatContributionsStatus: (result: ContributionsStatusResult) => string;
  readonly runContributionsPreviewProgram: (skill: string) => ContributionsPreviewResult;
  readonly formatContributionsPreview: (result: ContributionsPreviewResult) => string;
  readonly runContributionsPreferenceProgram: (
    skill: string,
    status: "opted_in" | "opted_out",
  ) => ContributionsPreferenceResult;
  readonly formatContributionsPreference: (result: ContributionsPreferenceResult) => string;
  readonly runContributionsDefaultProgram: (
    value: string | undefined,
  ) => ContributionsDefaultResult;
  readonly formatContributionsDefault: (result: ContributionsDefaultResult) => string;
  readonly runContributionsUploadProgram: (
    options: ContributionsUploadArgs,
  ) => Promise<ContributionsUploadResult>;
  readonly formatContributionsUpload: (result: ContributionsUploadResult) => string;
  readonly runContributionsResetProgram: () => void;
  readonly formatContributionsReset: () => string;
}

export interface ContributionsActionDependencies {
  readonly loadModule: () => Promise<ContributionsModule>;
  readonly print: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_DEPENDENCIES: ContributionsActionDependencies = {
  loadModule: () => import("@selftune/runtime/contributions"),
  print: (message) => process.stdout.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load contributions support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toContributionsCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Contributions ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        `selftune contributions ${operation} --help`,
      );
}

function loadRuntime(dependencies: ContributionsActionDependencies) {
  return Effect.tryPromise({ try: dependencies.loadModule, catch: importFailure });
}

function writeResult(
  operation: string,
  dependencies: ContributionsActionDependencies,
  output: string,
  exitCode = 0,
) {
  return Effect.try({
    try: () => {
      dependencies.print(output);
      dependencies.setExitCode(exitCode);
    },
    catch: (cause) => toContributionsCliError(operation, cause),
  });
}

export function makeLiveContributionsCommandActions(
  dependencies: ContributionsActionDependencies = LIVE_DEPENDENCIES,
): ContributionsCommandActions {
  return {
    status: Effect.fn("selftune.cli.contributions.status")(function* () {
      const runtime = yield* loadRuntime(dependencies);
      const result = yield* Effect.try({
        try: runtime.runContributionsStatusProgram,
        catch: (cause) => toContributionsCliError("status", cause),
      });
      const output = yield* Effect.try({
        try: () => runtime.formatContributionsStatus(result),
        catch: (cause) => toContributionsCliError("status", cause),
      });
      yield* writeResult("status", dependencies, output);
    }),
    preview: Effect.fn("selftune.cli.contributions.preview")(function* (skill: string) {
      const runtime = yield* loadRuntime(dependencies);
      const result = yield* Effect.try({
        try: () => runtime.runContributionsPreviewProgram(skill),
        catch: (cause) => toContributionsCliError("preview", cause),
      });
      const output = yield* Effect.try({
        try: () => runtime.formatContributionsPreview(result),
        catch: (cause) => toContributionsCliError("preview", cause),
      });
      yield* writeResult("preview", dependencies, output);
    }),
    approve: Effect.fn("selftune.cli.contributions.approve")(function* (skill: string) {
      const runtime = yield* loadRuntime(dependencies);
      const result = yield* Effect.try({
        try: () => runtime.runContributionsPreferenceProgram(skill, "opted_in"),
        catch: (cause) => toContributionsCliError("approve", cause),
      });
      const output = yield* Effect.try({
        try: () => runtime.formatContributionsPreference(result),
        catch: (cause) => toContributionsCliError("approve", cause),
      });
      yield* writeResult("approve", dependencies, output);
    }),
    revoke: Effect.fn("selftune.cli.contributions.revoke")(function* (skill: string) {
      const runtime = yield* loadRuntime(dependencies);
      const result = yield* Effect.try({
        try: () => runtime.runContributionsPreferenceProgram(skill, "opted_out"),
        catch: (cause) => toContributionsCliError("revoke", cause),
      });
      const output = yield* Effect.try({
        try: () => runtime.formatContributionsPreference(result),
        catch: (cause) => toContributionsCliError("revoke", cause),
      });
      yield* writeResult("revoke", dependencies, output);
    }),
    setDefault: Effect.fn("selftune.cli.contributions.default")(function* (
      value: string | undefined,
    ) {
      const runtime = yield* loadRuntime(dependencies);
      const result = yield* Effect.try({
        try: () => runtime.runContributionsDefaultProgram(value),
        catch: (cause) => toContributionsCliError("default", cause),
      });
      const output = yield* Effect.try({
        try: () => runtime.formatContributionsDefault(result),
        catch: (cause) => toContributionsCliError("default", cause),
      });
      yield* writeResult("default", dependencies, output);
    }),
    upload: Effect.fn("selftune.cli.contributions.upload")(function* (
      options: ContributionsUploadArgs,
    ) {
      const runtime = yield* loadRuntime(dependencies);
      const result = yield* Effect.tryPromise({
        try: () => runtime.runContributionsUploadProgram(options),
        catch: (cause) => toContributionsCliError("upload", cause),
      });
      const output = yield* Effect.try({
        try: () => runtime.formatContributionsUpload(result),
        catch: (cause) => toContributionsCliError("upload", cause),
      });
      yield* writeResult("upload", dependencies, output, result.exitCode);
    }),
    reset: Effect.fn("selftune.cli.contributions.reset")(function* () {
      const runtime = yield* loadRuntime(dependencies);
      yield* Effect.try({
        try: runtime.runContributionsResetProgram,
        catch: (cause) => toContributionsCliError("reset", cause),
      });
      const output = yield* Effect.try({
        try: runtime.formatContributionsReset,
        catch: (cause) => toContributionsCliError("reset", cause),
      });
      yield* writeResult("reset", dependencies, output);
    }),
  };
}

const decodeArgument = (value: Option.Option<string>): string =>
  decodeContributionsInternalValue(Option.getOrUndefined(value)) ?? "";
const decodeFlag = (value: Option.Option<string>): string | undefined =>
  decodeContributionsInternalValue(Option.getOrUndefined(value));

export function makeContributionsCommand(
  actions: ContributionsCommandActions = makeLiveContributionsCommandActions(),
) {
  const status = Command.make("status", {}, () => actions.status());
  const preview = Command.make(
    "preview",
    { skill: Argument.string("skill").pipe(Argument.optional) },
    ({ skill }) => actions.preview(decodeArgument(skill)),
  );
  const approve = Command.make(
    "approve",
    { skill: Argument.string("skill").pipe(Argument.optional) },
    ({ skill }) => actions.approve(decodeArgument(skill)),
  );
  const revoke = Command.make(
    "revoke",
    { skill: Argument.string("skill").pipe(Argument.optional) },
    ({ skill }) => actions.revoke(decodeArgument(skill)),
  );
  const setDefault = Command.make(
    "default",
    { value: Argument.string("value").pipe(Argument.optional) },
    ({ value }) => actions.setDefault(decodeFlag(value)),
  );
  const upload = Command.make(
    "upload",
    {
      internalHelp: Flag.boolean(CONTRIBUTIONS_INTERNAL_UPLOAD_HELP_FLAG),
      dryRun: Flag.boolean("dry-run"),
      retryFailed: Flag.boolean("retry-failed"),
      limit: Flag.string("limit").pipe(Flag.optional),
      endpoint: Flag.string("endpoint").pipe(Flag.optional),
      apiKey: Flag.string("api-key").pipe(Flag.optional),
    },
    (input) => {
      if (input.internalHelp) return Console.log(CONTRIBUTIONS_UPLOAD_HELP);
      const limit = decodeFlag(input.limit);
      return actions.upload({
        dryRun: input.dryRun,
        retryFailed: input.retryFailed,
        limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
        endpoint: decodeFlag(input.endpoint),
        apiKey: decodeFlag(input.apiKey),
      });
    },
  );
  const reset = Command.make("reset", {}, () => actions.reset());

  return Command.make(
    "contributions",
    { internalHelp: Flag.boolean(CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG) },
    ({ internalHelp }) => (internalHelp ? Console.log(CONTRIBUTIONS_HELP) : Effect.void),
  ).pipe(
    Command.withSubcommands([status, preview, approve, revoke, setDefault, upload, reset]),
    Command.withDescription("Manage creator-directed sharing preferences"),
  );
}
