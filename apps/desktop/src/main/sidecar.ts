import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { app } from "electron";

import { loadOrCreateLocalAuthToken } from "./local-auth";
import { createLineBuffer, parseReadyPort } from "./sidecar-protocol";

const STARTUP_TIMEOUT_MS = 20_000;

export interface SidecarConnection {
  authToken: string;
  baseUrl: string;
  child: ChildProcess;
  port: number;
}

function selfTuneRoot(): string {
  return resolve(app.getAppPath(), "../..");
}

function resolveCommand(): { command: string; args: string[]; cwd: string; spaDir: string } {
  if (app.isPackaged) {
    const executable = process.platform === "win32" ? "selftune-sidecar.exe" : "selftune-sidecar";
    const resourceRoot = join(process.resourcesPath, "selftune");
    return {
      command: join(resourceRoot, executable),
      args: [],
      cwd: resourceRoot,
      spaDir: join(resourceRoot, "dashboard"),
    };
  }

  const root = selfTuneRoot();
  return {
    command: "bun",
    args: ["run", join(root, "cli/selftune/dashboard-server.ts")],
    cwd: root,
    spaDir: join(root, "apps/local-dashboard/dist"),
  };
}

function configDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR ?? join(homedir(), ".selftune");
}

function writeManifest(connection: SidecarConnection): void {
  const controlDir = join(configDir(), "server-control");
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(controlDir, "server.json"),
    `${JSON.stringify(
      {
        version: 1,
        kind: "desktop-sidecar",
        pid: connection.child.pid,
        port: connection.port,
        origin: connection.baseUrl,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export async function startSidecar(): Promise<SidecarConnection> {
  const authToken = loadOrCreateLocalAuthToken(configDir());
  const { command, args, cwd, spaDir } = resolveCommand();
  if (!existsSync(spaDir)) {
    throw new Error(`Dashboard assets are missing at ${spaDir}.`);
  }

  const child = spawn(
    command,
    [
      ...args,
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
      "--auth-token",
      authToken,
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
        SELFTUNE_DESKTOP: "1",
        SELFTUNE_VERSION: app.getVersion(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return new Promise<SidecarConnection>((resolveStart, rejectStart) => {
    let settled = false;
    let stderrTail = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectStart(new Error("SelfTune local server did not become ready within 20 seconds."));
    }, STARTUP_TIMEOUT_MS);

    const onStdout = createLineBuffer((line) => {
      const port = parseReadyPort(line);
      if (port === null || settled) return;
      settled = true;
      clearTimeout(timeout);
      const connection: SidecarConnection = {
        authToken,
        baseUrl: `http://127.0.0.1:${port}`,
        child,
        port,
      };
      writeManifest(connection);
      resolveStart(connection);
    });

    child.stdout?.on("data", (chunk: Buffer) => onStdout(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectStart(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectStart(
        new Error(
          `SelfTune local server exited during startup (${code ?? "signal"}). ${stderrTail}`,
        ),
      );
    });
  });
}

export async function stopSidecar(connection: SidecarConnection): Promise<void> {
  rmSync(join(configDir(), "server-control", "server.json"), { force: true });
  if (connection.child.exitCode !== null || connection.child.killed) return;
  connection.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => connection.child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (connection.child.exitCode === null) connection.child.kill("SIGKILL");
}
