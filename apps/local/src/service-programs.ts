import { resolve } from "node:path";

import * as Effect from "effect/Effect";

import { getSelftuneVersion } from "@selftune/runtime/utils/selftune-meta";

import {
  ServiceFailure,
  ServiceManagerLive,
  runServiceCommand,
  serviceFailure,
  type ServiceCommandResponse,
  type ServiceDescriptor,
} from "./service.js";
import { resolveLocalConfigDir } from "./local-runtime.js";
import {
  DEFAULT_SERVICE_PORT,
  type ServiceAction,
  type ServiceInput,
  type ServiceRuntimeOwner,
} from "./service-cli-contract.js";

export interface ServiceProgramDependencies {
  readonly describe: (input: ServiceInput) => Effect.Effect<ServiceDescriptor, ServiceFailure>;
  readonly print: (message: string) => void;
  readonly run: (
    action: ServiceAction,
    descriptor: ServiceDescriptor,
  ) => Effect.Effect<ServiceCommandResponse, ServiceFailure>;
}

function argumentValue(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SERVICE_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw serviceFailure("parse", `Invalid service port: ${value}`);
  }
  return parsed;
}

function parseRuntimeOwner(value: string | undefined): ServiceRuntimeOwner | undefined {
  if (value === undefined) return undefined;
  if (value === "desktop" || value === "cli") return value;
  throw serviceFailure("parse", `Invalid service owner: ${value}`);
}

function isCompiledBunEntrypoint(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/$bunfs/") || /^[a-z]:\/~BUN\//i.test(normalized);
}

function resolveCliInvocation(explicitExecutable: string | undefined) {
  if (explicitExecutable) {
    return { executablePath: resolve(explicitExecutable), executableArgsPrefix: [] };
  }
  const configured = process.env.SELFTUNE_BIN_PATH?.trim();
  if (configured) return { executablePath: resolve(configured), executableArgsPrefix: [] };
  if (isCompiledBunEntrypoint(process.argv[1])) {
    return { executablePath: process.execPath, executableArgsPrefix: [] };
  }
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw serviceFailure("install", "Cannot resolve the SelfTune CLI entrypoint.");
  }
  return { executablePath: process.execPath, executableArgsPrefix: [resolve(scriptPath)] };
}

function installedVersion(): string {
  return process.env.SELFTUNE_VERSION || getSelftuneVersion("unknown");
}

export const resolveServiceDescriptor = Effect.fn("SelfTuneService.resolveDescriptor")(function* (
  input: ServiceInput,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* Effect.try({
    try: (): ServiceDescriptor => {
      if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65_535) {
        throw serviceFailure("parse", `Invalid service port: ${input.port}`);
      }
      if (input.owner !== undefined && input.owner !== "desktop" && input.owner !== "cli") {
        throw serviceFailure("parse", `Invalid service owner: ${input.owner}`);
      }
      const invocation = resolveCliInvocation(input.executable);
      const packagedResourceDir = environment.SELFTUNE_DESKTOP_RESOURCE_DIR?.trim();
      const resourceDir = input.resourceDir ?? (packagedResourceDir || undefined);
      const descriptor = {
        ...invocation,
        boot: input.boot,
        configDir: input.configDir ?? resolveLocalConfigDir(),
        owner: input.owner ?? (process.env.SELFTUNE_DESKTOP === "1" ? "desktop" : "cli"),
        port: input.port,
        version: input.version ?? installedVersion(),
      } satisfies ServiceDescriptor;
      return resourceDir ? { ...descriptor, resourceDir: resolve(resourceDir) } : descriptor;
    },
    catch: (cause) =>
      cause instanceof ServiceFailure ? cause : serviceFailure("resolve-descriptor", cause),
  });
});

export function serviceInputFromArguments(args: ReadonlyArray<string>): ServiceInput {
  return {
    boot: args.includes("--boot"),
    configDir: argumentValue(args, "--config-dir"),
    executable: argumentValue(args, "--executable"),
    json: args.includes("--json"),
    owner: parseRuntimeOwner(argumentValue(args, "--owner")),
    port: parsePort(argumentValue(args, "--port")),
    resourceDir: argumentValue(args, "--resource-dir"),
    version: argumentValue(args, "--version"),
  };
}

const LIVE_SERVICE_PROGRAM_DEPENDENCIES: ServiceProgramDependencies = {
  describe: resolveServiceDescriptor,
  print: (message) => process.stdout.write(`${message}\n`),
  run: (action, descriptor) =>
    runServiceCommand(action, descriptor).pipe(Effect.provide(ServiceManagerLive)),
};

function printResponse(
  response: ServiceCommandResponse,
  json: boolean,
  print: (message: string) => void,
): void {
  if (json) {
    print(JSON.stringify(response));
    return;
  }
  print(`SelfTune service ${response.action} completed on ${response.status.platform}.`);
  print(`Registered: ${response.status.registered ? "yes" : "no"}`);
  print(
    `Running: ${response.status.running ? "yes" : "no"}${response.status.pid ? ` (pid ${response.status.pid})` : ""}`,
  );
  for (const line of response.status.detail) print(line);
}

export const runServiceProgram = Effect.fn("SelfTuneService.program")(function* (
  action: ServiceAction,
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  const descriptor = yield* dependencies.describe(input);
  const response = yield* dependencies.run(action, descriptor);
  yield* Effect.sync(() => printResponse(response, input.json, dependencies.print));
  return response;
});

export const runServiceInstallProgram = Effect.fn("SelfTuneService.installProgram")(function* (
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  return yield* runServiceProgram("install", input, dependencies);
});

export const runServiceUninstallProgram = Effect.fn("SelfTuneService.uninstallProgram")(function* (
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  return yield* runServiceProgram("uninstall", input, dependencies);
});

export const runServiceStartProgram = Effect.fn("SelfTuneService.startProgram")(function* (
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  return yield* runServiceProgram("start", input, dependencies);
});

export const runServiceStopProgram = Effect.fn("SelfTuneService.stopProgram")(function* (
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  return yield* runServiceProgram("stop", input, dependencies);
});

export const runServiceRestartProgram = Effect.fn("SelfTuneService.restartProgram")(function* (
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  return yield* runServiceProgram("restart", input, dependencies);
});

export const runServiceStatusProgram = Effect.fn("SelfTuneService.statusProgram")(function* (
  input: ServiceInput,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  return yield* runServiceProgram("status", input, dependencies);
});

export function serviceHelp(): string {
  return `selftune service - Manage the supervised SelfTune daemon

Usage:
  selftune service install [options]
  selftune service status [--json]
  selftune service start [--json]
  selftune service stop [--json]
  selftune service restart [--json]
  selftune service uninstall [--json]

Options:
  --port <port>          Service port (default: ${DEFAULT_SERVICE_PORT})
  --config-dir <path>   SelfTune state directory
  --owner <owner>       Service owner: desktop or cli
  --boot                Windows only: start before login (requires elevation)
  --json                Emit a machine-readable response`;
}

export const serviceCliProgram = Effect.fn("SelfTuneService.cli")(function* (
  args: ReadonlyArray<string>,
  dependencies: ServiceProgramDependencies = LIVE_SERVICE_PROGRAM_DEPENDENCIES,
) {
  const action = args[0];
  if (!action || action === "--help" || action === "-h") {
    yield* Effect.sync(() => dependencies.print(serviceHelp()));
    return;
  }
  if (
    action !== "install" &&
    action !== "uninstall" &&
    action !== "status" &&
    action !== "start" &&
    action !== "stop" &&
    action !== "restart"
  ) {
    return yield* serviceFailure("parse", `Unknown service command: ${action}`);
  }
  const input = yield* Effect.try({
    try: () => serviceInputFromArguments(args.slice(1)),
    catch: (cause) => (cause instanceof ServiceFailure ? cause : serviceFailure("parse", cause)),
  });
  switch (action) {
    case "install":
      return yield* runServiceInstallProgram(input, dependencies);
    case "uninstall":
      return yield* runServiceUninstallProgram(input, dependencies);
    case "start":
      return yield* runServiceStartProgram(input, dependencies);
    case "stop":
      return yield* runServiceStopProgram(input, dependencies);
    case "restart":
      return yield* runServiceRestartProgram(input, dependencies);
    case "status":
      return yield* runServiceStatusProgram(input, dependencies);
  }
});
