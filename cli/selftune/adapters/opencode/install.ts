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

const PROJECT_CONFIG = join(process.cwd(), "opencode.json");
const USER_CONFIG = join(homedir(), ".config", "opencode", "config.json");

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
}

interface OpenCodeConfig {
  hooks?: Record<string, { command?: string }>;
  agent?: Record<string, OpenCodeAgentConfig>;
  [key: string]: unknown;
}

function detectConfigPath(): string {
  if (existsSync(PROJECT_CONFIG)) return PROJECT_CONFIG;
  return USER_CONFIG;
}

function readConfig(configPath: string): OpenCodeConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as OpenCodeConfig;
  } catch {
    throw new Error(
      `OpenCode config at ${configPath} is not valid JSON; refusing to overwrite it.`,
    );
  }
}

function writeConfig(configPath: string, config: OpenCodeConfig): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Install logic
// ---------------------------------------------------------------------------

interface InstallOptions {
  dryRun: boolean;
  uninstall: boolean;
}

function parseFlags(args: string[]): InstallOptions {
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
function buildAgentEntries(
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
    };
  }

  return entries;
}

function doInstall(options: InstallOptions): void {
  const configPath = detectConfigPath();
  const shimDir = dirname(configPath);
  const shimPath = join(shimDir, SHIM_NAME);

  const agentEntries = buildAgentEntries();

  if (options.dryRun) {
    console.log(`[selftune] dry-run: would write shim to ${shimPath}`);
    console.log(`[selftune] dry-run: would update config at ${configPath}`);
    for (const event of HOOK_EVENTS) {
      console.log(`[selftune] dry-run: would register hook for ${event}`);
    }
    for (const name of Object.keys(agentEntries)) {
      console.log(`[selftune] dry-run: would register agent '${name}'`);
    }
    return;
  }

  // Validate config before touching filesystem (readConfig throws on invalid JSON)
  const config = readConfig(configPath);

  // Write shim script
  if (!existsSync(shimDir)) {
    mkdirSync(shimDir, { recursive: true });
  }
  writeFileSync(shimPath, buildShimContent(), { mode: 0o755 });
  if (!config.hooks) {
    config.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    const existing = config.hooks[event];
    if (existing?.command && existing.command !== shimPath) {
      console.log(
        `[selftune] Warning: hook '${event}' already configured (${existing.command}); skipping.`,
      );
      continue;
    }
    config.hooks[event] = { command: shimPath };
  }

  // Register selftune agents for eval/optimizer workflows
  if (Object.keys(agentEntries).length > 0) {
    if (!config.agent) {
      config.agent = {};
    }
    for (const [name, entry] of Object.entries(agentEntries)) {
      config.agent[name] = entry;
    }
  }

  writeConfig(configPath, config);

  console.log(`[selftune] Installed OpenCode hooks:`);
  console.log(`  shim: ${shimPath}`);
  console.log(`  config: ${configPath}`);
  for (const event of HOOK_EVENTS) {
    console.log(`  ${event} -> ${shimPath}`);
  }
  if (Object.keys(agentEntries).length > 0) {
    console.log(`[selftune] Registered agents:`);
    for (const name of Object.keys(agentEntries)) {
      console.log(`  ${name}`);
    }
  }
}

function doUninstall(options: InstallOptions): void {
  const configPath = detectConfigPath();
  const shimDir = dirname(configPath);
  const shimPath = join(shimDir, SHIM_NAME);

  if (options.dryRun) {
    console.log(`[selftune] dry-run: would remove shim at ${shimPath}`);
    console.log(`[selftune] dry-run: would remove hook entries from ${configPath}`);
    return;
  }

  // Remove shim
  if (existsSync(shimPath)) {
    unlinkSync(shimPath);
    console.log(`[selftune] Removed shim: ${shimPath}`);
  }

  // Remove hook entries and agent entries from config
  if (existsSync(configPath)) {
    const config = readConfig(configPath);
    if (config.hooks) {
      for (const event of HOOK_EVENTS) {
        if (config.hooks[event]?.command !== shimPath) continue;
        delete config.hooks[event];
      }
      if (Object.keys(config.hooks).length === 0) {
        delete config.hooks;
      }
    }

    // Remove selftune-managed agents
    if (config.agent) {
      const agentEntries = buildAgentEntries();
      for (const name of Object.keys(agentEntries)) {
        delete config.agent[name];
      }
      if (Object.keys(config.agent).length === 0) {
        delete config.agent;
      }
    }

    writeConfig(configPath, config);
    console.log(`[selftune] Removed hook and agent entries from: ${configPath}`);
  }

  console.log(`[selftune] OpenCode hooks and agents uninstalled.`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseFlags(args);

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
