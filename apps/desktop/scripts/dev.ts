/* oxlint-disable no-await-in-loop -- renderer health probes are intentionally sequential */
/* oxlint-disable no-console -- this contributor command reports startup failures */
import { resolve } from "node:path";
import { createServer } from "node:net";

const DESKTOP_ROOT = resolve(import.meta.dirname, "..");
const DASHBOARD_ROOT = resolve(DESKTOP_ROOT, "../local-dashboard");

function requestedRendererPort(): number | null {
  const parsed = Number.parseInt(process.env.VITE_PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

async function rendererPort(): Promise<number> {
  const requested = requestedRendererPort();
  if (requested !== null) return requested;
  for (let candidate = 5199; candidate < 5219; candidate += 1) {
    if (await portIsAvailable(candidate)) return candidate;
  }
  throw new Error("No available renderer port in the 5199–5218 range.");
}

function signalOwnedProcessGroup(
  child: ReturnType<typeof Bun.spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall through to the direct child signal.
    }
  }
  child.kill(signal);
}

function ownedProcessIsAlive(child: ReturnType<typeof Bun.spawn>): boolean {
  if (process.platform === "win32" || child.pid <= 0) return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForOwnedProcessExit(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ownedProcessIsAlive(child) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  return !ownedProcessIsAlive(child);
}

export async function stopProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!ownedProcessIsAlive(child)) return;
  signalOwnedProcessGroup(child, "SIGTERM");
  if (await waitForOwnedProcessExit(child, 2_000)) return;
  signalOwnedProcessGroup(child, "SIGKILL");
  if (await waitForOwnedProcessExit(child, 2_000)) return;
  throw new Error(`Development process group ${child.pid} did not stop.`);
}

async function waitForRenderer(url: string, vite: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Dashboard Vite process exited during startup with code ${vite.exitCode}.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Dashboard Vite server did not become ready at ${url}.`);
}

async function main(): Promise<void> {
  const port = await rendererPort();
  const rendererUrl = `http://127.0.0.1:${port}`;
  const vite = Bun.spawn(
    [
      process.execPath,
      resolve(DASHBOARD_ROOT, "node_modules/vite/bin/vite.js"),
      "--strictPort",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--config",
      resolve(DASHBOARD_ROOT, "vite.config.ts"),
    ],
    {
      cwd: DASHBOARD_ROOT,
      env: { ...process.env, VITE_PORT: String(port) },
      stderr: "inherit",
      stdout: "inherit",
      detached: process.platform !== "win32",
    },
  );
  let electron: ReturnType<typeof Bun.spawn> | null = null;
  const stop = async (): Promise<void> => {
    await Promise.all([stopProcess(vite), ...(electron === null ? [] : [stopProcess(electron)])]);
  };
  const handleSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    await waitForRenderer(rendererUrl, vite);
    electron = Bun.spawn(
      [
        process.execPath,
        resolve(DESKTOP_ROOT, "node_modules/electron-vite/bin/electron-vite.js"),
        "dev",
      ],
      {
        cwd: DESKTOP_ROOT,
        env: { ...process.env, SELFTUNE_DESKTOP_RENDERER_URL: rendererUrl },
        stderr: "inherit",
        stdout: "inherit",
        detached: process.platform !== "win32",
      },
    );
    const exited = await Promise.race([
      electron.exited.then((code) => ({ process: "Electron", code })),
      vite.exited.then((code) => ({ process: "dashboard Vite", code })),
    ]);
    if (exited.process === "dashboard Vite") {
      throw new Error(`Dashboard Vite exited unexpectedly with code ${exited.code}.`);
    }
    process.exitCode = exited.code;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await stop();
  }
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
