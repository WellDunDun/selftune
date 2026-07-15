import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { app } from "electron";

import {
  loadOrCreateLocalAuthToken,
  readServerManifest,
  readSupervisedDaemonManifest,
  removeDaemonManifestIfOwned,
  type RuntimeOwner,
  type RuntimeSupervision,
  type ServerManifest,
} from "@selftune/local/local-runtime";
import { resolveLoginShellPath } from "@selftune/runtime/login-shell-path";
import { createLineBuffer, parseReadyPort } from "./sidecar-protocol";
import { installedRuntimeRoot } from "./runtime-install";

const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const execFileAsync = promisify(execFile);

export interface SidecarConnection {
  authToken: string;
  baseUrl: string;
  child: ChildProcess | null;
  instanceId: string;
  owner: RuntimeOwner;
  pid: number;
  port: number;
  supervision: RuntimeSupervision;
  ownerVersion: string | null;
  ownerExecutablePath: string | null;
  stderrTail: () => string;
}

function selfTuneRoot(): string {
  return resolve(app.getAppPath(), "../..");
}

function resolveCommand(): {
  command: string;
  cliArgs: string[];
  cwd: string;
  spaDir: string;
  taskCliPath?: string;
} {
  if (app.isPackaged) {
    const executable = process.platform === "win32" ? "selftune.exe" : "selftune";
    const resourceRoot = installedRuntimeRoot();
    return {
      command: join(resourceRoot, executable),
      cliArgs: [],
      cwd: resourceRoot,
      spaDir: join(resourceRoot, "dashboard"),
      taskCliPath: join(resourceRoot, executable),
    };
  }

  const root = selfTuneRoot();
  return {
    command: "bun",
    cliArgs: ["run", join(root, "apps/cli/src/main.ts")],
    cwd: root,
    spaDir: join(root, "apps/local-dashboard/dist"),
  };
}

function configDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR ?? join(homedir(), ".selftune");
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") return childHasExited(child);
    throw cause;
  }
}

async function terminateManagedChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, SHUTDOWN_TIMEOUT_MS)) return;

  child.kill("SIGKILL");
  if (await waitForChildExit(child, SHUTDOWN_TIMEOUT_MS)) return;
  throw new Error(`SelfTune local server process ${child.pid ?? "unknown"} did not stop.`);
}

export async function startSidecar(signal?: AbortSignal): Promise<SidecarConnection> {
  signal?.throwIfAborted();
  const authToken = loadOrCreateLocalAuthToken(configDir());
  const { command, cliArgs, cwd, spaDir, taskCliPath } = resolveCommand();
  if (!existsSync(spaDir)) {
    throw new Error(`Dashboard assets are missing at ${spaDir}.`);
  }

  const child = spawn(
    command,
    [
      ...cliArgs,
      "daemon",
      "run",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
      "--owner",
      "desktop",
      "--spa-dir",
      spaDir,
      "--runtime-mode",
      "standalone",
      "--ready-sentinel",
    ],
    {
      cwd,
      env: {
        ...process.env,
        PATH: resolveLoginShellPath(),
        SELFTUNE_DESKTOP: "1",
        SELFTUNE_RUNTIME_OWNER: "desktop",
        SELFTUNE_SUPERVISED: "0",
        SELFTUNE_VERSION: app.getVersion(),
        SELFTUNE_CONFIG_DIR: configDir(),
        ...(taskCliPath
          ? {
              SELFTUNE_BIN_PATH: taskCliPath,
              SELFTUNE_DESKTOP_RESOURCE_DIR: cwd,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (process.env.SELFTUNE_DESKTOP_TEST_QUIT_AFTER_SIDECAR_SPAWN === "1") {
    setImmediate(() => {
      app.quit();
      app.quit();
    });
  }

  try {
    return await new Promise<SidecarConnection>((resolveStart, rejectStart) => {
      let settled = false;
      let stderrTail = "";
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectStart(error);
      };
      const onAbort = (): void => {
        rejectOnce(new Error("SelfTune local server startup was cancelled."));
      };
      const timeout = setTimeout(() => {
        rejectOnce(new Error("SelfTune local server did not become ready within 20 seconds."));
      }, STARTUP_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      const onStdout = createLineBuffer((line) => {
        const port = parseReadyPort(line);
        if (port === null || settled) return;
        const manifest = readServerManifest(configDir());
        if (
          child.pid === undefined ||
          manifest?.pid !== child.pid ||
          manifest.port !== port ||
          manifest.owner !== "desktop" ||
          manifest.supervision !== "desktop-child"
        ) {
          rejectOnce(
            new Error("SelfTune local server became ready without the expected runtime identity."),
          );
          return;
        }
        settled = true;
        cleanup();
        const connection: SidecarConnection = {
          authToken,
          baseUrl: `http://127.0.0.1:${port}`,
          child,
          instanceId: manifest.instance_id,
          owner: "desktop",
          pid: manifest.pid,
          port,
          supervision: "desktop-child",
          ownerVersion: app.getVersion(),
          ownerExecutablePath: command,
          stderrTail: () => stderrTail,
        };
        resolveStart(connection);
      });

      child.stdout?.on("data", (chunk: Buffer) => onStdout(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
      });
      child.once("error", (error) => {
        rejectOnce(error);
      });
      child.once("exit", (code) => {
        rejectOnce(
          new Error(
            `SelfTune local server exited during startup (${code ?? "signal"}). ${stderrTail}`,
          ),
        );
      });
    });
  } catch (cause) {
    await terminateManagedChild(child);
    throw cause;
  }
}

async function stopDetachedDesktopChild(connection: SidecarConnection): Promise<void> {
  const { command, cliArgs, cwd, taskCliPath } = resolveCommand();
  await execFileAsync(
    command,
    [
      ...cliArgs,
      "daemon",
      "stop",
      "--config-dir",
      configDir(),
      "--expected-pid",
      String(connection.pid),
      "--expected-instance-id",
      connection.instanceId,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: resolveLoginShellPath(),
        SELFTUNE_CONFIG_DIR: configDir(),
        SELFTUNE_DESKTOP: "1",
        SELFTUNE_RUNTIME_OWNER: "desktop",
        SELFTUNE_VERSION: app.getVersion(),
        ...(taskCliPath ? { SELFTUNE_BIN_PATH: taskCliPath } : {}),
      },
      timeout: 15_000,
    },
  );
}

export async function stopSidecar(connection: SidecarConnection): Promise<void> {
  if (connection.supervision === "os-service") return;
  if (!connection.child) {
    if (connection.supervision === "desktop-child") await stopDetachedDesktopChild(connection);
    return;
  }
  const child = connection.child;
  await terminateManagedChild(child);
  if (child.pid) removeDaemonManifestIfOwned(configDir(), child.pid, connection.instanceId);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function attachToManifest(manifest: ServerManifest): Promise<SidecarConnection | null> {
  const localConfigDir = configDir();
  const authToken = loadOrCreateLocalAuthToken(localConfigDir);
  try {
    const response = await fetch(new URL("/api/health", manifest.origin), {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(1_500),
    });
    const payload: unknown = response.ok ? await response.json() : null;
    if (
      isRecord(payload) &&
      payload.pid === manifest.pid &&
      payload.runtime_instance_id === manifest.instance_id &&
      payload.process_mode === "standalone" &&
      typeof payload.config_dir === "string" &&
      resolve(payload.config_dir) === resolve(localConfigDir)
    ) {
      return {
        authToken,
        baseUrl: manifest.origin,
        child: null,
        instanceId: manifest.instance_id,
        owner: manifest.owner,
        pid: manifest.pid,
        port: manifest.port,
        supervision: manifest.supervision,
        ownerVersion: manifest.owner_version,
        ownerExecutablePath: manifest.owner_executable_path,
        stderrTail: () => "",
      };
    }
  } catch {
    // The OS service may be between crash restart and readiness.
  }
  if (!isPidAlive(manifest.pid)) {
    removeDaemonManifestIfOwned(localConfigDir, manifest.pid);
  }
  return null;
}

export async function attachToExistingRuntime(): Promise<SidecarConnection | null> {
  const manifest = readServerManifest(configDir());
  return manifest ? attachToManifest(manifest) : null;
}

export async function attachToSupervisedSidecar(): Promise<SidecarConnection | null> {
  const manifest = readSupervisedDaemonManifest(configDir());
  return manifest ? attachToManifest(manifest) : null;
}
