import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import type {
  SyncProgramInput,
  SyncProgramResult,
  SyncProgramRuntime,
  SyncProgress,
  SyncRuntime,
} from "@selftune/orchestration/sync/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  decodeSyncInternalValue,
  SYNC_HELP,
  SYNC_INTERNAL_HELP_FLAG,
} from "../compatibility/sync.js";

export type SyncCommandInput = Omit<SyncProgramInput, "jsonOutput">;

export type SyncAction = (
  input: SyncCommandInput,
  jsonRequested: boolean,
) => Effect.Effect<void, CLIError>;

export interface SyncProgramModule {
  readonly isSyncInternalFailure: (cause: unknown) => boolean;
  readonly makeSyncProgressLayer: (report: (message: string) => void) => Layer.Layer<SyncProgress>;
  readonly runSyncProgram: (
    input: SyncProgramInput,
  ) => Effect.Effect<SyncProgramResult, unknown, SyncProgramRuntime>;
  readonly syncLiveLayer: Layer.Layer<SyncRuntime, unknown>;
}

export interface SyncActionDependencies {
  readonly loadModule: () => Promise<SyncProgramModule>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
  readonly isTTY: () => boolean;
  readonly setExitCode: (exitCode: 0 | 1) => void;
}

const LIVE_DEPENDENCIES: SyncActionDependencies = {
  loadModule: () => import("@selftune/orchestration/sync/programs"),
  writeStdout: (message) => process.stdout.write(`${message}\n`),
  writeStderr: (message) => process.stderr.write(`${message}\n`),
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
    `Unable to load sync support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(
  cause: unknown,
  isInternalFailure: (cause: unknown) => boolean = () => false,
): CLIError {
  if (isInternalFailure(cause)) {
    return new CLIError(failureMessage(cause), "INTERNAL_ERROR");
  }
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Sync failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune sync --help",
      );
}

export const runSyncActionWithDependencies = Effect.fn("selftune.cli.sync")(function* (
  input: SyncCommandInput,
  jsonRequested: boolean,
  dependencies: SyncActionDependencies,
) {
  const jsonOutput = yield* Effect.try({
    try: () => jsonRequested || !dependencies.isTTY(),
    catch: toCliError,
  });
  const runtime = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: importFailure,
  });
  const program = yield* Effect.try({
    try: () => runtime.runSyncProgram({ ...input, jsonOutput }),
    catch: (cause) => toCliError(cause, runtime.isSyncInternalFailure),
  });
  const progressLayer = runtime.makeSyncProgressLayer(
    jsonOutput ? () => {} : dependencies.writeStderr,
  );
  const result = yield* program.pipe(
    Effect.provide(Layer.merge(runtime.syncLiveLayer, progressLayer)),
    Effect.mapError((cause) => toCliError(cause, runtime.isSyncInternalFailure)),
  );
  yield* Effect.try({
    try: () => {
      for (const message of result.stdout) dependencies.writeStdout(message);
      for (const message of result.stderr) dependencies.writeStderr(message);
      dependencies.setExitCode(result.exitCode);
    },
    catch: toCliError,
  });
});

export function makeLiveSyncAction(
  dependencies: SyncActionDependencies = LIVE_DEPENDENCIES,
): SyncAction {
  return (input, jsonRequested) =>
    runSyncActionWithDependencies(input, jsonRequested, dependencies);
}

const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);

function decode(value: Option.Option<string>): string | undefined {
  return decodeSyncInternalValue(Option.getOrUndefined(value));
}

function decodeSince(value: Option.Option<string>): {
  readonly since?: Date;
  readonly sinceArgument?: string;
} {
  const sinceArgument = decode(value);
  return sinceArgument ? { since: new Date(sinceArgument), sinceArgument } : {};
}

export function makeSyncCommand(action: SyncAction = makeLiveSyncAction()) {
  return Command.make(
    "sync",
    {
      projectsDir: optionalString("projects-dir"),
      codexHome: optionalString("codex-home"),
      opencodeDataDir: optionalString("opencode-data-dir"),
      openclawAgentsDir: optionalString("openclaw-agents-dir"),
      piSessionsDir: optionalString("pi-sessions-dir"),
      skillLogPath: optionalString("skill-log"),
      repairedSkillLogPath: optionalString("repaired-skill-log"),
      repairedSessionsPath: optionalString("repaired-sessions-marker"),
      since: optionalString("since"),
      dryRun: Flag.boolean("dry-run"),
      force: Flag.boolean("force"),
      skipClaude: Flag.boolean("no-claude"),
      skipCodex: Flag.boolean("no-codex"),
      skipOpenCode: Flag.boolean("no-opencode"),
      skipOpenClaw: Flag.boolean("no-openclaw"),
      skipPi: Flag.boolean("no-pi"),
      skipRepair: Flag.boolean("no-repair"),
      json: Flag.boolean("json"),
      internalHelp: Flag.boolean(SYNC_INTERNAL_HELP_FLAG),
    },
    (input) =>
      input.internalHelp
        ? Console.log(SYNC_HELP)
        : action(
            {
              projectsDir: decode(input.projectsDir),
              codexHome: decode(input.codexHome),
              opencodeDataDir: decode(input.opencodeDataDir),
              openclawAgentsDir: decode(input.openclawAgentsDir),
              piSessionsDir: decode(input.piSessionsDir),
              skillLogPath: decode(input.skillLogPath),
              repairedSkillLogPath: decode(input.repairedSkillLogPath),
              repairedSessionsPath: decode(input.repairedSessionsPath),
              ...decodeSince(input.since),
              dryRun: input.dryRun,
              force: input.force,
              skipClaude: input.skipClaude,
              skipCodex: input.skipCodex,
              skipOpenCode: input.skipOpenCode,
              skipOpenClaw: input.skipOpenClaw,
              skipPi: input.skipPi,
              skipRepair: input.skipRepair,
            },
            input.json,
          ),
  ).pipe(Command.withDescription("Sync source-truth telemetry across supported agents"));
}
