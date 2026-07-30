import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { LIBRARY_HELP } from "@selftune/runtime/library/help";
import type { LibraryProgramInput, LibraryProgramResult } from "@selftune/runtime/library/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  LIBRARY_INTERNAL_PARENT_HELP_FLAG,
  decodeLibraryInternalValue,
} from "../compatibility/library.js";

export type LibraryAction = (input: LibraryProgramInput) => Effect.Effect<void, CLIError>;

interface LibraryModule {
  readonly runLibraryProgram: (
    input: LibraryProgramInput,
  ) => Effect.Effect<LibraryProgramResult, CLIError>;
  readonly formatLibraryResult: (result: LibraryProgramResult) => string;
}

export interface LibraryActionDependencies {
  readonly loadModule: () => Promise<LibraryModule>;
  readonly print: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_DEPENDENCIES: LibraryActionDependencies = {
  loadModule: () => import("@selftune/runtime/library/programs"),
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
    `Unable to load Skill Library support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Skill Library ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune library --help",
      );
}

export function runLibraryActionWithDependencies(
  input: LibraryProgramInput,
  dependencies: LibraryActionDependencies,
) {
  return Effect.fn(`selftune.cli.library.${input.operation}`)(function* () {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const program = yield* Effect.try({
      try: () => runtime.runLibraryProgram(input),
      catch: (cause) => toCliError(input.operation, cause),
    });
    const result = yield* program;
    const output = yield* Effect.try({
      try: () => runtime.formatLibraryResult(result),
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

export function makeLiveLibraryAction(
  dependencies: LibraryActionDependencies = LIVE_DEPENDENCIES,
): LibraryAction {
  return (input) => runLibraryActionWithDependencies(input, dependencies);
}

function decode(value: Option.Option<string>): string | undefined {
  return decodeLibraryInternalValue(Option.getOrUndefined(value));
}

const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);

export function makeLibraryCommand(action: LibraryAction = makeLiveLibraryAction()) {
  const list = Command.make("list", {}, () => action({ operation: "list" }));
  const configure = Command.make(
    "configure",
    { url: optionalString("url"), apiKey: optionalString("api-key") },
    (input) =>
      action({ operation: "configure", url: decode(input.url), apiKey: decode(input.apiKey) }),
  );
  const preview = Command.make("preview", {}, () => action({ operation: "preview" }));
  const sync = Command.make("sync", {}, () => action({ operation: "sync" }));
  const status = Command.make("status", {}, () => action({ operation: "status" }));
  const diagnostics = Command.make("diagnostics", {}, () => action({ operation: "diagnostics" }));
  const exportLibrary = Command.make("export", { output: optionalString("output") }, (input) =>
    action({ operation: "export", output: decode(input.output) }),
  );
  const restore = Command.make("restore", { target: optionalString("target") }, (input) =>
    action({ operation: "restore", target: decode(input.target) }),
  );

  const synthesizeScan = Command.make("scan", {}, () => action({ operation: "synthesize.scan" }));
  const synthesizeList = Command.make("list", {}, () => action({ operation: "synthesize.list" }));
  const synthesizeReview = Command.make(
    "review",
    {
      candidateId: optionalString("candidate-id"),
      action: optionalString("action"),
      reason: optionalString("reason"),
      snoozeUntil: optionalString("snooze-until"),
      title: optionalString("title"),
      summary: optionalString("summary"),
    },
    (input) =>
      action({
        operation: "synthesize.review",
        candidateId: decode(input.candidateId),
        action: decode(input.action),
        reason: decode(input.reason),
        snoozedUntil: decode(input.snoozeUntil),
        title: decode(input.title),
        summary: decode(input.summary),
      }),
  );
  const synthesizeDraft = Command.make(
    "draft",
    { candidateId: optionalString("candidate-id"), outputDir: optionalString("output-dir") },
    (input) =>
      action({
        operation: "synthesize.draft",
        candidateId: decode(input.candidateId),
        outputDir: decode(input.outputDir),
      }),
  );
  const synthesizeEvaluate = Command.make(
    "evaluate",
    { candidateId: optionalString("candidate-id") },
    (input) => action({ operation: "synthesize.evaluate", candidateId: decode(input.candidateId) }),
  );
  const synthesizeRelease = Command.make(
    "release",
    { candidateId: optionalString("candidate-id") },
    (input) => action({ operation: "synthesize.release", candidateId: decode(input.candidateId) }),
  );
  const synthesize = Command.make("synthesize").pipe(
    Command.withSubcommands([
      synthesizeScan,
      synthesizeList,
      synthesizeReview,
      synthesizeDraft,
      synthesizeEvaluate,
      synthesizeRelease,
    ]),
  );

  return Command.make(
    "library",
    { internalHelp: Flag.boolean(LIBRARY_INTERNAL_PARENT_HELP_FLAG) },
    ({ internalHelp }) => (internalHelp ? Console.log(LIBRARY_HELP) : Effect.void),
  ).pipe(
    Command.withSubcommands([
      list,
      configure,
      preview,
      sync,
      status,
      diagnostics,
      exportLibrary,
      restore,
      synthesize,
    ]),
    Command.withDescription("Reconcile and back up the local-first Skill Library"),
  );
}
