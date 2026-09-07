import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  DEFAULT_DAEMON_PORT,
  isServiceInstallationNonce,
} from "@selftune/local/daemon-cli-contract";
import type {
  DaemonRotateTokenInput,
  DaemonRunInput,
  DaemonStatusInput,
  DaemonStopInput,
} from "@selftune/local/daemon-cli-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import { OperationFailure } from "../operation-failure.js";

export interface DaemonCommandActions {
  readonly run: (input: DaemonRunInput) => Effect.Effect<void, CLIError>;
  readonly status: (input: DaemonStatusInput) => Effect.Effect<void, CLIError>;
  readonly stop: (input: DaemonStopInput) => Effect.Effect<void, CLIError>;
  readonly rotateToken: (input: DaemonRotateTokenInput) => Effect.Effect<void, CLIError>;
}

interface DaemonProgramModule {
  readonly runDaemonProgram: (input: DaemonRunInput) => Effect.Effect<unknown, unknown>;
  readonly runDaemonStatusProgram: (input: DaemonStatusInput) => Effect.Effect<unknown, unknown>;
  readonly runDaemonStopProgram: (input: DaemonStopInput) => Effect.Effect<unknown, unknown>;
  readonly runDaemonRotateTokenProgram: (
    input: DaemonRotateTokenInput,
  ) => Effect.Effect<unknown, unknown>;
}

export interface DaemonActionDependencies {
  readonly loadModule: () => Promise<DaemonProgramModule>;
}

const LIVE_DAEMON_DEPENDENCIES: DaemonActionDependencies = {
  loadModule: () => import("@selftune/local/daemon"),
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function daemonImportFailure(
  action: "run" | "status" | "stop" | "rotate-token",
  cause: unknown,
): CLIError {
  return new CLIError(
    `Unable to load daemon ${action} support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toDaemonCliError(cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  const failure = Option.getOrNull(Schema.decodeUnknownOption(OperationFailure)(cause));
  const operation = failure?.operation;
  const message = failure?.message ?? failureMessage(cause);
  return new CLIError(
    message,
    operation === "parse" ? "INVALID_FLAG" : "OPERATION_FAILED",
    "selftune daemon --help",
  );
}

export const runDaemonActionWithDependencies = Effect.fn("selftune.cli.daemon.run")(function* (
  input: DaemonRunInput,
  dependencies: DaemonActionDependencies,
) {
  const daemon = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: (cause) => daemonImportFailure("run", cause),
  });
  yield* daemon.runDaemonProgram(input).pipe(Effect.mapError(toDaemonCliError));
});

export const runDaemonStatusActionWithDependencies = Effect.fn("selftune.cli.daemon.status")(
  function* (input: DaemonStatusInput, dependencies: DaemonActionDependencies) {
    const daemon = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: (cause) => daemonImportFailure("status", cause),
    });
    yield* daemon.runDaemonStatusProgram(input).pipe(Effect.mapError(toDaemonCliError));
  },
);

export const runDaemonStopActionWithDependencies = Effect.fn("selftune.cli.daemon.stop")(function* (
  input: DaemonStopInput,
  dependencies: DaemonActionDependencies,
) {
  const daemon = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: (cause) => daemonImportFailure("stop", cause),
  });
  yield* daemon.runDaemonStopProgram(input).pipe(Effect.mapError(toDaemonCliError));
});

export const runDaemonRotateTokenActionWithDependencies = Effect.fn(
  "selftune.cli.daemon.rotateToken",
)(function* (input: DaemonRotateTokenInput, dependencies: DaemonActionDependencies) {
  const daemon = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: (cause) => daemonImportFailure("rotate-token", cause),
  });
  yield* daemon.runDaemonRotateTokenProgram(input).pipe(Effect.mapError(toDaemonCliError));
});

export const liveDaemonCommandActions: DaemonCommandActions = {
  run: (input) => runDaemonActionWithDependencies(input, LIVE_DAEMON_DEPENDENCIES),
  status: (input) => runDaemonStatusActionWithDependencies(input, LIVE_DAEMON_DEPENDENCIES),
  stop: (input) => runDaemonStopActionWithDependencies(input, LIVE_DAEMON_DEPENDENCIES),
  rotateToken: (input) =>
    runDaemonRotateTokenActionWithDependencies(input, LIVE_DAEMON_DEPENDENCIES),
};

const noOperands = () => Argument.none.pipe(Argument.optional, Argument.withMetavar(""));

export function makeDaemonCommand(actions: DaemonCommandActions = liveDaemonCommandActions) {
  const run = Command.make(
    "run",
    {
      _noOperands: noOperands(),
      port: Flag.integer("port").pipe(
        Flag.filter(
          (port) => port >= 0 && port <= 65_535,
          (port) => `Invalid daemon port: ${port}`,
        ),
        Flag.withDefault(DEFAULT_DAEMON_PORT),
      ),
      hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
      configDir: Flag.string("config-dir").pipe(Flag.optional),
      spaDir: Flag.string("spa-dir").pipe(Flag.optional),
      owner: Flag.choice("owner", ["desktop", "cli"]).pipe(Flag.optional),
      runtimeMode: Flag.choice("runtime-mode", ["standalone", "dev-server", "test"]).pipe(
        Flag.optional,
      ),
      serviceInstallationNonce: Flag.string("service-installation-nonce").pipe(
        Flag.filter(isServiceInstallationNonce, () => "Expected 32-128 base64url characters"),
        Flag.optional,
      ),
      foreground: Flag.boolean("foreground").pipe(
        Flag.withDescription("Compatibility no-op; daemon run is always foreground"),
      ),
      supervised: Flag.boolean("supervised"),
      readySentinel: Flag.boolean("ready-sentinel"),
    },
    (input) => {
      const serviceInstallationNonce = Option.getOrUndefined(input.serviceInstallationNonce);
      if (serviceInstallationNonce !== undefined && !input.supervised) {
        return Effect.fail(
          new CLIError(
            "--service-installation-nonce requires --supervised.",
            "INVALID_FLAG",
            "selftune daemon run --help",
          ),
        );
      }
      return actions.run({
        configDir: Option.getOrUndefined(input.configDir),
        foreground: input.foreground,
        hostname: input.hostname,
        owner: Option.getOrUndefined(input.owner),
        port: input.port,
        readySentinel: input.readySentinel,
        runtimeMode: Option.getOrUndefined(input.runtimeMode),
        serviceInstallationNonce,
        spaDir: Option.getOrUndefined(input.spaDir),
        supervised: input.supervised,
      });
    },
  ).pipe(Command.withDescription("Run the local daemon in the foreground"));

  const status = Command.make(
    "status",
    {
      _noOperands: noOperands(),
      configDir: Flag.string("config-dir").pipe(Flag.optional),
      json: Flag.boolean("json"),
    },
    (input) =>
      actions.status({
        configDir: Option.getOrUndefined(input.configDir),
        json: input.json,
      }),
  ).pipe(Command.withDescription("Show daemon status"));

  const stop = Command.make(
    "stop",
    {
      _noOperands: noOperands(),
      configDir: Flag.string("config-dir").pipe(Flag.optional),
      expectedPid: Flag.integer("expected-pid").pipe(
        Flag.filter(
          (pid) => Number.isSafeInteger(pid) && pid > 1,
          (pid) => `Invalid expected daemon pid: ${pid}`,
        ),
        Flag.optional,
      ),
      expectedInstanceId: Flag.string("expected-instance-id").pipe(Flag.optional),
    },
    (input) => {
      const expectedPid = Option.getOrUndefined(input.expectedPid);
      const expectedInstanceId = Option.getOrUndefined(input.expectedInstanceId);
      if ((expectedPid === undefined) !== (expectedInstanceId === undefined)) {
        return Effect.fail(
          new CLIError(
            "--expected-pid and --expected-instance-id must be provided together.",
            "INVALID_FLAG",
            "selftune daemon stop --help",
          ),
        );
      }
      if (expectedInstanceId !== undefined && expectedInstanceId.length === 0) {
        return Effect.fail(
          new CLIError(
            "Expected daemon instance id cannot be empty.",
            "INVALID_FLAG",
            "selftune daemon stop --help",
          ),
        );
      }
      return actions.stop({
        configDir: Option.getOrUndefined(input.configDir),
        expectedInstanceId,
        expectedPid,
      });
    },
  ).pipe(Command.withDescription("Stop the authenticated local daemon"));

  const rotateToken = Command.make(
    "rotate-token",
    {
      _noOperands: noOperands(),
      configDir: Flag.string("config-dir").pipe(Flag.optional),
    },
    (input) => actions.rotateToken({ configDir: Option.getOrUndefined(input.configDir) }),
  ).pipe(Command.withDescription("Rotate local daemon authentication"));

  return Command.make("daemon").pipe(
    Command.withSubcommands([run, status, stop, rotateToken]),
    Command.withDescription("Run and inspect the local SelfTune daemon"),
  );
}
