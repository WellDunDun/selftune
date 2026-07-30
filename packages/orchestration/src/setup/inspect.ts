import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { loadConfig, resolveSelftunePaths, type SelftuneConfig } from "@selftune/config";
import { harnessRegistry } from "@selftune/harness-registry";
import { checkAgentFiles } from "@selftune/runtime/claude-agents";
import { checkClaudeCodeHooks } from "@selftune/runtime/init/claude-hooks";
import { detectAgentType } from "@selftune/runtime/init/environment";
import {
  buildInstallPlan,
  selectInstallFormat,
  type ScheduleFormat,
} from "@selftune/runtime/scheduling";
import { detectAgent } from "@selftune/runtime/utils/llm-call";
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { HookHarnessId, SetupHarnessId } from "./plan.js";

export interface SetupHarnessState {
  readonly detected: boolean;
  readonly hooksSupported: boolean;
  readonly hooksInstalled: boolean;
}

export interface SetupScheduleState {
  readonly format: ScheduleFormat | null;
  readonly installed: boolean;
  readonly artifacts: ReadonlyArray<string>;
}

export interface SetupState {
  readonly config: SelftuneConfig | null;
  readonly agentType: SelftuneConfig["agent_type"];
  readonly agentCli: string | null;
  readonly harnesses: Readonly<Record<SetupHarnessId, SetupHarnessState>>;
  readonly agentFilesInstalled: boolean;
  readonly schedule: SetupScheduleState;
}

export interface SetupEnvironment {
  readonly homeDir?: string;
  readonly configDir?: string;
  readonly configPath?: string;
  readonly ignoreExistingConfig?: boolean;
  readonly agentOverride?: string;
  readonly scheduleFormat?: string;
  readonly platform?: NodeJS.Platform;
  readonly which?: (command: string) => string | null;
  readonly detectAgentCli?: () => string | null;
  readonly scheduleActive?: (format: ScheduleFormat, artifacts: ReadonlyArray<string>) => boolean;
  readonly reconcileHookHarnesses?: ReadonlyArray<HookHarnessId>;
  readonly reconcileSchedule?: boolean;
  readonly now?: () => Date;
}

function defaultWhich(command: string): string | null {
  try {
    return Bun.which(command) ?? null;
  } catch {
    return null;
  }
}

function scheduleState(
  homeDir: string,
  requestedFormat: string | undefined,
  platform: NodeJS.Platform,
  active: (format: ScheduleFormat, artifacts: ReadonlyArray<string>) => boolean,
): SetupScheduleState {
  const selected = selectInstallFormat(requestedFormat, platform);
  if (!selected.ok) return { format: null, installed: false, artifacts: [] };

  const plan = buildInstallPlan(selected.format, homeDir);
  const artifactsCurrent = plan.artifacts.every((artifact) => {
    if (!existsSync(artifact.path)) return false;
    try {
      return readFileSync(artifact.path, "utf8") === artifact.content;
    } catch {
      return false;
    }
  });
  return {
    format: selected.format,
    installed:
      artifactsCurrent &&
      active(
        selected.format,
        plan.artifacts.map((artifact) => artifact.path),
      ),
    artifacts: plan.artifacts.map((artifact) => artifact.path),
  };
}

function defaultScheduleActive(format: ScheduleFormat, artifacts: ReadonlyArray<string>): boolean {
  if (format === "cron") {
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    if (current.status !== 0) return false;
    const artifact = artifacts[0];
    if (!artifact) return false;
    try {
      return current.stdout.includes(readFileSync(artifact, "utf8").trim());
    } catch {
      return false;
    }
  }

  if (format === "launchd") {
    const userId = process.getuid?.() ?? 0;
    return artifacts.every((artifact) => {
      const label = basename(artifact, ".plist");
      return spawnSync("launchctl", ["print", `gui/${userId}/${label}`]).status === 0;
    });
  }

  return artifacts
    .filter((artifact) => artifact.endsWith(".timer"))
    .every(
      (artifact) =>
        spawnSync("systemctl", ["--user", "is-active", "--quiet", basename(artifact)]).status === 0,
    );
}

const harnessRuntimes = harnessRegistry.contributions.map(({ runtime }) => runtime);

function emptyHarnessState(): SetupHarnessState {
  return { detected: false, hooksSupported: false, hooksInstalled: false };
}

function isSetupHarnessId(value: string): value is SetupHarnessId {
  switch (value) {
    case "claude_code":
    case "cline":
    case "codex":
    case "opencode":
    case "openclaw":
    case "pi":
      return true;
    default:
      return false;
  }
}

function inspectHarnesses(
  homeDir: string,
  which: (command: string) => string | null,
): Record<SetupHarnessId, SetupHarnessState> {
  const result: Record<SetupHarnessId, SetupHarnessState> = {
    claude_code: emptyHarnessState(),
    cline: emptyHarnessState(),
    codex: emptyHarnessState(),
    opencode: emptyHarnessState(),
    openclaw: emptyHarnessState(),
    pi: emptyHarnessState(),
  };
  for (const runtime of harnessRuntimes) {
    if (!isSetupHarnessId(runtime.id)) continue;
    const detected = runtime.detectConnection?.({ homeDir, which });
    result[runtime.id] = {
      detected: detected?.detected ?? false,
      hooksSupported: detected?.hooks_supported ?? false,
      hooksInstalled: detected?.hooks_installed ?? false,
    };
  }
  result.claude_code = {
    ...result.claude_code,
    hooksInstalled: checkClaudeCodeHooks(join(homeDir, ".claude", "settings.json")),
  };
  return result;
}

export function resolveSetupConfigPath(env: SetupEnvironment): string {
  if (env.configPath) return env.configPath;
  if (env.configDir) return join(env.configDir, "config.json");
  return resolveSelftunePaths({
    environment: {
      SELFTUNE_CONFIG_DIR: process.env.SELFTUNE_CONFIG_DIR,
      SELFTUNE_HOME: process.env.SELFTUNE_HOME,
    },
    homeDirectory: env.homeDir ?? homedir(),
  }).configPath;
}

export async function inspectSetupState(env: SetupEnvironment = {}): Promise<SetupState> {
  const homeDir = env.homeDir ?? homedir();
  const configPath = resolveSetupConfigPath(env);
  const config = env.ignoreExistingConfig
    ? null
    : await Effect.runPromise(loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer)));
  const which = env.which ?? defaultWhich;
  const harnesses = inspectHarnesses(homeDir, which);
  for (const harnessId of env.reconcileHookHarnesses ?? []) {
    harnesses[harnessId] = { ...harnesses[harnessId], hooksInstalled: false };
  }

  return {
    config,
    agentType: detectAgentType(env.agentOverride, homeDir),
    agentCli: (env.detectAgentCli ?? detectAgent)(),
    harnesses,
    agentFilesInstalled: checkAgentFiles({ homeDir }),
    schedule: env.reconcileSchedule
      ? { format: null, installed: false, artifacts: [] }
      : scheduleState(
          homeDir,
          env.scheduleFormat,
          env.platform ?? process.platform,
          env.scheduleActive ?? defaultScheduleActive,
        ),
  };
}
