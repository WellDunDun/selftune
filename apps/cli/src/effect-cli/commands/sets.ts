import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { SKILL_SETS_HELP } from "@selftune/runtime/skill-sets/help";
import type {
  SkillSetsProgramInput,
  SkillSetsProgramResult,
} from "@selftune/runtime/skill-sets/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  SETS_INTERNAL_HELP_FLAG,
  SETS_INTERNAL_PARENT_HELP_FLAG,
  decodeSetsInternalValue,
} from "../compatibility/sets.js";

export type SkillSetsAction = (
  input: SkillSetsProgramInput,
  jsonRequested: boolean,
) => Effect.Effect<void, CLIError>;

interface SkillSetsModule {
  readonly runSkillSetsProgram: (
    input: SkillSetsProgramInput,
  ) => Effect.Effect<SkillSetsProgramResult, unknown>;
  readonly formatSkillSetsResult: (result: SkillSetsProgramResult, jsonMode: boolean) => string;
}

export interface SkillSetsActionDependencies {
  readonly loadModule: () => Promise<SkillSetsModule>;
  readonly print: (message: string) => void;
  readonly isTTY: () => boolean;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_DEPENDENCIES: SkillSetsActionDependencies = {
  loadModule: () => import("@selftune/runtime/skill-sets/programs"),
  print: (message) => process.stdout.write(`${message}\n`),
  isTTY: () => process.stdout.isTTY === true,
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load Skill Sets support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Skill Sets ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        `selftune sets ${operation} --help`,
      );
}

export function runSkillSetsActionWithDependencies(
  input: SkillSetsProgramInput,
  jsonRequested: boolean,
  dependencies: SkillSetsActionDependencies,
) {
  return Effect.fn(`selftune.cli.sets.${input.operation}`)(function* () {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const program = yield* Effect.try({
      try: () => runtime.runSkillSetsProgram(input),
      catch: (cause) => toCliError(input.operation, cause),
    });
    const result = yield* program.pipe(
      Effect.mapError((cause) => toCliError(input.operation, cause)),
    );
    const output = yield* Effect.try({
      try: () => runtime.formatSkillSetsResult(result, jsonRequested || !dependencies.isTTY()),
      catch: (cause) => toCliError(input.operation, cause),
    });
    yield* Effect.try({
      try: () => {
        dependencies.print(output);
        dependencies.setExitCode(0);
      },
      catch: (cause) => toCliError(input.operation, cause),
    });
  })();
}

export function makeLiveSkillSetsAction(
  dependencies: SkillSetsActionDependencies = LIVE_DEPENDENCIES,
): SkillSetsAction {
  return (input, jsonRequested) =>
    runSkillSetsActionWithDependencies(input, jsonRequested, dependencies);
}

function decode(value: Option.Option<string>): string | undefined {
  return decodeSetsInternalValue(Option.getOrUndefined(value));
}

function decodeMany(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.map((value) => decodeSetsInternalValue(value) ?? "");
}

function helpOrRun(
  internalHelp: boolean,
  action: SkillSetsAction,
  input: SkillSetsProgramInput,
  json: boolean,
) {
  return internalHelp ? Console.log(SKILL_SETS_HELP) : action(input, json);
}

const helpFlag = () => Flag.boolean(SETS_INTERNAL_HELP_FLAG);
const jsonFlag = () => Flag.boolean("json");
const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);
const repeatedString = (name: string) => Flag.string(name).pipe(Flag.atLeast(0));

export function makeSkillSetsCommand(action: SkillSetsAction = makeLiveSkillSetsAction()) {
  const list = Command.make("list", { internalHelp: helpFlag(), json: jsonFlag() }, (input) =>
    helpOrRun(input.internalHelp, action, { operation: "list" }, input.json),
  );
  const receipts = Command.make(
    "receipts",
    { internalHelp: helpFlag(), json: jsonFlag() },
    (input) => helpOrRun(input.internalHelp, action, { operation: "receipts" }, input.json),
  );
  const outcomes = Command.make(
    "outcomes",
    { internalHelp: helpFlag(), json: jsonFlag() },
    (input) => helpOrRun(input.internalHelp, action, { operation: "outcomes" }, input.json),
  );
  const suggest = Command.make(
    "suggest",
    {
      internalHelp: helpFlag(),
      minOccurrences: optionalString("min-occurrences"),
      minAffinity: optionalString("min-affinity"),
      holdoutRatio: optionalString("holdout-ratio"),
      minValidationOccurrences: optionalString("min-validation-occurrences"),
      minEvidenceScore: optionalString("min-evidence-score"),
      max: optionalString("max"),
      json: jsonFlag(),
    },
    (input) =>
      helpOrRun(
        input.internalHelp,
        action,
        {
          operation: "suggest",
          minOccurrences: Number(decode(input.minOccurrences) ?? "3"),
          minAffinity: Number(decode(input.minAffinity) ?? "0.35"),
          holdoutRatio: Number(decode(input.holdoutRatio) ?? "0.25"),
          minValidationOccurrences: Number(decode(input.minValidationOccurrences) ?? "2"),
          minEvidenceScore:
            decode(input.minEvidenceScore) === undefined
              ? undefined
              : Number(decode(input.minEvidenceScore)),
          maxSuggestions: Number(decode(input.max) ?? "6"),
        },
        input.json,
      ),
  );
  const create = Command.make(
    "create",
    {
      internalHelp: helpFlag(),
      name: optionalString("name"),
      description: optionalString("description"),
      harnesses: repeatedString("harness"),
      skillPaths: repeatedString("skill-path"),
      json: jsonFlag(),
    },
    (input) =>
      helpOrRun(
        input.internalHelp,
        action,
        {
          operation: "create",
          name: decode(input.name),
          description: decode(input.description),
          harnesses: decodeMany(input.harnesses),
          skillPaths: decodeMany(input.skillPaths),
        },
        input.json,
      ),
  );
  const update = Command.make(
    "update",
    {
      setId: optionalString("set"),
      parentRevision: optionalString("parent-revision"),
      name: optionalString("name"),
      description: optionalString("description"),
      harnesses: repeatedString("harness"),
      skillPaths: repeatedString("skill-path"),
      json: jsonFlag(),
    },
    (input) =>
      action(
        {
          operation: "update",
          setId: decode(input.setId),
          parentRevision: decode(input.parentRevision),
          name: decode(input.name),
          description: decode(input.description),
          harnesses: decodeMany(input.harnesses),
          skillPaths: decodeMany(input.skillPaths),
        },
        input.json,
      ),
  );
  const derive = Command.make(
    "derive",
    {
      name: optionalString("name"),
      description: optionalString("description"),
      project: optionalString("project"),
      harnesses: repeatedString("harness"),
      json: jsonFlag(),
    },
    (input) =>
      action(
        {
          operation: "derive",
          name: decode(input.name),
          description: decode(input.description),
          project: decode(input.project),
          harnesses: decodeMany(input.harnesses),
        },
        input.json,
      ),
  );
  const capture = Command.make(
    "capture",
    {
      internalHelp: helpFlag(),
      name: optionalString("name"),
      description: optionalString("description"),
      project: optionalString("project"),
      harnesses: repeatedString("harness"),
      json: jsonFlag(),
    },
    (input) =>
      helpOrRun(
        input.internalHelp,
        action,
        {
          operation: "capture",
          name: decode(input.name),
          description: decode(input.description),
          project: decode(input.project),
          harnesses: decodeMany(input.harnesses),
        },
        input.json,
      ),
  );
  const history = Command.make(
    "history",
    { setId: optionalString("set"), json: jsonFlag() },
    (input) => action({ operation: "history", setId: decode(input.setId) }, input.json),
  );
  const exportSet = Command.make(
    "export",
    {
      setId: optionalString("set"),
      project: optionalString("project"),
      output: optionalString("output"),
    },
    (input) =>
      action(
        {
          operation: "export",
          setId: decode(input.setId),
          project: decode(input.project),
          output: decode(input.output),
        },
        false,
      ),
  );
  const importSet = Command.make(
    "import",
    { manifest: optionalString("manifest"), json: jsonFlag() },
    (input) => action({ operation: "import", manifest: decode(input.manifest) }, input.json),
  );
  const plan = Command.make(
    "plan",
    {
      internalHelp: helpFlag(),
      setId: optionalString("set"),
      project: optionalString("project"),
      json: jsonFlag(),
    },
    (input) =>
      helpOrRun(
        input.internalHelp,
        action,
        { operation: "plan", setId: decode(input.setId), project: decode(input.project) },
        input.json,
      ),
  );
  const apply = Command.make(
    "apply",
    {
      internalHelp: helpFlag(),
      setId: optionalString("set"),
      project: optionalString("project"),
      json: jsonFlag(),
    },
    (input) =>
      helpOrRun(
        input.internalHelp,
        action,
        { operation: "apply", setId: decode(input.setId), project: decode(input.project) },
        input.json,
      ),
  );
  const rollback = Command.make(
    "rollback",
    {
      internalHelp: helpFlag(),
      receiptId: optionalString("receipt"),
      json: jsonFlag(),
    },
    (input) =>
      helpOrRun(
        input.internalHelp,
        action,
        { operation: "rollback", receiptId: decode(input.receiptId) },
        input.json,
      ),
  );

  return Command.make(
    "sets",
    { internalHelp: Flag.boolean(SETS_INTERNAL_PARENT_HELP_FLAG) },
    ({ internalHelp }) => (internalHelp ? Console.log(SKILL_SETS_HELP) : Effect.void),
  ).pipe(
    Command.withSubcommands([
      list,
      suggest,
      outcomes,
      create,
      update,
      capture,
      derive,
      history,
      exportSet,
      importSet,
      plan,
      apply,
      receipts,
      rollback,
    ]),
    Command.withDescription("Reusable project skill configurations"),
  );
}
