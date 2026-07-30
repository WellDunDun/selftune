import * as Effect from "effect/Effect";

import type { CreateBaselineResult } from "@selftune/runtime/create/baseline";
import type { CreateCheckResult } from "@selftune/runtime/types";
import type {
  CreatePublishResult,
  RunCreatePublishOptions,
} from "@selftune/runtime/create/publish";
import type { CreateReplayResult, RunCreateReplayOptions } from "@selftune/runtime/create/replay";
import type {
  CreateScaffoldResult,
  RunCreateScaffoldOptions,
} from "@selftune/runtime/create/scaffold";
import type { CreateSkillInitResult, RunCreateInitOptions } from "@selftune/runtime/create/init";
import type { CreatePackageEvaluationResult } from "@selftune/runtime/create/package-evaluator";
import type { RunCreateReportOptions } from "@selftune/runtime/create/report";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import type {
  CreateCommandActions,
  CreateEvaluationInput,
  CreatePublishInput,
} from "./contracts.js";

interface InitModule {
  readonly runCreateInit: (options: RunCreateInitOptions) => CreateSkillInitResult;
  readonly formatInitResult: (result: CreateSkillInitResult) => string;
}

interface StatusModule {
  readonly runCreateStatus: (skillPath: string) => Promise<CreateCheckResult>;
  readonly formatCreateCheckResult: (result: CreateCheckResult) => string;
}

interface ScaffoldModule {
  readonly runCreateScaffold: (options: RunCreateScaffoldOptions) => CreateScaffoldResult;
  readonly formatCreateScaffoldResult: (result: CreateScaffoldResult) => string;
  readonly createScaffoldJsonResult: (result: CreateScaffoldResult) => unknown;
}

interface CheckModule {
  readonly runCreateCheck: (skillPath: string) => Promise<CreateCheckResult>;
  readonly formatCreateCheckResult: (result: CreateCheckResult) => string;
}

interface ReplayModule {
  readonly runCreateReplay: (options: RunCreateReplayOptions) => Promise<CreateReplayResult>;
  readonly formatReplayResult: (result: CreateReplayResult) => string;
}

interface BaselineModule {
  readonly runCreateBaselineAndPersist: (options: {
    readonly skillPath: string;
    readonly mode: "routing" | "package";
    readonly agent?: string;
    readonly evalSetPath?: string;
  }) => Promise<CreateBaselineResult>;
  readonly formatBaselineResult: (result: CreateBaselineResult) => string;
}

interface ReportModule {
  readonly runCreateReport: (
    options: RunCreateReportOptions,
  ) => Promise<CreatePackageEvaluationResult>;
  readonly formatCreatePackageBenchmarkReport: (result: CreatePackageEvaluationResult) => string;
}

interface PublishModule {
  readonly runCreatePublish: (options: RunCreatePublishOptions) => Promise<CreatePublishResult>;
  readonly formatCreatePublishResult: (result: CreatePublishResult) => string;
}

export interface CreateActionOutput {
  readonly isStdoutTTY: () => boolean;
  readonly print: (value: string) => void;
  readonly setExitCode: (code: number) => void;
}

export interface CreateActionDependencies {
  readonly loadInit: () => Promise<InitModule>;
  readonly loadStatus: () => Promise<StatusModule>;
  readonly loadScaffold: () => Promise<ScaffoldModule>;
  readonly loadCheck: () => Promise<CheckModule>;
  readonly loadReplay: () => Promise<ReplayModule>;
  readonly loadBaseline: () => Promise<BaselineModule>;
  readonly loadReport: () => Promise<ReportModule>;
  readonly loadPublish: () => Promise<PublishModule>;
  readonly output: CreateActionOutput;
}

const LIVE_DEPENDENCIES: CreateActionDependencies = {
  loadInit: () => import("@selftune/runtime/create/init"),
  loadStatus: () => import("@selftune/runtime/create/status"),
  loadScaffold: () => import("@selftune/runtime/create/scaffold"),
  loadCheck: () => import("@selftune/runtime/create/check"),
  loadReplay: () => import("@selftune/runtime/create/replay"),
  loadBaseline: () => import("@selftune/runtime/create/baseline"),
  loadReport: () => import("@selftune/runtime/create/report"),
  loadPublish: () => import("@selftune/runtime/create/publish"),
  output: {
    isStdoutTTY: () => process.stdout.isTTY === true,
    print: (value) => process.stdout.write(`${value}\n`),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
};

type CreateAction = keyof CreateCommandActions;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(action: CreateAction, cause: unknown): CLIError {
  return new CLIError(
    `Unable to load create ${action} support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCreateCliError(action: CreateAction, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(failureMessage(cause), "OPERATION_FAILED", `selftune create ${action} --help`);
}

export const createExitCode = {
  init: () => 0,
  status: () => 0,
  scaffold: () => 0,
  check: (ok: boolean) => (ok ? 0 : 1),
  replay: (failed: number) => (failed === 0 ? 0 : 1),
  baseline: (addsValue: boolean) => (addsValue ? 0 : 1),
  report: (evaluationPassed: boolean) => (evaluationPassed ? 0 : 1),
  publish: (published: boolean) => (published ? 0 : 1),
};

export function writeCreateActionResult(
  action: CreateAction,
  output: CreateActionOutput,
  json: boolean,
  result: unknown,
  format: () => string,
  exitCode: number,
): Effect.Effect<void, CLIError> {
  return Effect.try({
    try: () => {
      output.print(json || !output.isStdoutTTY() ? JSON.stringify(result, null, 2) : format());
      output.setExitCode(exitCode);
    },
    catch: (cause) => toCreateCliError(action, cause),
  });
}

function parseMode(input: CreateEvaluationInput): Effect.Effect<"routing" | "package", CLIError> {
  return input.mode === "routing" || input.mode === "package"
    ? Effect.succeed(input.mode)
    : Effect.fail(
        new CLIError(
          `Unsupported --mode value "${input.mode}".`,
          "INVALID_FLAG",
          "Use --mode routing or --mode package.",
        ),
      );
}

export const makeLiveCreateCommandActions = (
  dependencies: CreateActionDependencies = LIVE_DEPENDENCIES,
): CreateCommandActions => ({
  init: Effect.fn("selftune.cli.create.init")(function* (input) {
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadInit,
      catch: (cause) => importFailure("init", cause),
    });
    const result = yield* Effect.try({
      try: () => runtimeModule.runCreateInit(input),
      catch: (cause) => toCreateCliError("init", cause),
    });
    yield* writeCreateActionResult(
      "init",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatInitResult(result),
      createExitCode.init(),
    );
  }),
  status: Effect.fn("selftune.cli.create.status")(function* (input) {
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadStatus,
      catch: (cause) => importFailure("status", cause),
    });
    const result = yield* Effect.tryPromise({
      try: () => runtimeModule.runCreateStatus(input.skillPath ?? ""),
      catch: (cause) => toCreateCliError("status", cause),
    });
    yield* writeCreateActionResult(
      "status",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatCreateCheckResult(result),
      createExitCode.status(),
    );
  }),
  scaffold: Effect.fn("selftune.cli.create.scaffold")(function* (input) {
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadScaffold,
      catch: (cause) => importFailure("scaffold", cause),
    });
    const result = yield* Effect.try({
      try: () => runtimeModule.runCreateScaffold(input),
      catch: (cause) => toCreateCliError("scaffold", cause),
    });
    yield* writeCreateActionResult(
      "scaffold",
      dependencies.output,
      input.json,
      runtimeModule.createScaffoldJsonResult(result),
      () => runtimeModule.formatCreateScaffoldResult(result),
      createExitCode.scaffold(),
    );
  }),
  check: Effect.fn("selftune.cli.create.check")(function* (input) {
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadCheck,
      catch: (cause) => importFailure("check", cause),
    });
    const result = yield* Effect.tryPromise({
      try: () => runtimeModule.runCreateCheck(input.skillPath ?? ""),
      catch: (cause) => toCreateCliError("check", cause),
    });
    yield* writeCreateActionResult(
      "check",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatCreateCheckResult(result),
      createExitCode.check(result.ok),
    );
  }),
  replay: Effect.fn("selftune.cli.create.replay")(function* (input) {
    const mode = yield* parseMode(input);
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadReplay,
      catch: (cause) => importFailure("replay", cause),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        runtimeModule.runCreateReplay({
          skillPath: input.skillPath ?? "",
          mode,
          agent: input.agent,
          evalSetPath: input.evalSetPath,
        }),
      catch: (cause) => toCreateCliError("replay", cause),
    });
    yield* writeCreateActionResult(
      "replay",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatReplayResult(result),
      createExitCode.replay(result.failed),
    );
  }),
  baseline: Effect.fn("selftune.cli.create.baseline")(function* (input) {
    const mode = yield* parseMode(input);
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadBaseline,
      catch: (cause) => importFailure("baseline", cause),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        runtimeModule.runCreateBaselineAndPersist({
          skillPath: input.skillPath ?? "",
          mode,
          agent: input.agent,
          evalSetPath: input.evalSetPath,
        }),
      catch: (cause) => toCreateCliError("baseline", cause),
    });
    yield* writeCreateActionResult(
      "baseline",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatBaselineResult(result),
      createExitCode.baseline(result.adds_value),
    );
  }),
  report: Effect.fn("selftune.cli.create.report")(function* (input) {
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadReport,
      catch: (cause) => importFailure("report", cause),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        runtimeModule.runCreateReport({
          skillPath: input.skillPath ?? "",
          agent: input.agent,
          evalSetPath: input.evalSetPath,
        }),
      catch: (cause) => toCreateCliError("report", cause),
    });
    yield* writeCreateActionResult(
      "report",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatCreatePackageBenchmarkReport(result),
      createExitCode.report(result.summary.evaluation_passed),
    );
  }),
  publish: Effect.fn("selftune.cli.create.publish")(function* (input: CreatePublishInput) {
    const runtimeModule = yield* Effect.tryPromise({
      try: dependencies.loadPublish,
      catch: (cause) => importFailure("publish", cause),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        runtimeModule.runCreatePublish({
          skillPath: input.skillPath ?? "",
          watch: input.watch,
          ignoreWatchAlerts: input.ignoreWatchAlerts,
        }),
      catch: (cause) => toCreateCliError("publish", cause),
    });
    yield* writeCreateActionResult(
      "publish",
      dependencies.output,
      input.json,
      result,
      () => runtimeModule.formatCreatePublishResult(result),
      createExitCode.publish(result.published),
    );
  }),
});

export const liveCreateCommandActions = makeLiveCreateCommandActions();
