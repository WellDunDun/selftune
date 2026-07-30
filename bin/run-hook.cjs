#!/usr/bin/env node
/**
 * Hook runner — executes a TypeScript hook script via Bun.
 *
 * Usage: bun run-hook.cjs <path-to-hook.ts>
 * Legacy settings may continue to use: node run-hook.cjs <path-to-hook.ts>
 *
 * Stdin is first offered to a running authenticated SelfTune daemon, then
 * piped through to the hook script if forwarding is unavailable. Exit code is
 * propagated from synchronous hooks. If bun is not found, exits 0 (fail-open:
 * hooks must never block Claude).
 *
 * Note: selftune hooks depend on Bun-specific APIs (Bun.stdin.text(),
 * Bun.spawn()) and cannot run under tsx/node. The runner itself stays valid
 * CommonJS so current `bun run-hook.cjs` settings and legacy
 * `node run-hook.cjs` settings both forward to the daemon or fall back to
 * spawning the hook with Bun.
 */

const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const { basename, join } = require("path");
const hookScript = process.argv[2];

const HOOK_NAMES = new Set([
  "prompt-log",
  "auto-activate",
  "skill-change-guard",
  "evolution-guard",
  "skill-eval",
  "commit-track",
  "session-stop",
]);
const SYNCHRONOUS_HOOKS = new Set(["auto-activate", "skill-change-guard", "evolution-guard"]);

function presentPath(value) {
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Mirrors packages/config/src/paths.ts and must stay in sync with its path policy. */
function resolveConfigDir() {
  const configOverride = presentPath(process.env.SELFTUNE_CONFIG_DIR);
  const selftuneHome = presentPath(process.env.SELFTUNE_HOME);
  return configOverride ?? join(selftuneHome ?? homedir(), ".selftune");
}

function daemonTarget() {
  try {
    const controlDir = join(resolveConfigDir(), "server-control");
    const manifest = JSON.parse(readFileSync(join(controlDir, "server.json"), "utf8"));
    const auth = JSON.parse(readFileSync(join(controlDir, "auth.json"), "utf8"));
    if (
      !Number.isSafeInteger(manifest.pid) ||
      manifest.pid <= 1 ||
      !Number.isSafeInteger(manifest.port) ||
      typeof manifest.origin !== "string" ||
      typeof auth.token !== "string" ||
      auth.token.length < 32
    ) {
      return null;
    }
    const origin = new URL(manifest.origin);
    const loopback =
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "localhost" ||
      origin.hostname === "[::1]";
    if (
      origin.protocol !== "http:" ||
      !loopback ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.port !== String(manifest.port)
    ) {
      return null;
    }
    process.kill(manifest.pid, 0);
    return { origin: manifest.origin, token: auth.token };
  } catch {
    return null;
  }
}

async function forwardToDaemon(hookName, rawStdin) {
  const target = daemonTarget();
  if (!target) return null;
  try {
    const response = await fetch(new URL(`/api/hooks/${hookName}`, target.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: rawStdin,
      signal: AbortSignal.timeout(SYNCHRONOUS_HOOKS.has(hookName) ? 1500 : 750),
    });
    if (response.status === 202) return { exit_code: 0, stdout: "", stderr: "" };
    if (response.status !== 200) return null;
    const result = await response.json();
    if (
      !Number.isInteger(result.exit_code) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

async function main() {
  if (!hookScript) return;

  const rawStdin = readFileSync(0, "utf8");
  const hookName = basename(hookScript).replace(/\.ts$/, "");
  if (HOOK_NAMES.has(hookName)) {
    const forwarded = await forwardToDaemon(hookName, rawStdin);
    if (forwarded) {
      if (forwarded.stdout) process.stdout.write(forwarded.stdout);
      if (forwarded.stderr) process.stderr.write(forwarded.stderr);
      process.exitCode = forwarded.exit_code;
      return;
    }
  }

  try {
    execFileSync("bun", ["run", hookScript], {
      input: rawStdin,
      stdio: ["pipe", "inherit", "inherit"],
    });
    process.exitCode = 0;
  } catch (e) {
    // Hook exited non-zero → propagate (e.g. exit 2 = block in PreToolUse)
    if (e.status != null) {
      process.exitCode = e.status;
      return;
    }
    // bun not found (ENOENT) — fail-open
    process.exitCode = 0;
  }
}

void main();
