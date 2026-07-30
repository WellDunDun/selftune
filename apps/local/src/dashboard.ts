/**
 * selftune dashboard — Start the local React SPA dashboard server.
 *
 * Usage:
 *   selftune dashboard              — Start server on port 3141 and open browser
 *   selftune dashboard --port 8080  — Start on custom port
 *   selftune dashboard --restart    — Restart an existing dashboard on the target port
 *   selftune dashboard --serve      — Deprecated alias for the default behavior
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import type { HealthResponse } from "@selftune/runtime/dashboard-contract";
import { findSelftunePackageRoot } from "@selftune/runtime/package-root";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { DEFAULT_DASHBOARD_PORT, type DashboardInput } from "./dashboard-cli-contract.js";

const DEFAULT_PORT = DEFAULT_DASHBOARD_PORT;
const VERSION_PKG_PATH = join(findSelftunePackageRoot(), "package.json");
const HEALTHCHECK_TIMEOUT_MS = 1000;
const RESTART_WAIT_TIMEOUT_MS = 5000;
const RESTART_POLL_INTERVAL_MS = 250;

type DashboardServerHandle = Awaited<
  ReturnType<typeof import("./dashboard-server.js").startDashboardServer>
>;
type DashboardStartOptions = Parameters<
  typeof import("./dashboard-server.js").startDashboardServer
>[0];
type DashboardKillFn = (pid: number, signal?: string | number) => boolean;

type DashboardRuntimeHealth = Partial<HealthResponse> & {
  ok: boolean;
  service: string;
  pid?: number;
};

export interface DashboardLaunchOptions {
  openBrowser: boolean;
  port: number;
  restart: boolean;
}

export interface DashboardLaunchResult {
  action: "reused" | "started";
  installedVersion: string;
  serverHandle?: DashboardServerHandle;
  url: string;
}

export interface DashboardLaunchDependencies {
  fetch?: typeof fetch;
  findListeningPids?: (port: number) => number[];
  kill?: DashboardKillFn;
  log?: Pick<typeof console, "log" | "warn">;
  openUrl?: (url: string) => void;
  startDashboardServer?: (options?: DashboardStartOptions) => Promise<DashboardServerHandle>;
  wait?: (ms: number) => Promise<void>;
}

function getInstalledSelftuneVersion(): string {
  try {
    return JSON.parse(readFileSync(VERSION_PKG_PATH, "utf-8")).version;
  } catch {
    return "unknown";
  }
}

function buildDashboardUrl(port: number): string {
  return `http://localhost:${port}`;
}

function openDashboardUrl(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      Bun.spawn(["open", url]);
    } else if (platform === "linux") {
      Bun.spawn(["xdg-open", url]);
    } else if (platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "", url]);
    } else {
      console.log(`Open manually: ${url}`);
    }
  } catch {
    console.log(`Open manually: ${url}`);
  }
}

function isAddressInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address already in use|port .* in use|already in use/i.test(message);
}

function parsePidOutput(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function parseWindowsNetstatListeningPids(output: string, port: number): number[] {
  const pids = new Set<number>();
  const portSuffix = `:${port}`;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("LISTENING")) continue;

    const parts = trimmed.split(/\s+/);
    const localAddr = parts[1] ?? "";
    if (!localAddr.endsWith(portSuffix)) continue;

    const pid = Number.parseInt(parts.at(-1) ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return [...pids];
}

function findListeningPids(port: number): number[] {
  if (process.platform === "win32") {
    const result = Bun.spawnSync(["cmd", "/c", "netstat -ano -p tcp"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseWindowsNetstatListeningPids(result.stdout.toString(), port);
  }

  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return parsePidOutput(result.stdout.toString());
}

async function probeDashboardHealth(
  port: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DashboardRuntimeHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${buildDashboardUrl(port)}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as Partial<DashboardRuntimeHealth>;
    if (payload.service !== "selftune-dashboard" || payload.ok !== true) {
      return null;
    }
    return payload as DashboardRuntimeHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDashboardShutdown(
  port: number,
  deps: DashboardLaunchDependencies,
): Promise<void> {
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const deadline = Date.now() + RESTART_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const health = await probeDashboardHealth(port, fetchImpl);
    if (!health) {
      return;
    }
    await wait(RESTART_POLL_INTERVAL_MS);
  }

  throw new CLIError(
    `Timed out waiting for the existing dashboard on port ${port} to stop.`,
    "OPERATION_FAILED",
    "Retry `selftune dashboard --restart` or stop the existing dashboard process manually.",
  );
}

async function stopExistingDashboard(
  port: number,
  health: DashboardRuntimeHealth,
  deps: DashboardLaunchDependencies,
): Promise<void> {
  const listeningPids = deps.findListeningPids?.(port) ?? findListeningPids(port);
  const pids = new Set<number>();

  if (typeof health.pid === "number" && health.pid > 0) {
    pids.add(health.pid);
  }

  for (const pid of listeningPids) {
    if (pid > 0) {
      pids.add(pid);
    }
  }

  pids.delete(process.pid);

  if (pids.size === 0) {
    throw new CLIError(
      `Found a running dashboard on port ${port}, but could not determine its process ID.`,
      "OPERATION_FAILED",
      `Stop the dashboard on port ${port} manually, then rerun \`selftune dashboard --port ${port}\`.`,
    );
  }

  const kill = deps.kill ?? process.kill.bind(process);
  for (const pid of pids) {
    try {
      kill(pid, "SIGTERM");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ESRCH|no such process/i.test(message)) {
        throw new CLIError(
          `Failed to stop dashboard process ${pid}: ${message}`,
          "OPERATION_FAILED",
          `Stop the process on port ${port} manually, then rerun \`selftune dashboard --port ${port}\`.`,
        );
      }
    }
  }

  await waitForDashboardShutdown(port, deps);
}

export function parseDashboardOptions(
  args: string[] = process.argv.slice(2),
): DashboardLaunchOptions {
  const portIdx = args.indexOf("--port");
  let port = DEFAULT_PORT;

  if (portIdx !== -1) {
    const parsed = Number(args[portIdx + 1]);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new CLIError(
        `Invalid port "${args[portIdx + 1]}": must be an integer between 1 and 65535.`,
        "INVALID_FLAG",
        "Provide a port number between 1 and 65535 (e.g., --port 3141).",
      );
    }
    port = parsed;
  }

  return {
    openBrowser: !args.includes("--no-open"),
    port,
    restart: args.includes("--restart"),
  };
}

function dashboardInputFromArguments(args: string[]): DashboardInput {
  return {
    ...parseDashboardOptions(args),
    removedExport: args.includes("--export"),
    removedOut: args.includes("--out"),
    serve: args.includes("--serve"),
  };
}

function validateDashboardInput(input: DashboardInput): void {
  if (input.removedExport || input.removedOut) {
    throw new CLIError(
      "Legacy dashboard export was removed.",
      "INVALID_FLAG",
      "Use `selftune dashboard` to run the SPA locally, then share a route or screenshot instead.",
    );
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new CLIError(
      `Invalid port "${input.port}": must be an integer between 1 and 65535.`,
      "INVALID_FLAG",
      "Provide a port number between 1 and 65535 (e.g., --port 3141).",
    );
  }
}

export async function launchDashboard(
  args: string[] = process.argv.slice(2),
  deps: DashboardLaunchDependencies = {},
): Promise<DashboardLaunchResult> {
  return launchDashboardWithOptions(parseDashboardOptions(args), deps);
}

async function launchDashboardWithOptions(
  options: DashboardLaunchOptions,
  deps: DashboardLaunchDependencies,
): Promise<DashboardLaunchResult> {
  const log = deps.log ?? console;
  const openUrl = deps.openUrl ?? openDashboardUrl;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const installedVersion = getInstalledSelftuneVersion();
  const url = buildDashboardUrl(options.port);

  const runningDashboard = await probeDashboardHealth(options.port, fetchImpl);
  const versionMismatch =
    runningDashboard?.process_mode === "standalone" &&
    runningDashboard.version !== undefined &&
    runningDashboard.version !== "unknown" &&
    installedVersion !== "unknown" &&
    runningDashboard.version !== installedVersion;

  if (runningDashboard) {
    if (options.restart || versionMismatch) {
      if (versionMismatch) {
        log.log(
          `Installed selftune ${installedVersion} differs from running dashboard ${runningDashboard.version}. Restarting ${url} to pick up the update.`,
        );
      } else {
        log.log(`Restarting existing selftune dashboard at ${url}.`);
      }
      await stopExistingDashboard(options.port, runningDashboard, deps);
    } else {
      if (
        runningDashboard.process_mode !== "standalone" &&
        runningDashboard.version !== installedVersion &&
        installedVersion !== "unknown"
      ) {
        log.warn(
          `Dashboard already running at ${url} from ${runningDashboard.process_mode} mode (version ${runningDashboard.version}). Reusing it without restart.`,
        );
      } else {
        log.log(`Reusing existing selftune dashboard at ${url}.`);
      }
      if (options.openBrowser) {
        openUrl(url);
      }
      return { action: "reused", installedVersion, url };
    }
  }

  const startDashboardServer =
    deps.startDashboardServer ?? (await import("./dashboard-server.js")).startDashboardServer;

  try {
    const serverHandle = await startDashboardServer({
      port: options.port,
      openBrowser: options.openBrowser,
      runtimeMode: "standalone",
      manageProcessSignals: false,
    });
    return {
      action: "started",
      installedVersion,
      serverHandle,
      url: buildDashboardUrl(serverHandle.port),
    };
  } catch (error) {
    const liveDashboard = await probeDashboardHealth(options.port, fetchImpl);
    if (liveDashboard && !options.restart) {
      log.log(`Reusing existing selftune dashboard at ${url}.`);
      if (options.openBrowser) {
        openUrl(url);
      }
      return { action: "reused", installedVersion, url };
    }

    if (isAddressInUseError(error)) {
      throw new CLIError(
        `Port ${options.port} is already in use.`,
        "OPERATION_FAILED",
        liveDashboard
          ? `Run \`selftune dashboard --port ${options.port} --restart\` to replace the existing dashboard.`
          : `Use \`selftune dashboard --port <port>\` or stop the process currently listening on ${options.port}.`,
      );
    }

    throw error;
  }
}

type DashboardProgramLaunchResult =
  | { readonly action: "reused" }
  | { readonly action: "started"; readonly stop: () => void | Promise<void> };

export interface DashboardProgramDependencies {
  readonly launch?: (options: DashboardLaunchOptions) => Promise<DashboardProgramLaunchResult>;
  readonly warn?: (message: string) => void;
}

async function launchDashboardProgram(
  input: DashboardInput,
  dependencies: DashboardProgramDependencies,
): Promise<DashboardProgramLaunchResult> {
  if (dependencies.launch) return dependencies.launch(input);
  const result = await launchDashboardWithOptions(input, {});
  if (result.action === "reused") return { action: "reused" };
  const serverHandle = result.serverHandle;
  if (!serverHandle) {
    throw new CLIError(
      "Dashboard started without a server handle.",
      "OPERATION_FAILED",
      "selftune dashboard --help",
    );
  }
  return { action: "started", stop: () => serverHandle.close() };
}

export const runDashboardProgram = Effect.fn("SelfTuneDashboard.run")(function* (
  input: DashboardInput,
  dependencies: DashboardProgramDependencies = {},
) {
  yield* Effect.try({
    try: () => validateDashboardInput(input),
    catch: (cause) =>
      cause instanceof CLIError
        ? cause
        : new CLIError(
            `Dashboard failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            "OPERATION_FAILED",
            "selftune dashboard --help",
          ),
  });
  if (input.serve) {
    yield* Effect.sync(() =>
      (dependencies.warn ?? console.warn)(
        "`selftune dashboard --serve` is deprecated; use `selftune dashboard` instead.",
      ),
    );
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      const launch = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => launchDashboardProgram(input, dependencies),
          catch: (cause) =>
            cause instanceof CLIError
              ? cause
              : new CLIError(
                  `Dashboard failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  "OPERATION_FAILED",
                  "selftune dashboard --help",
                ),
        }),
        (result) =>
          result.action === "started"
            ? Effect.promise(() => Promise.resolve(result.stop()))
            : Effect.void,
      );
      if (launch.action === "started") return yield* Effect.never;
    }),
  );
});

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`selftune dashboard — Visual data dashboard

Usage:
  selftune dashboard                      Start dashboard server (port 3141)
  selftune dashboard --port 8080          Start on custom port
  selftune dashboard --restart            Restart existing dashboard on the target port
  selftune dashboard --serve              Deprecated alias for default behavior
  selftune dashboard --no-open            Start server without opening browser`);
    process.exit(0);
  }

  await Effect.runPromise(runDashboardProgram(dashboardInputFromArguments(args)));
}
