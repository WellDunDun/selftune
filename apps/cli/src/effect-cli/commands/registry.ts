import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { RegistryClient } from "@selftune/runtime/registry/client";
import type { RegistryPlatform } from "@selftune/runtime/registry/platform";
import type {
  RegistryProgramInput,
  RegistryProgramResult,
} from "@selftune/runtime/registry/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  decodeRegistryInternalValue,
  REGISTRY_HELP,
  REGISTRY_INTERNAL_PARENT_HELP_FLAG,
  REGISTRY_INTERNAL_VERSION_FLAG,
} from "../compatibility/registry.js";

type RegistryActionRequirements = FileSystem.FileSystem | HttpClient.HttpClient;

export type RegistryAction = (
  input: RegistryProgramInput,
) => Effect.Effect<void, CLIError, RegistryActionRequirements>;

interface RegistryProgramModule {
  readonly isRegistryInternalFailure: (cause: unknown) => boolean;
  readonly runRegistryProgram: (
    input: RegistryProgramInput,
  ) => Effect.Effect<RegistryProgramResult, unknown, RegistryClient | RegistryPlatform>;
  readonly registryLiveLayer: Layer.Layer<
    RegistryClient | RegistryPlatform,
    unknown,
    RegistryActionRequirements
  >;
}

export interface RegistryActionDependencies {
  readonly loadModule: () => Promise<RegistryProgramModule>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
  readonly setExitCode: (exitCode: 0 | 1) => void;
}

const LIVE_DEPENDENCIES: RegistryActionDependencies = {
  loadModule: () => import("@selftune/runtime/registry/programs"),
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
    `Unable to load registry support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(
  operation: RegistryProgramInput["operation"],
  cause: unknown,
  isInternalFailure: (cause: unknown) => boolean = () => false,
): CLIError {
  if (isInternalFailure(cause)) {
    return new CLIError(failureMessage(cause), "INTERNAL_ERROR");
  }
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Registry ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune registry --help",
      );
}

export function runRegistryActionWithDependencies(
  input: RegistryProgramInput,
  dependencies: RegistryActionDependencies,
) {
  return Effect.fn(`selftune.cli.registry.${input.operation}`)(function* () {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const program = yield* Effect.try({
      try: () => runtime.runRegistryProgram(input),
      catch: (cause) => toCliError(input.operation, cause, runtime.isRegistryInternalFailure),
    });
    const result = yield* program.pipe(
      Effect.provide(runtime.registryLiveLayer),
      Effect.mapError((cause) =>
        toCliError(input.operation, cause, runtime.isRegistryInternalFailure),
      ),
    );
    yield* Effect.try({
      try: () => {
        for (const message of result.stdout) dependencies.writeStdout(message);
        for (const message of result.stderr) dependencies.writeStderr(message);
        dependencies.setExitCode(result.exitCode);
      },
      catch: (cause) => toCliError(input.operation, cause),
    });
  })();
}

export function makeLiveRegistryAction(
  dependencies: RegistryActionDependencies = LIVE_DEPENDENCIES,
): RegistryAction {
  return (input) => runRegistryActionWithDependencies(input, dependencies);
}

const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);

function decode(value: Option.Option<string>): string | undefined {
  return decodeRegistryInternalValue(Option.getOrUndefined(value));
}

export function makeRegistryCommand(action: RegistryAction = makeLiveRegistryAction()) {
  const push = Command.make(
    "push",
    {
      name: optionalString("name"),
      version: optionalString(REGISTRY_INTERNAL_VERSION_FLAG),
      summary: optionalString("summary"),
    },
    (input) =>
      action({
        operation: "push",
        name: decode(input.name),
        version: decode(input.version),
        summary: decode(input.summary),
      }),
  ).pipe(Command.withDescription("Push the current skill folder as a new version"));

  const install = Command.make(
    "install",
    { target: optionalString("target"), global: Flag.boolean("global") },
    (input) => action({ operation: "install", target: decode(input.target), global: input.global }),
  ).pipe(Command.withDescription("Install a skill from the registry or GitHub"));

  const sync = Command.make("sync", {}, () => action({ operation: "sync" })).pipe(
    Command.withDescription("Pull the latest versions of installed skills"),
  );
  const status = Command.make("status", {}, () => action({ operation: "status" })).pipe(
    Command.withDescription("Show installed skills and version drift"),
  );
  const rollback = Command.make(
    "rollback",
    {
      name: optionalString("name"),
      targetVersion: optionalString("to"),
      reason: optionalString("reason"),
    },
    (input) =>
      action({
        operation: "rollback",
        name: decode(input.name),
        targetVersion: decode(input.targetVersion),
        reason: decode(input.reason),
      }),
  ).pipe(Command.withDescription("Roll back a skill to a previous version"));
  const history = Command.make("history", { name: optionalString("name") }, (input) =>
    action({ operation: "history", name: decode(input.name) }),
  ).pipe(Command.withDescription("Show the version timeline for a skill"));
  const list = Command.make("list", {}, () => action({ operation: "list" })).pipe(
    Command.withDescription("Show all published entries in the organization"),
  );

  return Command.make(
    "registry",
    { internalHelp: Flag.boolean(REGISTRY_INTERNAL_PARENT_HELP_FLAG) },
    () => Console.log(REGISTRY_HELP),
  ).pipe(
    Command.withSubcommands([push, install, sync, status, rollback, history, list]),
    Command.withDescription("Distribute team skills"),
  );
}
