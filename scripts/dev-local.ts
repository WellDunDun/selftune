/* oxlint-disable no-await-in-loop -- health probes are intentionally sequential */
/* oxlint-disable no-console -- this contributor command reports status on stdout */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as Schema from "effect/Schema";

import {
  claimDevPorts,
  devManifestPath,
  encodeDevProcessTitle,
  findDevProcessCandidates,
  inspectDevInstance,
  removeDevManifestIfOwned,
  removeStaleDevManifest,
  writeDevManifest,
  type DevManifest,
} from "./dev-local-state";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const PackageManifest = Schema.Struct({ version: Schema.String });
const PACKAGE_VERSION = Schema.decodeUnknownSync(PackageManifest)(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
).version;

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function worktreeFromArgs(args: readonly string[]): string {
  return resolve(argumentValue(args, "--worktree") ?? REPOSITORY_ROOT);
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "linux"
        ? ["xdg-open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : null;
  if (!command) {
    console.log(`Open manually: ${url}`);
    return;
  }
  try {
    Bun.spawn(command, { stderr: "ignore", stdout: "ignore" });
  } catch {
    console.log(`Open manually: ${url}`);
  }
}

async function waitForHealthy(worktree: string, timeoutMs = 30_000): Promise<DevManifest> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "The dev stack did not become healthy.";
  while (Date.now() < deadline) {
    const current = await inspectDevInstance(worktree);
    if (current.healthy === true) return current.manifest;
    lastReason = current.reason;
    await Bun.sleep(200);
  }
  throw new Error(lastReason);
}

async function stopProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

async function startOwnedSupervisor(worktree: string): Promise<void> {
  const ownerMarker = encodeDevProcessTitle("supervisor", worktree);
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.filename,
      "supervise",
      "--worktree",
      worktree,
      "--dev-owner",
      ownerMarker,
    ],
    { cwd: worktree, env: process.env, stderr: "inherit", stdout: "inherit" },
  );
  const forward = (): void => child.kill("SIGTERM");
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  try {
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
  }
}

async function runVite(worktree: string, args: readonly string[]): Promise<void> {
  const dashboardPort = argumentValue(args, "--dashboard-port");
  const vitePort = argumentValue(args, "--vite-port");
  if (!dashboardPort || !vitePort) throw new Error("The owned Vite process is missing its ports.");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(worktree, "apps/local-dashboard/node_modules/vite/bin/vite.js"),
      "--strictPort",
      "--host",
      "127.0.0.1",
      "--port",
      vitePort,
      "--config",
      resolve(worktree, "apps/local-dashboard/vite.config.ts"),
    ],
    {
      cwd: resolve(worktree, "apps/local-dashboard"),
      env: { ...process.env, DASHBOARD_PORT: dashboardPort, VITE_PORT: vitePort },
      stderr: "inherit",
      stdout: "inherit",
    },
  );
  const forward = (): void => child.kill("SIGTERM");
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  try {
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
  }
}

async function start(worktree: string): Promise<void> {
  if (worktree !== REPOSITORY_ROOT) {
    throw new Error(
      `This checkout's dev command owns ${REPOSITORY_ROOT}; run the command from that worktree.`,
    );
  }
  const existing = await inspectDevInstance(worktree);
  if (existing.healthy === true) {
    console.log(`SelfTune HMR is already running at ${existing.manifest.urls.dashboard}`);
    return;
  }
  await removeStaleDevManifest(worktree);
  if (existsSync(devManifestPath(worktree))) {
    throw new Error(
      "This worktree has a live but unhealthy owned dev stack. Stop that process before starting another one.",
    );
  }

  process.title = encodeDevProcessTitle("supervisor", worktree);
  const claim = await claimDevPorts(worktree);
  await claim.releaseForBoot();

  const dashboardUrl = `http://127.0.0.1:${claim.ports.dashboard}`;
  const viteUrl = `http://127.0.0.1:${claim.ports.vite}`;
  const instanceId = crypto.randomUUID();
  const marker = encodeDevProcessTitle("runtime", worktree);
  const viteMarker = encodeDevProcessTitle("vite", worktree);
  const environment = {
    ...process.env,
    DASHBOARD_PORT: String(claim.ports.dashboard),
    VITE_PORT: String(claim.ports.vite),
  };
  const vite = Bun.spawn(
    [
      process.execPath,
      import.meta.filename,
      "vite",
      "--worktree",
      worktree,
      "--dashboard-port",
      String(claim.ports.dashboard),
      "--vite-port",
      String(claim.ports.vite),
      "--dev-owner",
      viteMarker,
    ],
    { cwd: worktree, env: environment, stderr: "inherit", stdout: "inherit" },
  );
  const runtime = Bun.spawn(
    [
      process.execPath,
      "--watch",
      "run",
      resolve(worktree, "apps/local/src/dashboard-server.ts"),
      "--port",
      String(claim.ports.dashboard),
      "--runtime-mode",
      "dev-server",
      "--dev-owner",
      marker,
    ],
    {
      cwd: worktree,
      env: { ...environment, SPA_PROXY_URL: viteUrl },
      stderr: "inherit",
      stdout: "inherit",
    },
  );

  const manifest: DevManifest = {
    version: 1,
    kind: "selftune-dev",
    worktree,
    urls: { dashboard: dashboardUrl, vite: viteUrl },
    ports: claim.ports,
    pids: { supervisor: process.pid, runtime: runtime.pid, vite: vite.pid },
    mode: "hmr",
    package_version: PACKAGE_VERSION,
    instance_id: instanceId,
    started_at: new Date().toISOString(),
    auth_token: randomBytes(32).toString("base64url"),
  };
  claim.authenticate(manifest);
  writeDevManifest(manifest);

  let stopping = false;
  let resolveSignal: (() => void) | undefined;
  const signal = new Promise<void>((done) => {
    resolveSignal = done;
  });
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await Promise.all([stopProcess(runtime), stopProcess(vite)]);
    removeDevManifestIfOwned(worktree, instanceId);
    await claim.close();
  };
  const handleSignal = (): void => {
    resolveSignal?.();
    void stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    const startup = await Promise.race([
      waitForHealthy(worktree).then((readyManifest) => ({
        interrupted: false as const,
        manifest: readyManifest,
      })),
      signal.then(() => ({ interrupted: true as const })),
    ]);
    if (!("manifest" in startup)) return;
    const healthy = startup.manifest;
    console.log(`SelfTune HMR ready: ${healthy.urls.dashboard}`);
    console.log(`Vite: ${healthy.urls.vite}`);
    const exited = await Promise.race([
      runtime.exited.then((code) => ({ process: "dashboard", code })),
      vite.exited.then((code) => ({ process: "Vite", code })),
    ]);
    if (!stopping)
      throw new Error(`${exited.process} exited unexpectedly with code ${exited.code}.`);
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await stop();
  }
}

async function status(worktree: string): Promise<void> {
  const current = await inspectDevInstance(worktree);
  if (current.healthy === false) {
    console.log(`SelfTune HMR is not running for ${worktree}. ${current.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`SelfTune HMR is healthy for ${worktree}`);
  console.log(`Dashboard: ${current.manifest.urls.dashboard}`);
  console.log(`Vite: ${current.manifest.urls.vite}`);
  console.log(
    `PIDs: supervisor=${current.manifest.pids.supervisor} dashboard=${current.manifest.pids.runtime} vite=${current.manifest.pids.vite}`,
  );
}

async function open(worktree: string): Promise<void> {
  const current = await inspectDevInstance(worktree);
  if (current.healthy === false) {
    throw new Error(`No owned healthy HMR instance: ${current.reason}`);
  }
  openUrl(current.manifest.urls.dashboard);
}

async function reap(worktree: string): Promise<void> {
  const processList = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const candidates = findDevProcessCandidates(processList);
  let killed = 0;
  for (const candidate of candidates) {
    if (!candidate.orphan || candidate.pid === process.pid) {
      console.log(`keep ${candidate.role} pid=${candidate.pid} worktree=${candidate.worktree}`);
      continue;
    }
    try {
      process.kill(candidate.pid, "SIGTERM");
      killed += 1;
      console.log(
        `reap orphan ${candidate.role} pid=${candidate.pid} worktree=${candidate.worktree}`,
      );
    } catch (cause) {
      console.warn(`Could not reap pid ${candidate.pid}: ${String(cause)}`);
    }
  }
  const removedManifest = await removeStaleDevManifest(worktree);
  if (killed === 0 && !removedManifest) console.log("No orphaned SelfTune dev processes found.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "start";
  const worktree = worktreeFromArgs(args);
  if (command === "start") return startOwnedSupervisor(worktree);
  if (command === "supervise") return start(worktree);
  if (command === "vite") return runVite(worktree, args);
  if (command === "status") return status(worktree);
  if (command === "open") return open(worktree);
  if (command === "reap") return reap(worktree);
  throw new Error(`Unknown dev command: ${command}. Use start, status, open, or reap.`);
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
