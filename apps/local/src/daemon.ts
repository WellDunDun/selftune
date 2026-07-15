import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { findSelftunePackageRoot } from "@selftune/runtime/package-root";
import { startDashboardServer } from "./dashboard-server.js";
import {
  acquireRuntimeLock,
  DEFAULT_DAEMON_PORT,
  isProcessAlive,
  loadOrCreateLocalAuthToken,
  readServerManifest,
  removeDaemonManifestIfOwned,
  resolveLocalConfigDir,
  type RuntimeOwner,
  type RuntimeSupervision,
  rotateLocalAuthToken,
  writeServerManifest,
} from "./local-runtime.js";

type DashboardServerHandle = Awaited<ReturnType<typeof startDashboardServer>>;
type RuntimeMode = "standalone" | "dev-server" | "test";
const PACKAGE_ROOT = findSelftunePackageRoot();

export interface DaemonRunOptions {
  readonly authToken: string;
  readonly configDir: string;
  readonly hostname: string;
  readonly port: number;
  readonly readySentinel: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly owner: RuntimeOwner;
  readonly spaDir?: string;
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
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DAEMON_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw daemonFailure("parse", `Invalid daemon port: ${value}`);
  }
  return port;
}

function parseRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === undefined) return "standalone";
  if (value === "standalone" || value === "dev-server" || value === "test") return value;
  throw daemonFailure("parse", `Invalid runtime mode: ${value}`);
}

function parseRuntimeOwner(value: string | undefined): RuntimeOwner {
  if (value === "desktop" || value === "cli") return value;
  if (value !== undefined) throw daemonFailure("parse", `Invalid runtime owner: ${value}`);
  return process.env.SELFTUNE_DESKTOP === "1" ? "desktop" : "cli";
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

function installedVersion(): string {
  const environmentVersion = process.env.SELFTUNE_VERSION ?? process.env.SELFTUNE_SERVICE_VERSION;
  if (environmentVersion) return environmentVersion;
  try {
    const value: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      typeof value.version === "string"
    ) {
      return value.version;
    }
  } catch {
    // Compiled binaries receive their version through SELFTUNE_VERSION.
  }
  return "unknown";
}

export function parseDaemonRunOptions(args: ReadonlyArray<string>): DaemonRunOptions {
  if (args.includes("--auth-token")) {
    throw daemonFailure(
      "parse",
      "--auth-token is not supported because process arguments are observable. Use the owner-only local auth file.",
    );
  }
  const ambientConfigDir = resolve(resolveLocalConfigDir());
  const requestedConfigDir = argumentValue(args, "--config-dir");
  const configDir = requestedConfigDir ? resolve(requestedConfigDir) : ambientConfigDir;
  if (configDir !== ambientConfigDir) {
    throw daemonFailure(
      "parse",
      "--config-dir must match SELFTUNE_CONFIG_DIR so all runtime state uses one directory.",
    );
  }
  const supervised = args.includes("--supervised") || process.env.SELFTUNE_SUPERVISED === "1";
  const owner = parseRuntimeOwner(
    argumentValue(args, "--owner") ?? process.env.SELFTUNE_RUNTIME_OWNER,
  );
  const supervision: RuntimeSupervision = supervised
    ? "os-service"
    : owner === "desktop"
      ? "desktop-child"
      : "none";
  const hostname = argumentValue(args, "--hostname") ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") {
    throw daemonFailure("parse", "The local daemon may only listen on 127.0.0.1.");
  }
  const authToken = loadOrCreateLocalAuthToken(configDir);
  return {
    configDir,
    hostname,
    owner,
    port: parsePort(argumentValue(args, "--port")),
    readySentinel: args.includes("--ready-sentinel"),
    runtimeMode: parseRuntimeMode(argumentValue(args, "--runtime-mode")),
    spaDir: argumentValue(args, "--spa-dir") ?? defaultSpaDir(),
    supervision,
    authToken,
  };
}

export const startDaemon = Effect.fn("SelfTuneDaemon.start")(function* (options: DaemonRunOptions) {
  const instanceId = randomUUID();
  const runtimeLock = yield* Effect.try({
    try: () => acquireRuntimeLock(options.configDir, instanceId),
    catch: (cause) => daemonFailure("acquire-lock", cause),
  });
  const startResult = yield* Effect.result(
    Effect.tryPromise({
      try: () =>
        startDashboardServer({
          port: options.port,
          host: options.hostname,
          authToken: options.authToken,
          spaDir: options.spaDir,
          openBrowser: false,
          runtimeMode: options.runtimeMode,
          runtimeInstanceId: instanceId,
          spaProxyUrl: process.env.SPA_PROXY_URL,
        }),
      catch: (cause) => daemonFailure("start", cause),
    }),
  );
  if (startResult._tag === "Failure") {
    runtimeLock.stop();
    return yield* Effect.fail(startResult.failure);
  }
  const handle = startResult.success;

  const manifestResult = yield* Effect.result(
    Effect.try({
      try: () =>
        writeServerManifest(options.configDir, {
          version: 2,
          kind: "selftune-runtime",
          pid: process.pid,
          port: handle.port,
          origin: `http://${options.hostname}:${handle.port}`,
          started_at: new Date().toISOString(),
          owner: options.owner,
          supervision: options.supervision,
          owner_version: installedVersion(),
          owner_executable_path: process.execPath,
          instance_id: instanceId,
        }),
      catch: (cause) => daemonFailure("write-manifest", cause),
    }),
  );
  if (manifestResult._tag === "Failure") {
    handle.stop();
    runtimeLock.stop();
    return yield* Effect.fail(manifestResult.failure);
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    removeDaemonManifestIfOwned(options.configDir, process.pid, instanceId);
    handle.stop();
    runtimeLock.stop();
  };
  const terminate = (): void => {
    stop();
    process.exit(0);
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  process.once("exit", () =>
    removeDaemonManifestIfOwned(options.configDir, process.pid, instanceId),
  );

  if (options.readySentinel) {
    yield* Effect.sync(() => process.stdout.write(`SELFTUNE_READY:${handle.port}\n`));
  }

  return { ...handle, stop };
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const payload: unknown = await response.json();
  return (
    isRecord(payload) &&
    payload.pid === manifest.pid &&
    payload.runtime_instance_id === manifest.instance_id &&
    typeof payload.config_dir === "string" &&
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

export function stopDaemon(
  configDir = resolveLocalConfigDir(),
  expectation?: RuntimeStopExpectation,
): Effect.Effect<boolean, DaemonFailure> {
  return Effect.tryPromise({
    try: async () => {
      const manifest = readServerManifest(configDir);
      if (!manifest) return false;
      if (expectation && !manifestMatchesStopExpectation(manifest, expectation)) return false;
      if (!isProcessAlive(manifest.pid)) {
        removeDaemonManifestIfOwned(configDir, manifest.pid, manifest.instance_id);
        return false;
      }
      const token = loadOrCreateLocalAuthToken(configDir);
      if (!(await manifestOwnsProcess(manifest, configDir, token))) {
        throw daemonFailure(
          "stop",
          "Refusing to signal a process whose authenticated runtime identity does not match the manifest.",
        );
      }
      process.kill(manifest.pid, "SIGTERM");
      const deadline = Date.now() + 10_000;
      while (isProcessAlive(manifest.pid) && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      if (isProcessAlive(manifest.pid)) {
        throw daemonFailure("stop", "SelfTune daemon did not stop within 10 seconds.");
      }
      removeDaemonManifestIfOwned(configDir, manifest.pid, manifest.instance_id);
      return true;
    },
    catch: (cause) => daemonFailure("stop", cause),
  });
}

function parseStopExpectation(args: ReadonlyArray<string>): RuntimeStopExpectation | undefined {
  const rawPid = argumentValue(args, "--expected-pid");
  const instanceId = argumentValue(args, "--expected-instance-id");
  if (rawPid === undefined && instanceId === undefined) return undefined;
  if (rawPid === undefined || instanceId === undefined) {
    throw daemonFailure(
      "parse",
      "--expected-pid and --expected-instance-id must be provided together.",
    );
  }
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw daemonFailure("parse", `Invalid expected daemon pid: ${rawPid}`);
  }
  if (instanceId.length === 0) {
    throw daemonFailure("parse", "Expected daemon instance id cannot be empty.");
  }
  return { instanceId, pid };
}

export const getDaemonStatus = Effect.fn("SelfTuneDaemon.status")(function* (
  configDir = resolveLocalConfigDir(),
) {
  const manifest = readServerManifest(configDir);
  if (!manifest || !isProcessAlive(manifest.pid)) {
    if (manifest) removeDaemonManifestIfOwned(configDir, manifest.pid);
    return { manifest: null, reachable: false } satisfies DaemonStatus;
  }
  const token = loadOrCreateLocalAuthToken(configDir);
  const reachable = yield* Effect.tryPromise({
    try: () => manifestOwnsProcess(manifest, configDir, token),
    catch: () => daemonFailure("health", "Daemon health check failed."),
  }).pipe(Effect.catch(() => Effect.succeed(false)));
  return { manifest, reachable } satisfies DaemonStatus;
});

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

export async function cliMain(): Promise<DashboardServerHandle | void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(daemonHelp());
    return;
  }

  if (subcommand === "run") {
    return Effect.runPromise(startDaemon(parseDaemonRunOptions(args.slice(1))));
  }
  if (subcommand === "status") {
    const status = await Effect.runPromise(
      getDaemonStatus(argumentValue(args, "--config-dir") ?? resolveLocalConfigDir()),
    );
    if (args.includes("--json")) {
      console.log(JSON.stringify(status));
    } else if (!status.manifest) {
      console.log("SelfTune daemon is not running.");
    } else {
      console.log(
        `SelfTune daemon ${status.reachable ? "is healthy" : "is not reachable"} at ${status.manifest.origin} (pid ${status.manifest.pid}).`,
      );
    }
    return;
  }
  if (subcommand === "stop") {
    const stopped = await Effect.runPromise(
      stopDaemon(
        argumentValue(args, "--config-dir") ?? resolveLocalConfigDir(),
        parseStopExpectation(args),
      ),
    );
    console.log(stopped ? "SelfTune daemon stopped." : "SelfTune daemon is not running.");
    return;
  }
  if (subcommand === "rotate-token") {
    const configDir = argumentValue(args, "--config-dir") ?? resolveLocalConfigDir();
    rotateLocalAuthToken(configDir);
    console.log("SelfTune local authentication token rotated. Restart the daemon to apply it.");
    return;
  }
  throw daemonFailure("parse", `Unknown daemon command: ${subcommand}`);
}

if (import.meta.main) {
  await cliMain();
}
