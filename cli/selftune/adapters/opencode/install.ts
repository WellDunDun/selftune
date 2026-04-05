#!/usr/bin/env bun
/**
 * Install selftune hooks into OpenCode environment.
 *
 * OpenCode uses a plugin system for hooks and a strict config schema.
 * This installer:
 *   1. Writes a plugin file (selftune-opencode-plugin.ts) that hooks into
 *      tool.execute.before, tool.execute.after, and session.idle events
 *   2. Registers the plugin in the OpenCode config's `plugin` array
 *   3. Registers selftune agents in the `agent` config key
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

const PLUGIN_FILENAME = "selftune-opencode-plugin.ts";
const SELFTUNE_AGENT_PREFIX = "[selftune]";

function getProjectConfigPath(): string {
  return join(process.cwd(), "opencode.json");
}

function getUserConfigPath(): string {
  return join(process.env.HOME ?? homedir(), ".config", "opencode", "config.json");
}

// ---------------------------------------------------------------------------
// Plugin content
// ---------------------------------------------------------------------------

function buildPluginContent(): string {
  return `// selftune-managed — Written by selftune. Do not edit.
// OpenCode plugin that pipes hook events to selftune for processing.
// Registered via "plugin" array in opencode.json or ~/.config/opencode/config.json.

export const SelftunePlugin = async ({ $ }) => {
  const resolveSelftune = () => {
    if (process.env.SELFTUNE_CLI_PATH) return process.env.SELFTUNE_CLI_PATH;
    try {
      const result = Bun.spawnSync(["which", "selftune"]);
      const path = result.stdout?.toString().trim();
      if (path) return path;
    } catch {}
    return "npx -y selftune@latest";
  };

  const selftuneBin = resolveSelftune();

  return {
    "tool.execute.before": async (input, output) => {
      try {
        const payload = JSON.stringify({
          event: "tool.execute.before",
          session_id: input.metadata?.sessionId ?? "unknown",
          tool: { name: input.tool, args: output.args },
          cwd: input.metadata?.cwd,
        });
        await $\`echo \${payload} | \${selftuneBin} opencode hook\`.quiet();
      } catch {}
    },

    "tool.execute.after": async (input, output) => {
      try {
        const payload = JSON.stringify({
          event: "tool.execute.after",
          session_id: input.metadata?.sessionId ?? "unknown",
          tool: { name: input.tool, args: input.args, result: output.result },
          cwd: input.metadata?.cwd,
        });
        await $\`echo \${payload} | \${selftuneBin} opencode hook\`.quiet();
      } catch {}
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        try {
          const payload = JSON.stringify({
            event: "session.idle",
            session_id: event.properties?.sessionId ?? "unknown",
            cwd: event.properties?.cwd,
          });
          await $\`echo \${payload} | \${selftuneBin} opencode hook\`.quiet();
        } catch {}
      }
    },
  };
};
`;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface OpenCodeAgentConfig {
  description?: string;
  name?: string;
  mode?: string;
  model?: string;
  prompt?: string;
  tools?: Record<string, boolean>;
}

interface OpenCodeConfig {
  plugin?: string[];
  agent?: Record<string, OpenCodeAgentConfig>;
  [key: string]: unknown;
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

  return parsed as OpenCodeConfig;
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

const KNOWN_FLAGS = new Set(["--dry-run", "--uninstall", "--help", "-h"]);

function parseFlags(args: string[]): InstallOptions | null {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: selftune opencode install [--dry-run] [--uninstall]

Options:
  --dry-run      Preview changes without writing to disk
  --uninstall    Remove selftune plugin and agents from OpenCode config
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

/** Check if an agent entry was created by selftune. */
function isSelftuneAgent(entry: OpenCodeAgentConfig): boolean {
  return (
    typeof entry.description === "string" && entry.description.startsWith(SELFTUNE_AGENT_PREFIX)
  );
}

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
      description: `${SELFTUNE_AGENT_PREFIX} ${fm.description ?? fm.name}`,
      mode: "subagent",
      model: fm.model ? (OPENCODE_MODEL_MAP[fm.model] ?? fm.model) : undefined,
      prompt: body,
      tools: mapToolPermissions(fm.tools, fm.disallowedTools),
    };
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

/** Check if a plugin entry points to the selftune plugin. */
function isSelftunePlugin(entry: string): boolean {
  return entry.includes(PLUGIN_FILENAME);
}

function getPluginPath(configPath: string): string {
  return join(dirname(configPath), PLUGIN_FILENAME);
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

function doInstall(options: InstallOptions): void {
  const configPath = detectConfigPath();
  const pluginPath = getPluginPath(configPath);
  const pluginRelative = `./${PLUGIN_FILENAME}`;
  const agentEntries = buildAgentEntries();

  // Validate config before touching filesystem
  const config = readConfig(configPath);

  if (options.dryRun) {
    console.log(`[selftune] dry-run: would write plugin to ${pluginPath}`);
    console.log(`[selftune] dry-run: would update config at ${configPath}`);
    console.log(`[selftune] dry-run: would register plugin '${pluginRelative}'`);
    for (const name of Object.keys(agentEntries)) {
      console.log(`[selftune] dry-run: would register agent '${name}'`);
    }
    return;
  }

  // Write plugin file
  const pluginDir = dirname(pluginPath);
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }
  writeFileSync(pluginPath, buildPluginContent(), { mode: 0o644 });

  // Register plugin in config
  if (!config.plugin) {
    config.plugin = [];
  }
  if (!config.plugin.some(isSelftunePlugin)) {
    config.plugin.push(pluginRelative);
  }

  // Register agents
  if (Object.keys(agentEntries).length > 0) {
    if (!config.agent) {
      config.agent = {};
    }
    for (const [name, entry] of Object.entries(agentEntries)) {
      const existing = config.agent[name];
      if (existing && !isSelftuneAgent(existing)) {
        console.log(`[selftune] Warning: agent '${name}' already configured by user; skipping.`);
        continue;
      }
      config.agent[name] = entry;
    }
  }

  writeConfig(configPath, config);

  console.log(`[selftune] Installed OpenCode plugin:`);
  console.log(`  plugin: ${pluginPath}`);
  console.log(`  config: ${configPath}`);
  if (Object.keys(agentEntries).length > 0) {
    console.log(`[selftune] Registered agents:`);
    for (const name of Object.keys(agentEntries)) {
      console.log(`  ${name}`);
    }
  }
}

function doUninstall(options: InstallOptions): void {
  const configPath = detectConfigPath();
  const pluginPath = getPluginPath(configPath);

  if (options.dryRun) {
    console.log(`[selftune] dry-run: would remove plugin at ${pluginPath}`);
    console.log(`[selftune] dry-run: would remove plugin and agent entries from ${configPath}`);
    return;
  }

  // Update config first (before removing plugin file)
  if (existsSync(configPath)) {
    const config = readConfig(configPath);

    // Remove selftune plugin entry
    if (config.plugin) {
      config.plugin = config.plugin.filter((p) => !isSelftunePlugin(p));
      if (config.plugin.length === 0) {
        delete config.plugin;
      }
    }

    // Remove selftune-managed agents
    if (config.agent) {
      for (const [name, entry] of Object.entries(config.agent)) {
        if (!isSelftuneAgent(entry)) continue;
        delete config.agent[name];
      }
      if (Object.keys(config.agent).length === 0) {
        delete config.agent;
      }
    }

    writeConfig(configPath, config);
    console.log(`[selftune] Removed plugin and agent entries from: ${configPath}`);
  }

  // Remove plugin file only after config is updated
  if (existsSync(pluginPath)) {
    unlinkSync(pluginPath);
    console.log(`[selftune] Removed plugin: ${pluginPath}`);
  }

  // Clean up legacy shim if present
  const legacyShim = join(dirname(configPath), "selftune-opencode-hook.sh");
  if (existsSync(legacyShim)) {
    unlinkSync(legacyShim);
    console.log(`[selftune] Removed legacy shim: ${legacyShim}`);
  }

  console.log(`[selftune] OpenCode plugin and agents uninstalled.`);
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
