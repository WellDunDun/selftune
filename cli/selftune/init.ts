#!/usr/bin/env bun
/**
 * selftune init — Bootstrap agent identity and write config.
 *
 * Detects the coding agent environment, resolves the CLI path,
 * determines LLM mode, checks hook installation, and writes
 * the result to ~/.selftune/config.json.
 *
 * Usage:
 *   selftune init [--agent <type>] [--cli-path <path>] [--force]
 *   selftune init --enable-autonomy [--schedule-format cron|launchd|systemd]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CLAUDE_CODE_HOOK_KEYS, SELFTUNE_CONFIG_DIR, SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { SelftuneConfig } from "./types.js";
import { hookKeyHasSelftuneEntry } from "./utils/hooks.js";
import { detectAgent } from "./utils/llm-call.js";

// ---------------------------------------------------------------------------
// Agent type detection
// ---------------------------------------------------------------------------

/**
 * Detect which coding agent environment we are running inside.
 *
 * Detection order:
 *   1. Claude Code — ~/.claude/ directory exists AND (`which claude` OR env signals)
 *   2. Codex — $CODEX_HOME set OR `which codex`
 *   3. OpenCode — ~/.local/share/opencode/opencode.db exists OR `which opencode`
 *   4. "unknown" fallback
 */
const VALID_AGENT_TYPES: SelftuneConfig["agent_type"][] = [
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "unknown",
];

const AGENT_TYPE_CLI_MAP: Record<string, string> = {
  claude_code: "claude",
  codex: "codex",
  opencode: "opencode",
  openclaw: "openclaw",
};

function agentTypeToCli(agentType: string): string | null {
  return AGENT_TYPE_CLI_MAP[agentType] ?? null;
}

export function detectAgentType(
  override?: string,
  homeOverride?: string,
): SelftuneConfig["agent_type"] {
  if (override) {
    if (VALID_AGENT_TYPES.includes(override as SelftuneConfig["agent_type"])) {
      return override as SelftuneConfig["agent_type"];
    }
    console.error(`[WARN] Unknown agent type "${override}", falling back to detection`);
  }

  const home = homeOverride ?? homedir();

  // Claude Code: .claude directory + claude binary
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    if (Bun.which("claude") || process.env.CLAUDE_CODE_ENTRYPOINT) {
      return "claude_code";
    }
  }

  // Codex: env var or binary
  if (process.env.CODEX_HOME || Bun.which("codex")) {
    return "codex";
  }

  // OpenCode: db file or binary
  const opencodeDb = join(home, ".local", "share", "opencode", "opencode.db");
  if (existsSync(opencodeDb) || Bun.which("opencode")) {
    return "opencode";
  }

  // OpenClaw: agents directory or binary
  const openclawDir = join(home, ".openclaw", "agents");
  if (existsSync(openclawDir) || Bun.which("openclaw")) {
    return "openclaw";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to cli/selftune/index.ts.
 * Uses the directory of this file (init.ts lives alongside index.ts).
 */
export function determineCliPath(override?: string): string {
  if (override) return override;
  return resolve(dirname(import.meta.path), "index.ts");
}

// ---------------------------------------------------------------------------
// LLM mode determination
// ---------------------------------------------------------------------------

/**
 * Determine LLM mode and agent CLI based on available signals.
 */
export function determineLlmMode(agentCli: string | null): {
  llm_mode: "agent";
  agent_cli: string | null;
} {
  return { llm_mode: "agent", agent_cli: agentCli };
}

// ---------------------------------------------------------------------------
// Hook detection (Claude Code only)
// ---------------------------------------------------------------------------

/**
 * Check if the selftune hooks are configured in Claude Code settings.
 */
export function checkClaudeCodeHooks(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return false;

    for (const key of CLAUDE_CODE_HOOK_KEYS) {
      if (!hookKeyHasSelftuneEntry(hooks, key)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent file installation
// ---------------------------------------------------------------------------

/** Bundled agent files directory (ships with the npm package). */
const BUNDLED_AGENTS_DIR = resolve(dirname(import.meta.path), "..", "..", ".claude", "agents");

/**
 * Copy bundled agent markdown files to ~/.claude/agents/.
 * Returns a list of file names that were copied (skips files that already exist
 * unless `force` is true).
 */
export function installAgentFiles(options?: { homeDir?: string; force?: boolean }): string[] {
  const home = options?.homeDir ?? homedir();
  const force = options?.force ?? false;
  const targetDir = join(home, ".claude", "agents");

  if (!existsSync(BUNDLED_AGENTS_DIR)) return [];

  let sourceFiles: string[];
  try {
    sourceFiles = readdirSync(BUNDLED_AGENTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  if (sourceFiles.length === 0) return [];

  mkdirSync(targetDir, { recursive: true });

  const copied: string[] = [];
  for (const file of sourceFiles) {
    const dest = join(targetDir, file);
    if (!force && existsSync(dest)) continue;
    copyFileSync(join(BUNDLED_AGENTS_DIR, file), dest);
    copied.push(file);
  }

  return copied;
}

// ---------------------------------------------------------------------------
// Workspace type detection
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set(["node_modules", ".git", ".hg", "dist", "build", ".next", ".cache"]);

export interface WorkspaceInfo {
  type: "single-skill" | "multi-skill" | "monorepo" | "unknown";
  skillCount: number;
  skillPaths: string[];
  isMonorepo: boolean;
  hasExistingHooks: boolean;
  suggestedTemplate: "single-skill" | "multi-skill" | null;
}

/**
 * Recursively find SKILL.md files under a root directory,
 * skipping ignored directories (node_modules, .git, etc.).
 */
function findSkillFiles(dir: string, maxDepth = 8, depth = 0): string[] {
  if (depth > maxDepth) return [];
  if (!existsSync(dir)) return [];

  const results: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        results.push(...findSkillFiles(join(dir, entry.name), maxDepth, depth + 1));
      } else if (entry.name === "SKILL.md") {
        results.push(join(dir, entry.name));
      }
    }
  } catch {
    // Permission errors, etc. — skip
  }

  return results;
}

/**
 * Detect whether the root directory is a monorepo by checking for
 * package.json workspaces or pnpm-workspace.yaml.
 */
function detectMonorepo(rootDir: string): boolean {
  // Check package.json workspaces field
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.workspaces) return true;
    } catch {
      // invalid JSON — skip
    }
  }

  // Check pnpm-workspace.yaml
  if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) return true;

  // Check lerna.json
  if (existsSync(join(rootDir, "lerna.json"))) return true;

  return false;
}

/**
 * Detect whether the project has existing selftune hooks configured.
 */
function detectExistingHooks(rootDir: string): boolean {
  const hooksDir = join(rootDir, "cli", "selftune", "hooks");
  if (!existsSync(hooksDir)) return false;

  try {
    const entries = readdirSync(hooksDir);
    return entries.some((e) => e.endsWith(".ts") || e.endsWith(".js"));
  } catch {
    return false;
  }
}

/**
 * Scan a project root and detect the workspace type, skill layout,
 * and suggest an appropriate template.
 */
export function detectWorkspaceType(rootDir: string): WorkspaceInfo {
  const skillPaths = findSkillFiles(rootDir);
  const isMonorepo = detectMonorepo(rootDir);
  const hasExistingHooks = detectExistingHooks(rootDir);
  const skillCount = skillPaths.length;

  let type: WorkspaceInfo["type"];
  let suggestedTemplate: WorkspaceInfo["suggestedTemplate"];

  if (isMonorepo) {
    type = "monorepo";
    suggestedTemplate = "multi-skill";
  } else if (skillCount === 0) {
    type = "unknown";
    suggestedTemplate = null;
  } else if (skillCount === 1) {
    type = "single-skill";
    suggestedTemplate = "single-skill";
  } else {
    type = "multi-skill";
    suggestedTemplate = "multi-skill";
  }

  return {
    type,
    skillCount,
    skillPaths,
    isMonorepo,
    hasExistingHooks,
    suggestedTemplate,
  };
}

// ---------------------------------------------------------------------------
// Init options (for testability)
// ---------------------------------------------------------------------------

export interface InitOptions {
  configDir: string;
  configPath: string;
  force: boolean;
  agentOverride?: string;
  cliPathOverride?: string;
  homeDir?: string;
}

// ---------------------------------------------------------------------------
// Core init logic
// ---------------------------------------------------------------------------

/**
 * Run the init flow. Returns the written (or existing) config.
 * Extracted as a pure function for testability.
 */
export function runInit(opts: InitOptions): SelftuneConfig {
  const { configDir, configPath, force } = opts;

  // If config exists and no --force, return existing
  if (!force && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    try {
      return JSON.parse(raw) as SelftuneConfig;
    } catch (err) {
      throw new Error(
        `Config file at ${configPath} contains invalid JSON. Delete it or use --force to reinitialize. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Detect agent type
  const agentType = detectAgentType(opts.agentOverride, opts.homeDir);

  // Resolve CLI path
  const cliPath = determineCliPath(opts.cliPathOverride);

  // Detect agent CLI — when an override is provided, fall back to mapped CLI
  // name so init works in test/CI environments without agent binaries in PATH
  const agentCli = detectAgent() ?? (opts.agentOverride ? agentTypeToCli(agentType) : null);
  if (!agentCli) {
    throw new Error(
      "No supported agent CLI detected (claude, codex, opencode). Install one, then rerun `selftune init`.",
    );
  }

  // Determine LLM mode
  const { llm_mode, agent_cli } = determineLlmMode(agentCli);

  // Check hooks (Claude Code only)
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, ".claude", "settings.json");
  const hooksInstalled = agentType === "claude_code" ? checkClaudeCodeHooks(settingsPath) : false;

  const config: SelftuneConfig = {
    agent_type: agentType,
    cli_path: cliPath,
    llm_mode,
    agent_cli,
    hooks_installed: hooksInstalled,
    initialized_at: new Date().toISOString(),
  };

  // Write config
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  // Install agent files to ~/.claude/agents/
  const copiedAgents = installAgentFiles({ homeDir: home, force });
  if (copiedAgents.length > 0) {
    console.error(`[INFO] Installed agent files: ${copiedAgents.join(", ")}`);
  }

  return config;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      "cli-path": { type: "string" },
      force: { type: "boolean", default: false },
      "enable-autonomy": { type: "boolean", default: false },
      "schedule-format": { type: "string" },
    },
    strict: true,
  });

  const configDir = SELFTUNE_CONFIG_DIR;
  const configPath = SELFTUNE_CONFIG_PATH;
  const force = values.force ?? false;
  const enableAutonomy = values["enable-autonomy"] ?? false;

  // Check for existing config without force
  if (!force && !enableAutonomy && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const existing = JSON.parse(raw) as SelftuneConfig;
      console.log(JSON.stringify(existing, null, 2));
      console.error("Already initialized. Use --force to reinitialize.");
      process.exit(0);
    } catch (err) {
      console.error(
        `[WARN] Config at ${configPath} is corrupted: ${err instanceof Error ? err.message : String(err)}. Reinitializing...`,
      );
    }
  }

  const config = runInit({
    configDir,
    configPath,
    force,
    agentOverride: values.agent,
    cliPathOverride: values["cli-path"],
  });

  console.log(JSON.stringify(config, null, 2));

  // Detect workspace type and report
  const workspace = detectWorkspaceType(process.cwd());
  console.log(
    JSON.stringify({
      level: "info",
      code: "workspace_detected",
      type: workspace.type,
      skills: workspace.skillCount,
      monorepo: workspace.isMonorepo,
      suggestedTemplate: workspace.suggestedTemplate
        ? `templates/${workspace.suggestedTemplate}-settings.json`
        : null,
    }),
  );

  // Run doctor as post-check
  const { doctor } = await import("./observability.js");
  const doctorResult = doctor();
  console.log(
    JSON.stringify({
      level: "info",
      code: "doctor_result",
      pass: doctorResult.summary.pass,
      total: doctorResult.summary.total,
    }),
  );

  if (enableAutonomy) {
    try {
      const { installSchedule } = await import("./schedule.js");
      const scheduleResult = installSchedule({
        format: values["schedule-format"],
      });

      if (!scheduleResult.activated) {
        console.error(
          "Failed to activate the autonomous scheduler. Re-run with --schedule-format or use `selftune schedule --install --dry-run` to inspect the generated artifacts first.",
        );
        process.exit(1);
      }

      console.log(
        JSON.stringify({
          level: "info",
          code: "autonomy_enabled",
          format: scheduleResult.format,
          activated: scheduleResult.activated,
          files: scheduleResult.artifacts.map((artifact) => artifact.path),
        }),
      );
    } catch (err) {
      console.error(
        `Failed to enable autonomy: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
}

// Guard: only run when invoked directly
const isMain =
  (import.meta as Record<string, unknown>).main === true ||
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
