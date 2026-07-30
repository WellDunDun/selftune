import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  DEFAULT_SERVICE_PORT,
  type ServiceAction,
  type ServiceInput,
} from "@selftune/local/service-cli-contract";
import type {
  ServiceMaintenanceAction,
  ServiceMaintenanceInput,
} from "@selftune/local/service/maintenance/contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export interface ServiceCommandActions {
  readonly install: (input: ServiceInput) => Effect.Effect<void, CLIError>;
  readonly maintenance: (
    action: ServiceMaintenanceAction,
    input: ServiceMaintenanceInput,
  ) => Effect.Effect<void, CLIError>;
  readonly status: (input: ServiceInput) => Effect.Effect<void, CLIError>;
  readonly start: (input: ServiceInput) => Effect.Effect<void, CLIError>;
  readonly stop: (input: ServiceInput) => Effect.Effect<void, CLIError>;
  readonly restart: (input: ServiceInput) => Effect.Effect<void, CLIError>;
  readonly uninstall: (input: ServiceInput) => Effect.Effect<void, CLIError>;
}

interface ServiceLifecycleProgramModule {
  readonly runServiceInstallProgram: (input: ServiceInput) => Effect.Effect<unknown, unknown>;
  readonly runServiceStatusProgram: (input: ServiceInput) => Effect.Effect<unknown, unknown>;
  readonly runServiceStartProgram: (input: ServiceInput) => Effect.Effect<unknown, unknown>;
  readonly runServiceStopProgram: (input: ServiceInput) => Effect.Effect<unknown, unknown>;
  readonly runServiceRestartProgram: (input: ServiceInput) => Effect.Effect<unknown, unknown>;
  readonly runServiceUninstallProgram: (input: ServiceInput) => Effect.Effect<unknown, unknown>;
}

interface ServiceMaintenanceProgramModule {
  readonly runServiceDoctorProgram: (
    input: ServiceMaintenanceInput,
  ) => Effect.Effect<unknown, unknown>;
  readonly runServiceRepairLockProgram: (
    input: ServiceMaintenanceInput,
  ) => Effect.Effect<unknown, unknown>;
}

export interface ServiceActionDependencies {
  readonly loadLifecycleModule: () => Promise<ServiceLifecycleProgramModule>;
  readonly loadMaintenanceModule: () => Promise<ServiceMaintenanceProgramModule>;
}

const LIVE_SERVICE_DEPENDENCIES: ServiceActionDependencies = {
  loadLifecycleModule: () => import("@selftune/local/service-programs"),
  loadMaintenanceModule: () => import("@selftune/local/service/maintenance/programs"),
};

interface ServiceFailureShape {
  readonly operation: string;
  readonly message: string;
}

function isServiceFailure(cause: unknown): cause is ServiceFailureShape {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "operation" in cause &&
    typeof cause.operation === "string" &&
    "message" in cause &&
    typeof cause.message === "string"
  );
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function serviceImportFailure(
  action: ServiceAction | ServiceMaintenanceAction,
  cause: unknown,
): CLIError {
  return new CLIError(
    `Unable to load service ${action} support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toServiceCliError(cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  const operation = isServiceFailure(cause) ? cause.operation : undefined;
  const message = isServiceFailure(cause) ? cause.message : failureMessage(cause);
  return new CLIError(
    message,
    operation === "parse" ? "INVALID_FLAG" : "OPERATION_FAILED",
    operation === "parse" ? "selftune service --help" : "selftune service status --json",
  );
}

function lifecycleProgram(
  service: ServiceLifecycleProgramModule,
  action: ServiceAction,
  input: ServiceInput,
): Effect.Effect<unknown, CLIError> {
  return Effect.try({
    try: () => {
      switch (action) {
        case "install":
          return service.runServiceInstallProgram(input);
        case "status":
          return service.runServiceStatusProgram(input);
        case "start":
          return service.runServiceStartProgram(input);
        case "stop":
          return service.runServiceStopProgram(input);
        case "restart":
          return service.runServiceRestartProgram(input);
        case "uninstall":
          return service.runServiceUninstallProgram(input);
      }
    },
    catch: toServiceCliError,
  }).pipe(Effect.flatMap((program) => program.pipe(Effect.mapError(toServiceCliError))));
}

export const runServiceLifecycleActionWithDependencies = Effect.fn(
  "selftune.cli.service.lifecycle",
)(function* (action: ServiceAction, input: ServiceInput, dependencies: ServiceActionDependencies) {
  const service = yield* Effect.tryPromise({
    try: dependencies.loadLifecycleModule,
    catch: (cause) => serviceImportFailure(action, cause),
  });
  yield* lifecycleProgram(service, action, input);
});

export const runServiceMaintenanceActionWithDependencies = Effect.fn(
  "selftune.cli.service.maintenance",
)(function* (
  action: ServiceMaintenanceAction,
  input: ServiceMaintenanceInput,
  dependencies: ServiceActionDependencies,
) {
  const service = yield* Effect.tryPromise({
    try: dependencies.loadMaintenanceModule,
    catch: (cause) => serviceImportFailure(action, cause),
  });
  const program = yield* Effect.try({
    try: () =>
      action === "doctor"
        ? service.runServiceDoctorProgram(input)
        : service.runServiceRepairLockProgram(input),
    catch: toServiceCliError,
  });
  yield* program.pipe(Effect.mapError(toServiceCliError));
});

export const liveServiceCommandActions: ServiceCommandActions = {
  install: (input) =>
    runServiceLifecycleActionWithDependencies("install", input, LIVE_SERVICE_DEPENDENCIES),
  maintenance: (action, input) =>
    runServiceMaintenanceActionWithDependencies(action, input, LIVE_SERVICE_DEPENDENCIES),
  status: (input) =>
    runServiceLifecycleActionWithDependencies("status", input, LIVE_SERVICE_DEPENDENCIES),
  start: (input) =>
    runServiceLifecycleActionWithDependencies("start", input, LIVE_SERVICE_DEPENDENCIES),
  stop: (input) =>
    runServiceLifecycleActionWithDependencies("stop", input, LIVE_SERVICE_DEPENDENCIES),
  restart: (input) =>
    runServiceLifecycleActionWithDependencies("restart", input, LIVE_SERVICE_DEPENDENCIES),
  uninstall: (input) =>
    runServiceLifecycleActionWithDependencies("uninstall", input, LIVE_SERVICE_DEPENDENCIES),
};

function makeServiceFlags() {
  return {
    _noOperands: Argument.none.pipe(Argument.optional, Argument.withMetavar("")),
    port: Flag.integer("port").pipe(
      Flag.filter(
        (port) => port >= 1 && port <= 65_535,
        (port) => `Invalid service port: ${port}`,
      ),
      Flag.withDefault(DEFAULT_SERVICE_PORT),
    ),
    configDir: Flag.string("config-dir").pipe(Flag.optional),
    owner: Flag.choice("owner", ["desktop", "cli"]).pipe(Flag.optional),
    boot: Flag.boolean("boot").pipe(
      Flag.withDescription("Windows only: start before login (requires elevation)"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Emit a machine-readable response")),
    executable: Flag.string("executable").pipe(
      Flag.withDescription("SelfTune executable registered with the OS supervisor"),
      Flag.optional,
    ),
    resourceDir: Flag.string("resource-dir").pipe(
      Flag.withDescription("Packaged SelfTune resource directory"),
      Flag.optional,
    ),
    serviceVersion: Flag.string("service-version").pipe(
      Flag.withDescription("Version recorded for the supervised SelfTune runtime"),
      Flag.optional,
    ),
  };
}

function makeMaintenanceFlags() {
  return {
    _noOperands: Argument.none.pipe(Argument.optional, Argument.withMetavar("")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Emit a machine-readable response")),
  };
}

interface ParsedServiceFlags {
  readonly boot: boolean;
  readonly configDir: Option.Option<string>;
  readonly executable: Option.Option<string>;
  readonly json: boolean;
  readonly owner: Option.Option<"desktop" | "cli">;
  readonly port: number;
  readonly resourceDir: Option.Option<string>;
  readonly serviceVersion: Option.Option<string>;
}

function toServiceInput(input: ParsedServiceFlags): ServiceInput {
  return {
    boot: input.boot,
    configDir: Option.getOrUndefined(input.configDir),
    executable: Option.getOrUndefined(input.executable),
    json: input.json,
    owner: Option.getOrUndefined(input.owner),
    port: input.port,
    resourceDir: Option.getOrUndefined(input.resourceDir),
    version: Option.getOrUndefined(input.serviceVersion),
  };
}

export function makeServiceCommand(actions: ServiceCommandActions = liveServiceCommandActions) {
  const doctor = Command.make("doctor", makeMaintenanceFlags(), (input) =>
    actions.maintenance("doctor", { json: input.json } satisfies ServiceMaintenanceInput),
  ).pipe(Command.withDescription("Diagnose the current-user Windows service lock"));
  const install = Command.make("install", makeServiceFlags(), (input) =>
    actions.install(toServiceInput(input)),
  ).pipe(Command.withDescription("Install or repair the supervised SelfTune service"));
  const status = Command.make("status", makeServiceFlags(), (input) =>
    actions.status(toServiceInput(input)),
  ).pipe(Command.withDescription("Show service registration and runtime status"));
  const start = Command.make("start", makeServiceFlags(), (input) =>
    actions.start(toServiceInput(input)),
  ).pipe(Command.withDescription("Start the registered SelfTune service"));
  const stop = Command.make("stop", makeServiceFlags(), (input) =>
    actions.stop(toServiceInput(input)),
  ).pipe(Command.withDescription("Stop the registered SelfTune service"));
  const restart = Command.make("restart", makeServiceFlags(), (input) =>
    actions.restart(toServiceInput(input)),
  ).pipe(Command.withDescription("Restart the registered SelfTune service"));
  const repairLock = Command.make("repair-lock", makeMaintenanceFlags(), (input) =>
    actions.maintenance("repair-lock", {
      json: input.json,
    } satisfies ServiceMaintenanceInput),
  ).pipe(Command.withDescription("Repair a proven stale legacy Windows service lock"));
  const uninstall = Command.make("uninstall", makeServiceFlags(), (input) =>
    actions.uninstall(toServiceInput(input)),
  ).pipe(Command.withDescription("Remove the supervised SelfTune service definition"));

  return Command.make("service").pipe(
    Command.withSubcommands([doctor, install, repairLock, status, start, stop, restart, uninstall]),
    Command.withDescription("Manage the supervised SelfTune daemon"),
  );
}
