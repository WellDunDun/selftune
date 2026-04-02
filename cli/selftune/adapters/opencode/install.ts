#!/usr/bin/env bun
/**
 * Install selftune hooks into OpenCode environment.
 *
 * Writes a shell shim script that OpenCode calls for hook events,
 * and updates the OpenCode config to reference the shim.
 *
 * Config locations (checked in order):
 *   1. ./opencode.json           (project-level)
 *   2. ~/.config/opencode/config.json  (user-level)
 *
 * Usage: selftune opencode install [--dry-run] [--uninstall]
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIM_NAME = "selftune-opencode-hook.sh";
const SELFTUNE_TAG = "selftune-managed";
const INSTALL_STATE_FILENAME = "selftune-install-target.json";

function getHomeDirectory(): string {
  return process.env.HOME ?? homedir();
}

function getProjectConfigPath(): string {
  return join(process.cwd(), "opencode.json");
}

function getUserConfigPath(): string {
  return join(getHomeDirectory(), ".config", "opencode", "config.json");
}

function getInstallStatePath(): string {
  return join(getHomeDirectory(), ".config", "opencode", INSTALL_STATE_FILENAME);
}

function getShimPath(configPath: string): string {
  return join(dirname(configPath), SHIM_NAME);
}

// ---------------------------------------------------------------------------
// Shim content
// ---------------------------------------------------------------------------

function buildShimContent(): string {
  return `#!/bin/bash
# ${SELFTUNE_TAG} — Written by selftune. Do not edit.
# Pipes OpenCode hook events to selftune for processing.
if [ -n "$SELFTUNE_CLI_PATH" ]; then exec "$SELFTUNE_CLI_PATH" opencode hook
elif command -v bunx >/dev/null 2>&1; then cat | bunx selftune opencode hook
else cat | npx -y selftune@latest opencode hook; fi
`;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface OpenCodeAgentConfig {
  description?: string;
  mode?: string;
  model?: string;
  prompt?: string;
  tools?: Record<string, boolean>;
  /** Marker so selftune can identify its own agent entries. */
  _selftune?: boolean;
}

interface OpenCodeConfig {
  hooks?: Record<string, { command?: string }>;
  agent?: Record<string, OpenCodeAgentConfig>;
  [key: string]: unknown;
}

interface OpenCodeInstallState {
  configPath: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectConfigPath(): string {
  const projectConfig = getProjectConfigPath();
  if (existsSync(projectConfig)) return projectConfig;
  return getUserConfigPath();
}

function readConfig(configPath: string): OpenCodeConfig {
  if (!existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(
      `OpenCode config at ${configPath} is not valid JSON; refusing to overwrite it.`,
    );
  }

  if (!isPlainRecord(parsed)) {
    throw new Error(
      `OpenCode config at ${configPath} must be a JSON object; refusing to overwrite it.`,
    );
  }
  if (parsed.hooks !== undefined && !isPlainRecord(parsed.hooks)) {
    throw new Error(
      `OpenCode config at ${configPath} has a non-object "hooks" field; refusing to overwrite it.`,
    );
  }
  if (parsed.agent !== undefined && !isPlainRecord(parsed.agent)) {
    throw new Error(
      `OpenCode config at ${configPath} has a non-object "agent" field; refusing to overwrite it.`,
    );
  }

  return parsed as OpenCodeConfig;
}

function writeConfig(configPath: string, config: OpenCodeConfig): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function readInstallState(): OpenCodeInstallState | null {
  const installStatePath = getInstallStatePath();
  if (!existsSync(installStatePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(installStatePath, "utf-8")) as unknown;
    if (
      !isPlainRecord(parsed) ||
      typeof parsed.configPath !== "string" ||
      parsed.configPath.length === 0
    ) {
      return null;
    }
    return { configPath: parsed.configPath };
  } catch {
    return null;
  }
}

function writeInstallState(state: OpenCodeInstallState): void {
  const installStatePath = getInstallStatePath();
  mkdirSync(dirname(installStatePath), { recursive: true });
  writeFileSync(installStatePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function clearInstallState(): void {
  rmSync(getInstallStatePath(), { force: true });
}

// ---------------------------------------------------------------------------
// Install logic
// ---------------------------------------------------------------------------

interface InstallOptions {
  dryRun: boolean;
  uninstall: boolean;
}

interface HookSkip {
  event: (typeof HOOK_EVENTS)[number];
  command: string;
}

interface AgentSkip {
  name: string;
}

export interface OpenCodeInstallResult {
  configPath: string;
  shimPath: string;
  dryRun: boolean;
  shimChanged: boolean;
  configChanged: boolean;
  installedHooks: (typeof HOOK_EVENTS)[number][];
  unchangedHooks: (typeof HOOK_EVENTS)[number][];
  skippedHooks: HookSkip[];
  installedAgents: string[];
  unchangedAgents: string[];
  skippedAgents: AgentSkip[];
}

export interface OpenCodeUninstallTargetResult {
  configPath: string;
  shimPath: string;
  viaInstallState: boolean;
  removedHooks: (typeof HOOK_EVENTS)[number][];
  removedAgents: string[];
  shimRemoved: boolean;
}

export interface OpenCodeUninstallResult {
  dryRun: boolean;
  targets: OpenCodeUninstallTargetResult[];
  installStateCleared: boolean;
}

const KNOWN_FLAGS = new Set(["--dry-run", "--uninstall", "--help", "-h"]);

function parseFlags(args: string[]): InstallOptions | null {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: selftune opencode install [--dry-run] [--uninstall]

Options:
  --dry-run      Preview changes without writing to disk
  --uninstall    Remove selftune hooks and agents from OpenCode config
  --help, -h     Show this help message`);
    return null;
  }

  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`[selftune] Unknown flag(s): ${unknown.join(", ")}`);
    console.error(`Run 'selftune opencode install --help' for usage.`);
    process.exit(1);
  }

  return {
    dryRun: args.includes("--dry-run"),
    uninstall: args.includes("--uninstall"),
  };
}

const HOOK_EVENTS = ["tool.execute.before", "tool.execute.after", "session.idle"] as const;

// ---------------------------------------------------------------------------
// Agent registration
// ---------------------------------------------------------------------------

/** Map Claude Code tool names to OpenCode tool permissions. */
function mapToolPermissions(tools?: string[], disallowed?: string[]): Record<string, boolean> {
  const defaults: Record<string, boolean> = {
    write: false,
    edit: false,
    bash: true,
  };

  if (tools) {
    if (tools.includes("Write")) defaults.write = true;
    if (tools.includes("Edit")) defaults.edit = true;
    if (!tools.includes("Bash")) defaults.bash = false;
  }

  if (disallowed) {
    if (disallowed.includes("Write")) defaults.write = false;
    if (disallowed.includes("Edit")) defaults.edit = false;
    if (disallowed.includes("Bash")) defaults.bash = false;
  }

  return defaults;
}

/** OpenCode model format (provider/model). */
const OPENCODE_MODEL_MAP: Record<string, string> = {
  haiku: "anthropic/claude-haiku-4-5-20251001",
  sonnet: "anthropic/claude-sonnet-4-20250514",
  opus: "anthropic/claude-opus-4-20250514",
};

interface AgentFrontmatter {
  name: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
}

/** Parse YAML-like frontmatter from agent markdown files. */
function parseFrontmatter(content: string): AgentFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  if (!fm.name) return null;

  return {
    name: fm.name,
    description: fm.description,
    tools: fm.tools ? fm.tools.split(",").map((t) => t.trim()) : undefined,
    disallowedTools: fm.disallowedTools
      ? fm.disallowedTools.split(",").map((t) => t.trim())
      : undefined,
    model: fm.model,
  };
}

const BUNDLED_AGENT_DIR = resolve(
  dirname(import.meta.path),
  "..",
  "..",
  "..",
  "..",
  "skill",
  "agents",
);

/** Discover agent definitions from skill/agents/ and build OpenCode agent config entries. */
export function buildAgentEntries(
  agentsDir: string = BUNDLED_AGENT_DIR,
): Record<string, OpenCodeAgentConfig> {
  const entries: Record<string, OpenCodeAgentConfig> = {};

  if (!existsSync(agentsDir)) return entries;

  const files = readdirSync(agentsDir).filter((f: string) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(agentsDir, file);
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    // Strip frontmatter to get the body as the prompt
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

    entries[fm.name] = {
      description: fm.description,
      mode: "subagent",
      model: fm.model ? (OPENCODE_MODEL_MAP[fm.model] ?? fm.model) : undefined,
      prompt: body,
      tools: mapToolPermissions(fm.tools, fm.disallowedTools),
      _selftune: true,
    };
  }

  return entries;
}

function getCandidateUninstallConfigPaths(): string[] {
  const recordedConfig = readInstallState()?.configPath;
  const candidates = [recordedConfig, getProjectConfigPath(), getUserConfigPath()].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return [...new Set(candidates)];
}

export function installHooks(options: { dryRun?: boolean } = {}): OpenCodeInstallResult {
  const dryRun = options.dryRun ?? false;
  const configPath = detectConfigPath();
  const shimDir = dirname(configPath);
  const shimPath = getShimPath(configPath);
  const agentEntries = buildAgentEntries();
  const config = readConfig(configPath);
  const installedHooks: (typeof HOOK_EVENTS)[number][] = [];
  const unchangedHooks: (typeof HOOK_EVENTS)[number][] = [];
  const skippedHooks: HookSkip[] = [];
  const installedAgents: string[] = [];
  const unchangedAgents: string[] = [];
  const skippedAgents: AgentSkip[] = [];
  let configChanged = false;

  const shimContent = buildShimContent();
  const shimChanged = !existsSync(shimPath) || readFileSync(shimPath, "utf-8") !== shimContent;

  let nextHooks = config.hooks;
  for (const event of HOOK_EVENTS) {
    const existing = nextHooks?.[event];
    if (existing?.command && existing.command !== shimPath) {
      skippedHooks.push({ event, command: existing.command });
      continue;
    }

    if (existing?.command === shimPath) {
      unchangedHooks.push(event);
      continue;
    }

    if (!nextHooks) {
      nextHooks = {};
      config.hooks = nextHooks;
    }
    nextHooks[event] = { command: shimPath };
    installedHooks.push(event);
    configChanged = true;
  }

  let nextAgents = config.agent;
  for (const [name, entry] of Object.entries(agentEntries)) {
    const existing = nextAgents?.[name];
    if (existing && !existing._selftune) {
      skippedAgents.push({ name });
      continue;
    }

    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
      unchangedAgents.push(name);
      continue;
    }

    if (!nextAgents) {
      nextAgents = {};
      config.agent = nextAgents;
    }
    nextAgents[name] = entry;
    installedAgents.push(name);
    configChanged = true;
  }

  const managesAnyHook = installedHooks.length > 0 || unchangedHooks.length > 0;

  if (!dryRun) {
    if (managesAnyHook && shimChanged) {
      if (!existsSync(shimDir)) {
        mkdirSync(shimDir, { recursive: true });
      }
      writeFileSync(shimPath, shimContent, { mode: 0o755 });
    }
    if (configChanged) {
      writeConfig(configPath, config);
    }
    if (
      installedHooks.length > 0 ||
      unchangedHooks.length > 0 ||
      installedAgents.length > 0 ||
      unchangedAgents.length > 0
    ) {
      writeInstallState({ configPath });
    }
  }

  return {
    configPath,
    shimPath,
    dryRun,
    shimChanged,
    configChanged,
    installedHooks,
    unchangedHooks,
    skippedHooks,
    installedAgents,
    unchangedAgents,
    skippedAgents,
  };
}

export function uninstallHooks(options: { dryRun?: boolean } = {}): OpenCodeUninstallResult {
  const dryRun = options.dryRun ?? false;
  const installState = readInstallState();
  const targets: OpenCodeUninstallTargetResult[] = [];

  for (const configPath of getCandidateUninstallConfigPaths()) {
    const viaInstallState = installState?.configPath === configPath;
    const shimPath = getShimPath(configPath);
    const configExists = existsSync(configPath);
    const shimExists = existsSync(shimPath);
    const removedHooks: (typeof HOOK_EVENTS)[number][] = [];
    const removedAgents: string[] = [];
    let config = configExists ? readConfig(configPath) : null;

    for (const event of HOOK_EVENTS) {
      if (config?.hooks?.[event]?.command === shimPath) {
        removedHooks.push(event);
      }
    }

    if (!viaInstallState && removedHooks.length === 0) {
      continue;
    }

    if (config?.hooks) {
      for (const event of removedHooks) {
        delete config.hooks[event];
      }
      if (Object.keys(config.hooks).length === 0) {
        delete config.hooks;
      }
    }

    if (config?.agent) {
      for (const [name, entry] of Object.entries(config.agent)) {
        if (!entry?._selftune) continue;
        removedAgents.push(name);
        delete config.agent[name];
      }
      if (Object.keys(config.agent).length === 0) {
        delete config.agent;
      }
    }

    if (!dryRun && config && (removedHooks.length > 0 || removedAgents.length > 0)) {
      writeConfig(configPath, config);
    }
    if (!dryRun && removedHooks.length > 0 && shimExists) {
      unlinkSync(shimPath);
    }

    targets.push({
      configPath,
      shimPath,
      viaInstallState,
      removedHooks,
      removedAgents,
      shimRemoved: shimExists,
    });
  }

  if (!dryRun && (targets.length > 0 || installState !== null)) {
    clearInstallState();
  }

  return {
    dryRun,
    targets,
    installStateCleared: !dryRun && (targets.length > 0 || installState !== null),
  };
}

function doInstall(options: InstallOptions): void {
  const result = installHooks({ dryRun: options.dryRun });

  console.log(`[selftune] OpenCode install target: ${result.configPath}`);
  console.log(
    `[selftune] Shim ${options.dryRun ? (result.shimChanged ? "would be written" : "already current") : result.shimChanged ? "written" : "already current"}: ${result.shimPath}`,
  );

  if (result.installedHooks.length > 0) {
    console.log(`[selftune] Hooks ${options.dryRun ? "to install/update" : "installed/updated"}:`);
    for (const event of result.installedHooks) {
      console.log(`  ${event} -> ${result.shimPath}`);
    }
  }
  if (result.unchangedHooks.length > 0) {
    console.log(`[selftune] Hooks already configured:`);
    for (const event of result.unchangedHooks) {
      console.log(`  ${event} -> ${result.shimPath}`);
    }
  }
  if (result.skippedHooks.length > 0) {
    console.log(`[selftune] Hooks skipped due to conflicting commands:`);
    for (const hook of result.skippedHooks) {
      console.log(`  ${hook.event} -> ${hook.command}`);
    }
  }

  if (result.installedAgents.length > 0) {
    console.log(
      `[selftune] Agents ${options.dryRun ? "to register/update" : "registered/updated"}:`,
    );
    for (const name of result.installedAgents) {
      console.log(`  ${name}`);
    }
  }
  if (result.unchangedAgents.length > 0) {
    console.log(`[selftune] Agents already configured:`);
    for (const name of result.unchangedAgents) {
      console.log(`  ${name}`);
    }
  }
  if (result.skippedAgents.length > 0) {
    console.log(`[selftune] Agents skipped because a user-defined entry already exists:`);
    for (const agent of result.skippedAgents) {
      console.log(`  ${agent.name}`);
    }
  }

  if (options.dryRun) {
    console.log(`[selftune] No changes written (--dry-run).`);
  }
}

function doUninstall(options: InstallOptions): void {
  const result = uninstallHooks({ dryRun: options.dryRun });

  if (result.targets.length === 0) {
    console.log(`[selftune] No matching OpenCode hook installation found.`);
  }

  for (const target of result.targets) {
    console.log(
      `[selftune] ${options.dryRun ? "Would clean" : "Cleaned"} ${target.configPath}${target.viaInstallState ? " (recorded install target)" : ""}`,
    );
    if (target.removedHooks.length > 0) {
      console.log(`[selftune] Hooks ${options.dryRun ? "to remove" : "removed"}:`);
      for (const event of target.removedHooks) {
        console.log(`  ${event} -> ${target.shimPath}`);
      }
    }
    if (target.removedAgents.length > 0) {
      console.log(`[selftune] Agents ${options.dryRun ? "to remove" : "removed"}:`);
      for (const name of target.removedAgents) {
        console.log(`  ${name}`);
      }
    }
    console.log(
      `[selftune] Shim ${options.dryRun ? (target.shimRemoved ? "would be removed" : "not present") : target.shimRemoved ? "removed" : "not present"}: ${target.shimPath}`,
    );
  }

  if (options.dryRun) {
    console.log(`[selftune] No changes written (--dry-run).`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseFlags(args);
  if (!options) return; // --help was shown

  if (options.uninstall) {
    doUninstall(options);
  } else {
    doInstall(options);
  }
}

// ---------------------------------------------------------------------------
// stdin main (only when executed directly, not when imported)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    await cliMain();
  } catch (err) {
    console.error(
      `[selftune] OpenCode install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
