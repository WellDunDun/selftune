import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  LocalDatabaseLive,
  type LocalDatabaseError,
  type LocalDatabaseService,
} from "@selftune/local-store";
import type {
  WorkflowProgramInput,
  WorkflowProgramResult,
} from "@selftune/runtime/workflows/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  WORKFLOWS_HELP,
  WORKFLOWS_INTERNAL_PARENT_HELP_FLAG,
  decodeWorkflowsInternalValue,
} from "../compatibility/workflows.js";

export type WorkflowsAction = (
  input: WorkflowProgramInput,
  jsonRequested: boolean,
) => Effect.Effect<void, CLIError>;

interface WorkflowsModule {
  readonly runWorkflowProgram: (
    input: WorkflowProgramInput,
  ) => Effect.Effect<WorkflowProgramResult, CLIError, LocalDatabaseService>;
  readonly formatWorkflowResult: (result: WorkflowProgramResult, jsonOutput: boolean) => string;
}

export interface WorkflowsActionDependencies {
  readonly loadModule: () => Promise<WorkflowsModule>;
  readonly print: (message: string) => void;
  readonly isTTY: () => boolean;
  readonly setExitCode: (exitCode: number) => void;
  readonly databaseLayer?: Layer.Layer<LocalDatabaseService, LocalDatabaseError>;
}

const LIVE_DEPENDENCIES: WorkflowsActionDependencies = {
  loadModule: () => import("@selftune/runtime/workflows/programs"),
  print: (message) => process.stdout.write(`${message}\n`),
  isTTY: () => process.stdout.isTTY === true,
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load workflow discovery support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Workflow ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune workflows --help",
      );
}

export const runWorkflowsActionWithDependencies = Effect.fn(
  function* (
    input: WorkflowProgramInput,
    jsonRequested: boolean,
    dependencies: WorkflowsActionDependencies,
  ) {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const program = yield* Effect.try({
      try: () => runtime.runWorkflowProgram(input),
      catch: (cause) => toCliError(input.operation, cause),
    });
    const result = yield* program.pipe(
      Effect.provide(dependencies.databaseLayer ?? LocalDatabaseLive),
      Effect.mapError((cause) => toCliError(input.operation, cause)),
    );
    const output = yield* Effect.try({
      try: () => runtime.formatWorkflowResult(result, jsonRequested || !dependencies.isTTY()),
      catch: (cause) => toCliError(input.operation, cause),
    });
    yield* Effect.try({
      try: () => {
        dependencies.print(output);
        dependencies.setExitCode(0);
      },
      catch: (cause) => toCliError(input.operation, cause),
    });
  },
  (effect, input) => effect.pipe(Effect.withSpan(`selftune.cli.workflows.${input.operation}`)),
);

export function makeLiveWorkflowsAction(
  dependencies: WorkflowsActionDependencies = LIVE_DEPENDENCIES,
): WorkflowsAction {
  return (input, jsonRequested) =>
    runWorkflowsActionWithDependencies(input, jsonRequested, dependencies);
}

function decode(value: Option.Option<string>): string | undefined {
  return decodeWorkflowsInternalValue(Option.getOrUndefined(value));
}

function decodeNumber(value: Option.Option<string>): number | undefined {
  const decoded = decode(value);
  return decoded === undefined ? undefined : Number(decoded);
}

const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);

export function makeWorkflowsCommand(action: WorkflowsAction = makeLiveWorkflowsAction()) {
  const discover = Command.make(
    "discover",
    {
      minOccurrences: optionalString("min-occurrences"),
      window: optionalString("window"),
      skill: optionalString("skill"),
      json: Flag.boolean("json"),
    },
    (input) =>
      action(
        {
          operation: "discover",
          minOccurrences: decodeNumber(input.minOccurrences),
          window: decodeNumber(input.window),
          skill: decode(input.skill),
        },
        input.json,
      ),
  );
  const save = Command.make(
    "save",
    {
      selection: optionalString("selection"),
      minOccurrences: optionalString("min-occurrences"),
      window: optionalString("window"),
      skill: optionalString("skill"),
      skillPath: optionalString("skill-path"),
    },
    (input) =>
      action(
        {
          operation: "save",
          selection: decode(input.selection),
          minOccurrences: decodeNumber(input.minOccurrences),
          window: decodeNumber(input.window),
          skill: decode(input.skill),
          skillPath: decode(input.skillPath),
        },
        false,
      ),
  );
  const scaffold = Command.make(
    "scaffold",
    {
      selection: optionalString("selection"),
      minOccurrences: optionalString("min-occurrences"),
      window: optionalString("window"),
      skill: optionalString("skill"),
      outputDir: optionalString("output-dir"),
      skillName: optionalString("skill-name"),
      description: optionalString("description"),
      write: Flag.boolean("write"),
      force: Flag.boolean("force"),
      json: Flag.boolean("json"),
    },
    (input) =>
      action(
        {
          operation: "scaffold",
          selection: decode(input.selection),
          minOccurrences: decodeNumber(input.minOccurrences),
          window: decodeNumber(input.window),
          skill: decode(input.skill),
          outputDir: decode(input.outputDir),
          skillName: decode(input.skillName),
          description: decode(input.description),
          write: input.write,
          force: input.force,
        },
        input.json,
      ),
  );

  return Command.make(
    "workflows",
    { internalHelp: Flag.boolean(WORKFLOWS_INTERNAL_PARENT_HELP_FLAG) },
    ({ internalHelp }) => (internalHelp ? Console.log(WORKFLOWS_HELP) : Effect.void),
  ).pipe(
    Command.withSubcommands([discover, save, scaffold]),
    Command.withDescription("Discover repeated multi-skill patterns"),
  );
}
