import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { findSelftunePackageRoot } from "@selftune/runtime/package-root";
import { reconcilePersistedDesktopSchedule } from "@selftune/runtime/desktop-settings";
import type {
  DaemonRotateTokenInput,
  DaemonRunInput,
  DaemonRuntimeMode,
  DaemonRuntimeOwner,
  DaemonStatusInput,
  DaemonStopInput,
} from "./daemon-cli-contract.js";
import { isServiceInstallationNonce } from "./daemon-cli-contract.js";
import { startDashboardServer } from "./dashboard-server.js";
import {
  acquireRuntimeLock,
  DEFAULT_DAEMON_PORT,
  isProcessAlive,
  loadOrCreateLocalAuthToken,
  readLocalAuthToken,
  readServerManifest,
  removeDaemonManifestIfOwned,
  resolveLocalConfigDir,
  type RuntimeOwner,
  type RuntimeSupervision,
  type ServerManifest,
  rotateLocalAuthToken,
  writeServerManifest,
} from "./local-runtime.js";

const PACKAGE_ROOT = findSelftunePackageRoot();

export interface DaemonRunOptions {
  readonly configDir: string;
  readonly hostname: string;
  readonly port: number;
  readonly readySentinel: boolean;
  readonly runtimeMode: DaemonRuntimeMode;
  readonly serviceInstallationNonce?: string;
  readonly owner: RuntimeOwner;
  readonly spaDir?: string;
  readonly supervision: RuntimeSupervision;
}

interface DaemonRuntimeIdentity {
  readonly configDir: string;
  readonly instanceId: string;
  readonly owner: RuntimeOwner;
  readonly ownerExecutablePath: string;
  readonly serviceInstallationNonce?: string;
  readonly supervision: RuntimeSupervision;
}

export interface DaemonStatus {
  readonly manifest: ReturnType<typeof readServerManifest>;
  readonly reachable: boolean;
}

export interface RuntimeStopExpectation {
  readonly instanceId: string;
  readonly pid: number;
}

export class DaemonFailure extends Schema.TaggedErrorClass<DaemonFailure>()("DaemonFailure", {
  operation: Schema.String,
  message: Schema.String,
}) {}

function daemonFailure(operation: string, cause: unknown): DaemonFailure {
  return DaemonFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function argumentValue(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw daemonFailure("parse", `Option '${name} <value>' argument missing.`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DAEMON_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw daemonFailure("parse", `Invalid daemon port: ${value}`);
  }
  return port;
}

function parseRuntimeMode(value: string | undefined): DaemonRuntimeMode {
  if (value === undefined) return "standalone";
  if (value === "standalone" || value === "dev-server" || value === "test") return value;
  throw daemonFailure("parse", `Invalid runtime mode: ${value}`);
}

function parseRuntimeOwner(value: string | undefined): DaemonRuntimeOwner {
  if (value === "desktop" || value === "cli") return value;
  if (value !== undefined) throw daemonFailure("parse", `Invalid runtime owner: ${value}`);
  return "cli";
}

function defaultSpaDir(): string | undefined {
  const explicitResourceDir = process.env.SELFTUNE_DESKTOP_RESOURCE_DIR;
  const candidates = [
    explicitResourceDir ? join(explicitResourceDir, "dashboard") : null,
    join(dirname(process.execPath), "dashboard"),
    join(PACKAGE_ROOT, "apps", "local-dashboard", "dist"),
  ];
  return candidates.find((candidate) => candidate !== null && existsSync(candidate)) ?? undefined;
}

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

function installedVersion(): string {
  const environmentVersion = process.env.SELFTUNE_VERSION ?? process.env.SELFTUNE_SERVICE_VERSION;
  if (environmentVersion) return environmentVersion;
  try {
    return Schema.decodeUnknownSync(PackageVersion)(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ).version;
  } catch {
    // Compiled binaries receive their version through SELFTUNE_VERSION.
  }
  return "unknown";
}

export interface DaemonRunResolutionDependencies {
  readonly defaultSpaDir: () => string | undefined;
  readonly environment: (name: string) => string | undefined;
  readonly resolveConfigDir: () => string;
}

const LIVE_RUN_RESOLUTION_DEPENDENCIES: DaemonRunResolutionDependencies = {
  defaultSpaDir,
  environment: (name) => process.env[name],
  resolveConfigDir: resolveLocalConfigDir,
};

export function resolveDaemonRunOptions(
  input: DaemonRunInput,
  dependencies: DaemonRunResolutionDependencies = LIVE_RUN_RESOLUTION_DEPENDENCIES,
): DaemonRunOptions {
  const ambientConfigDir = resolve(dependencies.resolveConfigDir());
  const configDir = input.configDir ? resolve(input.configDir) : ambientConfigDir;
  if (configDir !== ambientConfigDir) {
    throw daemonFailure(
      "parse",
      "--config-dir must match SELFTUNE_CONFIG_DIR so all runtime state uses one directory.",
    );
  }
  const owner = parseRuntimeOwner(
    input.owner ??
      dependencies.environment("SELFTUNE_RUNTIME_OWNER") ??
      (dependencies.environment("SELFTUNE_DESKTOP") === "1" ? "desktop" : undefined),
  );
  const supervised = input.supervised || dependencies.environment("SELFTUNE_SUPERVISED") === "1";
  const serviceInstallationNonce = input.serviceInstallationNonce;
  if (
    serviceInstallationNonce !== undefined &&
    !isServiceInstallationNonce(serviceInstallationNonce)
  ) {
    throw daemonFailure(
      "parse",
      "--service-installation-nonce must be 32-128 base64url characters.",
    );
  }
  if (serviceInstallationNonce !== undefined && !input.supervised) {
    throw daemonFailure("parse", "--service-installation-nonce requires --supervised.");
  }
  const hostname = input.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") {
    throw daemonFailure("parse", "The local daemon may only listen on 127.0.0.1.");
  }
  const port = parsePort(input.port === undefined ? undefined : String(input.port));
  const runtimeMode = parseRuntimeMode(input.runtimeMode);
  const supervision: RuntimeSupervision = supervised
    ? "os-service"
    : owner === "desktop"
      ? "desktop-child"
      : "none";
  const spaDir = input.spaDir ?? dependencies.defaultSpaDir();
  const options = {
    configDir,
    hostname,
    owner,
    port,
    readySentinel: input.readySentinel,
    runtimeMode,
    spaDir,
    supervision,
  };
  return serviceInstallationNonce ? { ...options, serviceInstallationNonce } : options;
}

export function parseDaemonRunInput(args: ReadonlyArray<string>): DaemonRunInput {
  if (args.includes("--auth-token")) {
    throw daemonFailure(
      "parse",
      "--auth-token is not supported because process arguments are observable. Use the owner-only local auth file.",
    );
  }
  return {
    configDir: argumentValue(args, "--config-dir"),
    foreground: args.includes("--foreground"),
    hostname: argumentValue(args, "--hostname"),
    owner: argumentValue(args, "--owner")
      ? parseRuntimeOwner(argumentValue(args, "--owner"))
      : undefined,
    port: args.includes("--port") ? parsePort(argumentValue(args, "--port")) : undefined,
    readySentinel: args.includes("--ready-sentinel"),
    runtimeMode: args.includes("--runtime-mode")
      ? parseRuntimeMode(argumentValue(args, "--runtime-mode"))
      : undefined,
    serviceInstallationNonce: argumentValue(args, "--service-installation-nonce"),
    spaDir: argumentValue(args, "--spa-dir"),
    supervised: args.includes("--supervised"),
  };
}

export function parseDaemonRunOptions(args: ReadonlyArray<string>): DaemonRunOptions {
  return resolveDaemonRunOptions(parseDaemonRunInput(args));
}

export interface DaemonStartDependencies {
  readonly acquireLock: typeof acquireRuntimeLock;
  readonly createInstanceId: () => string;
  readonly executablePath: string;
  readonly installedVersion: () => string;
  readonly loadAuthToken: (configDir: string) => string;
  readonly printReady: (port: number) => void;
  readonly processId: number;
  readonly reconcileSchedule?: (configDir: string) => void;
  readonly removeManifest: typeof removeDaemonManifestIfOwned;
  readonly startServer: (options: Parameters<typeof startDashboardServer>[0]) => Promise<{
    readonly close?: () => Promise<void>;
    readonly port: number;
    readonly stop: () => void;
  }>;
  readonly writeManifest: typeof writeServerManifest;
}

const LIVE_START_DEPENDENCIES: DaemonStartDependencies = {
  acquireLock: acquireRuntimeLock,
  createInstanceId: randomUUID,
  executablePath: process.execPath,
  installedVersion,
  loadAuthToken: loadOrCreateLocalAuthToken,
  printReady: (port) => process.stdout.write(`SELFTUNE_READY:${port}\n`),
  processId: process.pid,
  reconcileSchedule: (configDir) => reconcilePersistedDesktopSchedule({ configDir }),
  removeManifest: removeDaemonManifestIfOwned,
  startServer: startDashboardServer,
  writeManifest: writeServerManifest,
};

const acquireDaemon = Effect.fn("SelfTuneDaemon.acquire")(function* (
  options: DaemonRunOptions,
  dependencies: DaemonStartDependencies = LIVE_START_DEPENDENCIES,
) {
  const instanceId = dependencies.createInstanceId();
  const identity = {
    configDir: options.configDir,
    instanceId,
    owner: options.owner,
    supervision: options.supervision,
    ownerExecutablePath: dependencies.executablePath,
  };
  const runtimeIdentity: DaemonRuntimeIdentity = options.serviceInstallationNonce
    ? { ...identity, serviceInstallationNonce: options.serviceInstallationNonce }
    : identity;
  let requestShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolveShutdown) => {
    requestShutdown = resolveShutdown;
  });
  let transferred = false;
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => dependencies.acquireLock(options.configDir, instanceId),
      catch: (cause) => daemonFailure("acquire-lock", cause),
    }),
    (runtimeLock) =>
      Effect.gen(function* () {
        if (dependencies.reconcileSchedule) {
          yield* Effect.try({
            try: () => dependencies.reconcileSchedule?.(options.configDir),
            catch: (cause) => daemonFailure("reconcile-schedule", cause),
          }).pipe(
            Effect.catch((failure) =>
              Effect.logWarning(
                `SelfTune could not restore the persisted desktop schedule: ${failure.message}`,
              ),
            ),
          );
        }
        const authToken = yield* Effect.try({
          try: () => dependencies.loadAuthToken(options.configDir),
          catch: (cause) => daemonFailure("load-auth-token", cause),
        });
        const handle = yield* Effect.tryPromise({
          try: () =>
            dependencies.startServer({
              port: options.port,
              host: options.hostname,
              authToken,
              spaDir: options.spaDir,
              openBrowser: false,
              runtimeMode: options.runtimeMode,
              runtimeIdentity,
              runtimeShutdown: () => requestShutdown?.(),
              spaProxyUrl: process.env.SPA_PROXY_URL,
              manageProcessSignals: false,
            }),
          catch: (cause) => daemonFailure("start", cause),
        });

        let releasePromise: Promise<void> | undefined;
        const stop = (): Promise<void> => {
          releasePromise ??= (async () => {
            const failures: unknown[] = [];
            const release = async (action: () => void | Promise<void>): Promise<void> => {
              try {
                await action();
              } catch (cause) {
                failures.push(cause);
              }
            };
            await release(() =>
              dependencies.removeManifest(options.configDir, dependencies.processId, instanceId),
            );
            await release(() => (handle.close ? handle.close() : handle.stop()));
            await release(() => runtimeLock.stop());
            if (failures.length > 0) {
              throw new AggregateError(failures, "Failed to release daemon resources.");
            }
          })();
          return releasePromise;
        };

        const manifestResult = yield* Effect.result(
          Effect.try({
            try: () =>
              dependencies.writeManifest(options.configDir, {
                version: 2,
                kind: "selftune-runtime",
                pid: dependencies.processId,
                port: handle.port,
                origin: `http://${options.hostname}:${handle.port}`,
                started_at: new Date().toISOString(),
                owner: runtimeIdentity.owner,
                supervision: runtimeIdentity.supervision,
                owner_version: dependencies.installedVersion(),
                owner_executable_path: runtimeIdentity.ownerExecutablePath,
                instance_id: runtimeIdentity.instanceId,
              }),
            catch: (cause) => daemonFailure("write-manifest", cause),
          }),
        );
        if (manifestResult._tag === "Failure") {
          transferred = true;
          yield* Effect.tryPromise({
            try: stop,
            catch: (cause) => daemonFailure("release", cause),
          }).pipe(Effect.ignore);
          return yield* Effect.fail(manifestResult.failure);
        }

        if (options.readySentinel) {
          const readyResult = yield* Effect.result(
            Effect.try({
              try: () => dependencies.printReady(handle.port),
              catch: (cause) => daemonFailure("ready-sentinel", cause),
            }),
          );
          if (readyResult._tag === "Failure") {
            transferred = true;
            yield* Effect.tryPromise({
              try: stop,
              catch: (cause) => daemonFailure("release", cause),
            }).pipe(Effect.ignore);
            return yield* Effect.fail(readyResult.failure);
          }
        }

        transferred = true;
        return { ...handle, shutdownRequested, stop };
      }),
    (runtimeLock) => (transferred ? Effect.void : Effect.promise(() => runtimeLock.stop())),
  );
});

export const startDaemon = Effect.fn("SelfTuneDaemon.start")(function* (
  options: DaemonRunOptions,
  dependencies: DaemonStartDependencies = LIVE_START_DEPENDENCIES,
) {
  return yield* Effect.acquireRelease(acquireDaemon(options, dependencies), (handle) =>
    Effect.tryPromise({
      try: () => handle.stop(),
      catch: (cause) => daemonFailure("release", cause),
    }).pipe(Effect.orDie),
  );
});

export interface DaemonRunProgramDependencies {
  readonly resolveOptions: (input: DaemonRunInput) => DaemonRunOptions;
  readonly start: (options: DaemonRunOptions) => Effect.Effect<
    {
      readonly shutdownRequested: Promise<void>;
      readonly stop: () => void | Promise<void>;
    },
    DaemonFailure,
    Scope.Scope
  >;
}

const LIVE_RUN_PROGRAM_DEPENDENCIES: DaemonRunProgramDependencies = {
  resolveOptions: resolveDaemonRunOptions,
  start: startDaemon,
};

export const runDaemonProgram = Effect.fn("SelfTuneDaemon.program")(function* (
  input: DaemonRunInput,
  dependencies: DaemonRunProgramDependencies = LIVE_RUN_PROGRAM_DEPENDENCIES,
) {
  const options = yield* Effect.try({
    try: () => dependencies.resolveOptions(input),
    catch: (cause) => (cause instanceof DaemonFailure ? cause : daemonFailure("parse", cause)),
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* dependencies.start(options);
      return yield* Effect.promise(() => handle.shutdownRequested);
    }),
  );
});

const RuntimeOwnership = Schema.Struct({
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  runtime_instance_id: Schema.String,
  config_dir: Schema.String,
  process_mode: Schema.Literal("standalone"),
});

async function manifestOwnsProcess(
  manifest: NonNullable<ReturnType<typeof readServerManifest>>,
  configDir: string,
  token: string,
): Promise<boolean> {
  const response = await fetch(new URL("/api/health", manifest.origin), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return false;
  const payload = Schema.decodeUnknownOption(RuntimeOwnership)(await response.json()).pipe(
    Option.getOrNull,
  );
  return (
    payload !== null &&
    payload.pid === manifest.pid &&
    payload.runtime_instance_id === manifest.instance_id &&
    resolve(payload.config_dir) === resolve(configDir) &&
    payload.process_mode === "standalone"
  );
}

export function manifestMatchesStopExpectation(
  manifest: NonNullable<ReturnType<typeof readServerManifest>>,
  expectation: RuntimeStopExpectation,
): boolean {
  return manifest.pid === expectation.pid && manifest.instance_id === expectation.instanceId;
}

export type DaemonShutdownRequestOutcome =
  | "accepted"
  | "instance-mismatch"
  | "rejected"
  | "transport-ambiguous";

export interface DaemonStopDependencies {
  readonly isProcessAlive: (pid: number) => boolean;
  readonly manifestOwnsProcess: (
    manifest: ServerManifest,
    configDir: string,
    token: string,
  ) => Promise<boolean>;
  readonly now: () => number;
  readonly readAuthToken: (configDir: string) => string | null;
  readonly readManifest: (configDir: string) => ServerManifest | null;
  readonly removeManifest: (configDir: string, pid: number, instanceId: string) => void;
  readonly requestShutdown: (
    manifest: ServerManifest,
    token: string,
  ) => Promise<DaemonShutdownRequestOutcome>;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const LIVE_STOP_DEPENDENCIES: DaemonStopDependencies = {
  isProcessAlive,
  manifestOwnsProcess,
  now: Date.now,
  readAuthToken: readLocalAuthToken,
  readManifest: readServerManifest,
  removeManifest: removeDaemonManifestIfOwned,
  requestShutdown: async (manifest, token) => {
    let response: Response;
    try {
      response = await fetch(new URL("/api/runtime/shutdown", manifest.origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runtime_instance_id: manifest.instance_id }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      return "transport-ambiguous";
    }
    if (response.status === 202) return "accepted";
    if (response.status === 409) return "instance-mismatch";
    return "rejected";
  },
  sleep: (milliseconds) => Bun.sleep(milliseconds),
};

export function stopDaemon(
  configDir = resolveLocalConfigDir(),
  expectation?: RuntimeStopExpectation,
  dependencies: DaemonStopDependencies = LIVE_STOP_DEPENDENCIES,
): Effect.Effect<boolean, DaemonFailure> {
  return Effect.tryPromise({
    try: async () => {
      const manifest = dependencies.readManifest(configDir);
      if (!manifest) return false;
      if (expectation && !manifestMatchesStopExpectation(manifest, expectation)) return false;
      if (!dependencies.isProcessAlive(manifest.pid)) {
        dependencies.removeManifest(configDir, manifest.pid, manifest.instance_id);
        return false;
      }
      const token = dependencies.readAuthToken(configDir);
      if (!token) {
        throw daemonFailure(
          "stop",
          "SelfTune local authentication is missing. Restart the owning daemon before stopping it.",
        );
      }
      if (!(await dependencies.manifestOwnsProcess(manifest, configDir, token))) {
        throw daemonFailure(
          "stop",
          "Refusing to stop a process whose authenticated runtime identity does not match the manifest.",
        );
      }
      const shutdown = await dependencies.requestShutdown(manifest, token);
      if (shutdown === "instance-mismatch") return false;
      if (shutdown === "rejected") {
        throw daemonFailure("stop", "The authenticated daemon rejected the shutdown request.");
      }

      const target = { instanceId: manifest.instance_id, pid: manifest.pid };
      const deadline = dependencies.now() + 10_000;
      const waitForRelease = async (): Promise<boolean> => {
        const current = dependencies.readManifest(configDir);
        if (!current || !manifestMatchesStopExpectation(current, target)) return true;
        if (dependencies.now() >= deadline) return false;
        await dependencies.sleep(100);
        return waitForRelease();
      };
      if (await waitForRelease()) return true;
      const current = dependencies.readManifest(configDir);
      if (
        current &&
        manifestMatchesStopExpectation(current, target) &&
        (await dependencies.manifestOwnsProcess(current, configDir, token))
      ) {
        throw daemonFailure("stop", "SelfTune daemon did not stop within 10 seconds.");
      }
      dependencies.removeManifest(configDir, manifest.pid, manifest.instance_id);
      return true;
    },
    catch: (cause) => daemonFailure("stop", cause),
  });
}

export function resolveStopExpectation(input: DaemonStopInput): RuntimeStopExpectation | undefined {
  if (input.expectedPid === undefined && input.expectedInstanceId === undefined) return undefined;
  if (input.expectedPid === undefined || input.expectedInstanceId === undefined) {
    throw daemonFailure(
      "parse",
      "--expected-pid and --expected-instance-id must be provided together.",
    );
  }
  const pid = input.expectedPid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw daemonFailure("parse", `Invalid expected daemon pid: ${pid}`);
  }
  if (input.expectedInstanceId.length === 0) {
    throw daemonFailure("parse", "Expected daemon instance id cannot be empty.");
  }
  return { instanceId: input.expectedInstanceId, pid };
}

export const getDaemonStatus = Effect.fn("SelfTuneDaemon.status")(function* (
  configDir = resolveLocalConfigDir(),
) {
  const manifest = readServerManifest(configDir);
  if (!manifest || !isProcessAlive(manifest.pid)) {
    if (manifest) removeDaemonManifestIfOwned(configDir, manifest.pid, manifest.instance_id);
    return { manifest: null, reachable: false } satisfies DaemonStatus;
  }
  const token = readLocalAuthToken(configDir);
  if (!token) return { manifest, reachable: false } satisfies DaemonStatus;
  const reachable = yield* Effect.tryPromise({
    try: () => manifestOwnsProcess(manifest, configDir, token),
    catch: () => daemonFailure("health", "Daemon health check failed."),
  }).pipe(Effect.catch(() => Effect.succeed(false)));
  return { manifest, reachable } satisfies DaemonStatus;
});

export interface DaemonCommandProgramDependencies {
  readonly getStatus: (configDir: string) => ReturnType<typeof getDaemonStatus>;
  readonly print: (message: string) => void;
  readonly resolveConfigDir: () => string;
  readonly rotateToken: (configDir: string) => string;
  readonly stop: (
    configDir: string,
    expectation?: RuntimeStopExpectation,
  ) => ReturnType<typeof stopDaemon>;
}

const LIVE_COMMAND_PROGRAM_DEPENDENCIES: DaemonCommandProgramDependencies = {
  getStatus: getDaemonStatus,
  print: (message) => console.log(message),
  resolveConfigDir: resolveLocalConfigDir,
  rotateToken: rotateLocalAuthToken,
  stop: stopDaemon,
};

export const runDaemonStatusProgram = Effect.fn("SelfTuneDaemon.statusProgram")(function* (
  input: DaemonStatusInput,
  dependencies: DaemonCommandProgramDependencies = LIVE_COMMAND_PROGRAM_DEPENDENCIES,
) {
  const status = yield* dependencies.getStatus(input.configDir ?? dependencies.resolveConfigDir());
  yield* Effect.sync(() => {
    if (input.json) {
      dependencies.print(JSON.stringify(status));
    } else if (!status.manifest) {
      dependencies.print("SelfTune daemon is not running.");
    } else {
      dependencies.print(
        `SelfTune daemon ${status.reachable ? "is healthy" : "is not reachable"} at ${status.manifest.origin} (pid ${status.manifest.pid}).`,
      );
    }
  });
  return status;
});

export const runDaemonStopProgram = Effect.fn("SelfTuneDaemon.stopProgram")(function* (
  input: DaemonStopInput,
  dependencies: DaemonCommandProgramDependencies = LIVE_COMMAND_PROGRAM_DEPENDENCIES,
) {
  const expectation = yield* Effect.try({
    try: () => resolveStopExpectation(input),
    catch: (cause) => (cause instanceof DaemonFailure ? cause : daemonFailure("parse", cause)),
  });
  const stopped = yield* dependencies.stop(
    input.configDir ?? dependencies.resolveConfigDir(),
    expectation,
  );
  yield* Effect.sync(() =>
    dependencies.print(stopped ? "SelfTune daemon stopped." : "SelfTune daemon is not running."),
  );
  return stopped;
});

export const runDaemonRotateTokenProgram = Effect.fn("SelfTuneDaemon.rotateTokenProgram")(
  function* (
    input: DaemonRotateTokenInput,
    dependencies: DaemonCommandProgramDependencies = LIVE_COMMAND_PROGRAM_DEPENDENCIES,
  ) {
    yield* Effect.try({
      try: () => dependencies.rotateToken(input.configDir ?? dependencies.resolveConfigDir()),
      catch: (cause) => daemonFailure("rotate-token", cause),
    });
    yield* Effect.sync(() =>
      dependencies.print(
        "SelfTune local authentication token rotated. Restart the daemon to apply it.",
      ),
    );
  },
);

function daemonHelp(): string {
  return `selftune daemon - Run and inspect the local SelfTune service

Usage:
  selftune daemon run [options]
  selftune daemon status [--json]
  selftune daemon stop
  selftune daemon rotate-token

Options:
  --port <port>          Listening port (default: ${DEFAULT_DAEMON_PORT})
  --hostname <host>     Listening host (default: 127.0.0.1)
  --spa-dir <path>      Built dashboard asset directory
  --config-dir <path>   Must match SELFTUNE_CONFIG_DIR
  --owner <owner>       Runtime owner: desktop or cli
  --supervised          Mark the runtime as OS-service supervised
  --ready-sentinel      Print SELFTUNE_READY:<port> after startup`;
}

export const daemonCliProgram = Effect.fn("SelfTuneDaemon.cli")(function* (
  args: ReadonlyArray<string>,
) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    yield* Effect.sync(() => console.log(daemonHelp()));
    return;
  }

  if (subcommand === "run") {
    return yield* runDaemonProgram(parseDaemonRunInput(args.slice(1)));
  }
  if (subcommand === "status") {
    yield* runDaemonStatusProgram({
      configDir: argumentValue(args, "--config-dir"),
      json: args.includes("--json"),
    });
    return;
  }
  if (subcommand === "stop") {
    const rawExpectedPid = argumentValue(args, "--expected-pid");
    yield* runDaemonStopProgram({
      configDir: argumentValue(args, "--config-dir"),
      expectedInstanceId: argumentValue(args, "--expected-instance-id"),
      expectedPid: rawExpectedPid === undefined ? undefined : Number(rawExpectedPid),
    });
    return;
  }
  if (subcommand === "rotate-token") {
    yield* runDaemonRotateTokenProgram({ configDir: argumentValue(args, "--config-dir") });
    return;
  }
  return yield* daemonFailure("parse", `Unknown daemon command: ${subcommand}`);
});

export async function cliMain(): Promise<void> {
  await Effect.runPromise(daemonCliProgram(process.argv.slice(2)));
}

if (import.meta.main) {
  BunRuntime.runMain(daemonCliProgram(process.argv.slice(2)));
}
