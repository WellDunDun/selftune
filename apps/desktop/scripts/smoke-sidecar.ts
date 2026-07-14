import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { createLineBuffer, parseReadyPort } from "../src/main/sidecar-protocol";

const desktopRoot = resolve(import.meta.dir, "..");
const executable = process.platform === "win32" ? "selftune-sidecar.exe" : "selftune-sidecar";
const binary = join(desktopRoot, "resources/selftune", executable);
const spaDir = join(desktopRoot, "resources/selftune/dashboard");
if (!existsSync(binary))
  throw new Error("Build the desktop sidecar before running its smoke test.");

const token = randomBytes(32).toString("base64url");
const child = spawn(
  binary,
  [
    "--port",
    "0",
    "--hostname",
    "127.0.0.1",
    "--auth-token",
    token,
    "--spa-dir",
    spaDir,
    "--runtime-mode",
    "standalone",
    "--ready-sentinel",
  ],
  {
    env: { ...process.env, SELFTUNE_VERSION: "0.2.22" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);

const port = await new Promise<number>((resolvePort, rejectPort) => {
  const timeout = setTimeout(() => rejectPort(new Error("Sidecar readiness timed out.")), 20_000);
  const write = createLineBuffer((line) => {
    const readyPort = parseReadyPort(line);
    if (readyPort === null) return;
    clearTimeout(timeout);
    resolvePort(readyPort);
  });
  child.stdout?.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
  child.once("exit", (code) => rejectPort(new Error(`Sidecar exited before ready: ${code}`)));
});

try {
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (unauthorized.status !== 401)
    throw new Error(`Expected 401, received ${unauthorized.status}.`);
  const authorized = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!authorized.ok) throw new Error(`Authorized health probe failed: ${authorized.status}.`);
  console.log(`SelfTune sidecar smoke test passed on port ${port}.`);
} finally {
  child.kill("SIGTERM");
}
