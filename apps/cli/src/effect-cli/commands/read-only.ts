import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export interface ReadOnlyCommandActions {
  readonly doctor: () => Effect.Effect<void, CLIError>;
  readonly status: () => Effect.Effect<void, CLIError>;
  readonly last: () => Effect.Effect<void, CLIError>;
}

type ReadOnlyCommandName = keyof ReadOnlyCommandActions;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(command: ReadOnlyCommandName, cause: unknown): CLIError {
  return new CLIError(
    `Unable to load ${command} support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function operationFailure(command: ReadOnlyCommandName, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `${command} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        `selftune ${command} --help`,
      );
}

export const runDoctor = Effect.fn("selftune.cli.doctor")(function* () {
  const { doctor } = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/observability"),
    catch: (cause) => importFailure("doctor", cause),
  });
  const result = yield* Effect.tryPromise({
    try: () => doctor(),
    catch: (cause) => operationFailure("doctor", cause),
  });
  yield* Effect.sync(() => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.healthy ? 0 : 1;
  });
});

export const runStatus = Effect.fn("selftune.cli.status")(function* () {
  const { runStatusProgram } = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/status"),
    catch: (cause) => importFailure("status", cause),
  });
  const exitCode = yield* Effect.tryPromise({
    try: () => runStatusProgram(),
    catch: (cause) => operationFailure("status", cause),
  });
  yield* Effect.sync(() => {
    process.exitCode = exitCode;
  });
});

export const runLast = Effect.fn("selftune.cli.last")(function* () {
  const { runLastProgram } = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/last"),
    catch: (cause) => importFailure("last", cause),
  });
  yield* Effect.try({
    try: () => runLastProgram(),
    catch: (cause) => operationFailure("last", cause),
  });
  yield* Effect.sync(() => {
    process.exitCode = 0;
  });
});

export const liveReadOnlyCommandActions: ReadOnlyCommandActions = {
  doctor: runDoctor,
  status: runStatus,
  last: runLast,
};

export function makeReadOnlyCommands(actions: ReadOnlyCommandActions = liveReadOnlyCommandActions) {
  const doctorCommand = Command.make("doctor", {}, actions.doctor).pipe(
    Command.withDescription("Run SelfTune health checks"),
  );
  const statusCommand = Command.make("status", {}, actions.status).pipe(
    Command.withDescription("Show skill health summary"),
  );
  const lastCommand = Command.make("last", {}, actions.last).pipe(
    Command.withDescription("Show last session details"),
  );

  return { doctorCommand, statusCommand, lastCommand };
}
