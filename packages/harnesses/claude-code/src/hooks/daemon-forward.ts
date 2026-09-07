import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { HookExecutionResult } from "./execution-result.js";

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

const ServerManifestPreview = Schema.Struct({
  origin: Schema.String,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(1)),
  port: Schema.Number.check(Schema.isInt()),
});
const AuthRecordPreview = Schema.Struct({ token: Schema.String.check(Schema.isMinLength(32)) });

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

function readForwardTarget(configDir: string) {
  try {
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(ServerManifestPreview))(
      readFileSync(join(configDir, "server-control", "server.json"), "utf8"),
    );
    const auth = Schema.decodeUnknownSync(Schema.fromJsonString(AuthRecordPreview))(
      readFileSync(join(configDir, "server-control", "auth.json"), "utf8"),
    );
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

    return { manifest, token: auth.token };
  } catch {
    return null;
  }
}

/** Returns null for every forwarding failure so callers can run the local hook unchanged. */
export async function forwardHookToDaemon(
  hookName: ClaudeHookName,
  rawStdin: string,
  configDir: string = resolveForwardConfigDir(),
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<HookExecutionResult | null> {
  const target = readForwardTarget(configDir);
  if (!target) return null;

  try {
    const timeoutMs = SYNCHRONOUS_HOOKS.has(hookName) ? 1_500 : 750;
    const response = await request(new URL(`/api/hooks/${hookName}`, target.manifest.origin), {
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
    const result = Schema.decodeUnknownOption(HookExecutionResult)(await response.json());
    return Option.getOrNull(result);
  } catch {
    return null;
  }
}
