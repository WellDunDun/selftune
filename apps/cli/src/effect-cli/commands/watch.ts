import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import type {
  WatchProgramInput,
  WatchProgramResult,
  WatchProgramRuntime,
  WatchDiagnostics,
  WatchRuntime,
} from "@selftune/orchestration/watch/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  decodeWatchInternalValue,
  WATCH_HELP,
  WATCH_INTERNAL_HELP_FLAG,
  WatchLegacyRuntimeFailure,
} from "../compatibility/watch.js";

export type WatchAction = (
  input: WatchProgramInput,
) => Effect.Effect<void, CLIError | WatchLegacyRuntimeFailure>;

export interface WatchProgramModule {
  readonly isWatchInternalFailure: (cause: unknown) => boolean;
  readonly makeWatchDiagnosticsLayer: (
    report: (message: string) => void,
  ) => Layer.Layer<WatchDiagnostics>;
  readonly runWatchProgram: (
    input: WatchProgramInput,
  ) => Effect.Effect<WatchProgramResult, unknown, WatchProgramRuntime>;
  readonly watchLiveLayer: Layer.Layer<WatchRuntime, unknown>;
}

export interface WatchActionDependencies {
  readonly loadModule: () => Promise<WatchProgramModule>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
  readonly setExitCode: (exitCode: 0 | 1) => void;
}

const LIVE_DEPENDENCIES: WatchActionDependencies = {
  loadModule: () => import("@selftune/orchestration/watch/programs"),
  writeStdout: (message) => process.stdout.write(`${message}\n`),
  writeStderr: (message) => process.stderr.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load watch support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(
  cause: unknown,
  isInternalFailure: (cause: unknown) => boolean = () => false,
): CLIError | WatchLegacyRuntimeFailure {
  if (isInternalFailure(cause)) {
    return new WatchLegacyRuntimeFailure(cause);
  }
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Watch failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune watch --help",
      );
}

export function runWatchActionWithDependencies(
  input: WatchProgramInput,
  dependencies: WatchActionDependencies,
) {
  return Effect.fn("selftune.cli.watch")(function* () {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const program = yield* Effect.try({
      try: () => runtime.runWatchProgram(input),
      catch: (cause) => toCliError(cause, runtime.isWatchInternalFailure),
    });
    const diagnosticsLayer = runtime.makeWatchDiagnosticsLayer(dependencies.writeStderr);
    const result = yield* program.pipe(
      Effect.provide(Layer.merge(runtime.watchLiveLayer, diagnosticsLayer)),
      Effect.mapError((cause) => toCliError(cause, runtime.isWatchInternalFailure)),
    );
    yield* Effect.try({
      try: () => {
        for (const message of result.stderr) dependencies.writeStderr(message);
        for (const message of result.stdout) dependencies.writeStdout(message);
        dependencies.setExitCode(result.exitCode);
      },
      catch: toCliError,
    });
  })();
}

export function makeLiveWatchAction(
  dependencies: WatchActionDependencies = LIVE_DEPENDENCIES,
): WatchAction {
  return (input) => runWatchActionWithDependencies(input, dependencies);
}

function decode(value: Option.Option<string>): string {
  return decodeWatchInternalValue(Option.getOrElse(value, () => ""));
}

export function makeWatchCommand(action: WatchAction = makeLiveWatchAction()) {
  return Command.make(
    "watch",
    {
      skillName: Flag.string("skill").pipe(Flag.optional),
      skillPath: Flag.string("skill-path").pipe(Flag.optional),
      windowSessions: Flag.integer("window").pipe(Flag.optional),
      regressionThreshold: Flag.float("threshold").pipe(Flag.optional),
      gradeRegressionThreshold: Flag.float("grade-threshold").pipe(Flag.optional),
      autoRollback: Flag.boolean("auto-rollback"),
      disableGradeWatch: Flag.boolean("no-grade-watch"),
      syncFirst: Flag.boolean("sync-first"),
      syncForce: Flag.boolean("sync-force"),
      internalHelp: Flag.boolean(WATCH_INTERNAL_HELP_FLAG),
    },
    (input) =>
      input.internalHelp
        ? Console.log(WATCH_HELP)
        : action({
            skillName: decode(input.skillName),
            skillPath: decode(input.skillPath),
            windowSessions: Option.getOrElse(input.windowSessions, () => 20),
            regressionThreshold: Option.getOrElse(input.regressionThreshold, () => 0.1),
            gradeRegressionThreshold: Option.getOrElse(input.gradeRegressionThreshold, () => 0.15),
            enableGradeWatch: !input.disableGradeWatch,
            autoRollback: input.autoRollback,
            syncFirst: input.syncFirst,
            syncForce: input.syncForce,
          }),
  ).pipe(Command.withDescription("Monitor post-deploy skill health"));
}
