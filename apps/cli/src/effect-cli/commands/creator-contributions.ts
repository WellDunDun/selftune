import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  CREATOR_CONTRIBUTIONS_DISABLE_HELP,
  CREATOR_CONTRIBUTIONS_ENABLE_HELP,
  CREATOR_CONTRIBUTIONS_HELP,
  CREATOR_CONTRIBUTIONS_STATUS_HELP,
} from "@selftune/runtime/creator-contributions-help";
import type {
  CreatorContributionsDisableResult,
  CreatorContributionsEnableResult,
  CreatorContributionsStatusResult,
  RunCreatorContributionsEnableOptions,
} from "@selftune/runtime/creator-contributions";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  CREATOR_CONTRIBUTIONS_INTERNAL_DISABLE_HELP_FLAG,
  CREATOR_CONTRIBUTIONS_INTERNAL_ENABLE_HELP_FLAG,
  CREATOR_CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG,
  CREATOR_CONTRIBUTIONS_INTERNAL_STATUS_HELP_FLAG,
  decodeCreatorContributionsInternalValue,
} from "../compatibility/creator-contributions.js";

export interface CreatorContributionsCommandActions {
  readonly status: (skill?: string) => Effect.Effect<void, CLIError>;
  readonly enable: (options: RunCreatorContributionsEnableOptions) => Effect.Effect<void, CLIError>;
  readonly disable: (skill?: string, skillPath?: string) => Effect.Effect<void, CLIError>;
}

interface CreatorContributionsModule {
  readonly runCreatorContributionsStatusProgram: (
    skill?: string,
  ) => CreatorContributionsStatusResult;
  readonly formatCreatorContributionsStatus: (result: CreatorContributionsStatusResult) => string;
  readonly runCreatorContributionsEnableProgram: (
    options: RunCreatorContributionsEnableOptions,
  ) => CreatorContributionsEnableResult;
  readonly formatCreatorContributionsEnable: (result: CreatorContributionsEnableResult) => string;
  readonly runCreatorContributionsDisableProgram: (
    skill?: string,
    skillPath?: string,
  ) => CreatorContributionsDisableResult;
  readonly formatCreatorContributionsDisable: (result: CreatorContributionsDisableResult) => string;
}

export interface CreatorContributionsActionDependencies {
  readonly loadModule: () => Promise<CreatorContributionsModule>;
  readonly print: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_DEPENDENCIES: CreatorContributionsActionDependencies = {
  loadModule: () => import("@selftune/runtime/creator-contributions"),
  print: (message) => process.stdout.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load creator-contributions support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Creator contributions ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        `selftune creator-contributions ${operation} --help`,
      );
}

function execute<Result>(
  operation: string,
  dependencies: CreatorContributionsActionDependencies,
  run: (runtime: CreatorContributionsModule) => Result,
  format: (runtime: CreatorContributionsModule, result: Result) => string,
) {
  return Effect.gen(function* () {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const result = yield* Effect.try({
      try: () => run(runtime),
      catch: (cause) => toCliError(operation, cause),
    });
    const output = yield* Effect.try({
      try: () => format(runtime, result),
      catch: (cause) => toCliError(operation, cause),
    });
    yield* Effect.try({
      try: () => {
        dependencies.print(output);
        dependencies.setExitCode(0);
      },
      catch: (cause) => toCliError(operation, cause),
    });
  }).pipe(Effect.withSpan(`selftune.cli.creatorContributions.${operation}`));
}

export function makeLiveCreatorContributionsCommandActions(
  dependencies: CreatorContributionsActionDependencies = LIVE_DEPENDENCIES,
): CreatorContributionsCommandActions {
  return {
    status: (skill) =>
      execute(
        "status",
        dependencies,
        (runtime) => runtime.runCreatorContributionsStatusProgram(skill),
        (runtime, result) => runtime.formatCreatorContributionsStatus(result),
      ),
    enable: (options) =>
      execute(
        "enable",
        dependencies,
        (runtime) => runtime.runCreatorContributionsEnableProgram(options),
        (runtime, result) => runtime.formatCreatorContributionsEnable(result),
      ),
    disable: (skill, skillPath) =>
      execute(
        "disable",
        dependencies,
        (runtime) => runtime.runCreatorContributionsDisableProgram(skill, skillPath),
        (runtime, result) => runtime.formatCreatorContributionsDisable(result),
      ),
  };
}

function decode(value: Option.Option<string>): string | undefined {
  return decodeCreatorContributionsInternalValue(Option.getOrUndefined(value));
}

export function makeCreatorContributionsCommand(
  actions: CreatorContributionsCommandActions = makeLiveCreatorContributionsCommandActions(),
) {
  const status = Command.make(
    "status",
    {
      internalHelp: Flag.boolean(CREATOR_CONTRIBUTIONS_INTERNAL_STATUS_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.optional),
    },
    (input) =>
      input.internalHelp
        ? Console.log(CREATOR_CONTRIBUTIONS_STATUS_HELP)
        : actions.status(decode(input.skill)),
  );
  const enable = Command.make(
    "enable",
    {
      internalHelp: Flag.boolean(CREATOR_CONTRIBUTIONS_INTERNAL_ENABLE_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.optional),
      all: Flag.boolean("all"),
      prefix: Flag.string("prefix").pipe(Flag.optional),
      skillPath: Flag.string("skill-path").pipe(Flag.optional),
      creatorId: Flag.string("creator-id").pipe(Flag.optional),
      signals: Flag.string("signals").pipe(Flag.optional),
      message: Flag.string("message").pipe(Flag.optional),
      privacyUrl: Flag.string("privacy-url").pipe(Flag.optional),
      feedbackEndpoint: Flag.string("feedback-endpoint").pipe(Flag.optional),
      noHelper: Flag.boolean("no-helper"),
    },
    (input) =>
      input.internalHelp
        ? Console.log(CREATOR_CONTRIBUTIONS_ENABLE_HELP)
        : actions.enable({
            skillName: decode(input.skill),
            all: input.all,
            prefix: decode(input.prefix),
            explicitSkillPath: decode(input.skillPath),
            explicitCreatorId: decode(input.creatorId),
            signals: decode(input.signals),
            message: decode(input.message),
            privacyUrl: decode(input.privacyUrl),
            helper: !input.noHelper,
            feedbackEndpoint: decode(input.feedbackEndpoint),
          }),
  );
  const disable = Command.make(
    "disable",
    {
      internalHelp: Flag.boolean(CREATOR_CONTRIBUTIONS_INTERNAL_DISABLE_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.optional),
      skillPath: Flag.string("skill-path").pipe(Flag.optional),
    },
    (input) =>
      input.internalHelp
        ? Console.log(CREATOR_CONTRIBUTIONS_DISABLE_HELP)
        : actions.disable(decode(input.skill), decode(input.skillPath)),
  );

  return Command.make(
    "creator-contributions",
    { internalHelp: Flag.boolean(CREATOR_CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG) },
    ({ internalHelp }) => (internalHelp ? Console.log(CREATOR_CONTRIBUTIONS_HELP) : Effect.void),
  ).pipe(
    Command.withSubcommands([status, enable, disable]),
    Command.withDescription("Manage creator sharing setup configs"),
  );
}
