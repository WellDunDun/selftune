import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HookExecutionResult } from "./execution-result.js";

export const CLAUDE_HOOK_NAMES = [
  "prompt-log",
  "auto-activate",
  "skill-change-guard",
  "evolution-guard",
  "skill-edit-capture",
  "skill-eval",
  "commit-track",
  "session-stop",
] as const;

export type ClaudeHookName = (typeof CLAUDE_HOOK_NAMES)[number];

const SYNCHRONOUS_HOOKS: ReadonlySet<ClaudeHookName> = new Set([
  "auto-activate",
  "skill-change-guard",
  "evolution-guard",
]);

interface ServerManifestPreview {
  readonly origin: string;
  readonly pid: number;
  readonly port: number;
}

interface AuthRecordPreview {
  readonly token: string;
}

function presentPath(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Mirrors packages/config/src/paths.ts and must stay in sync with its path policy. */
export function resolveForwardConfigDir(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configOverride = presentPath(environment.SELFTUNE_CONFIG_DIR);
  const selftuneHome = presentPath(environment.SELFTUNE_HOME);
  return configOverride ?? join(selftuneHome ?? homeDirectory, ".selftune");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readForwardTarget(configDir: string): {
  manifest: ServerManifestPreview;
  token: string;
} | null {
  try {
    const manifestValue = readJson(join(configDir, "server-control", "server.json"));
    const authValue = readJson(join(configDir, "server-control", "auth.json"));
    if (
      typeof manifestValue !== "object" ||
      manifestValue === null ||
      !("pid" in manifestValue) ||
      !Number.isSafeInteger(manifestValue.pid) ||
      (manifestValue.pid as number) <= 1 ||
      !("port" in manifestValue) ||
      !Number.isSafeInteger(manifestValue.port) ||
      !("origin" in manifestValue) ||
      typeof manifestValue.origin !== "string" ||
      typeof authValue !== "object" ||
      authValue === null ||
      !("token" in authValue) ||
      typeof authValue.token !== "string" ||
      authValue.token.length < 32
    ) {
      return null;
    }

    const manifest = manifestValue as ServerManifestPreview;
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

    try {
      process.kill(manifest.pid, 0);
    } catch {
      return null;
    }

    return { manifest, token: (authValue as AuthRecordPreview).token };
  } catch {
    return null;
  }
}

function isHookExecutionResult(value: unknown): value is HookExecutionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "exit_code" in value &&
    Number.isInteger(value.exit_code) &&
    "stdout" in value &&
    typeof value.stdout === "string" &&
    "stderr" in value &&
    typeof value.stderr === "string"
  );
}

/** Returns null for every forwarding failure so callers can run the local hook unchanged. */
export async function forwardHookToDaemon(
  hookName: ClaudeHookName,
  rawStdin: string,
  configDir: string = resolveForwardConfigDir(),
): Promise<HookExecutionResult | null> {
  const target = readForwardTarget(configDir);
  if (!target) return null;

  try {
    const timeoutMs = SYNCHRONOUS_HOOKS.has(hookName) ? 1_500 : 750;
    const response = await fetch(new URL(`/api/hooks/${hookName}`, target.manifest.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: rawStdin,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 202) return { exit_code: 0, stdout: "", stderr: "" };
    if (response.status !== 200) return null;
    const result: unknown = await response.json();
    return isHookExecutionResult(result) ? result : null;
  } catch {
    return null;
  }
}
