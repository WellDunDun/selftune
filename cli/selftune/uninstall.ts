#!/usr/bin/env bun
/**
 * selftune uninstall — Clean removal of all selftune data and configuration.
 *
 * Removes:
 *   1. Autonomy scheduling (launchd/cron/systemd + OpenClaw cron)
 *   2. Selftune hooks from ~/.claude/settings.json (surgical — preserves user hooks)
 *   3. Selftune-managed Claude subagents from ~/.claude/agents/
 *   4. JSONL telemetry logs from ~/.claude/
 *   5. Selftune config directory (~/.selftune/)
 *   6. Ingest marker files
 *   7. Optionally: `npm uninstall -g selftune`
 *
 * Usage:
 *   selftune uninstall [--dry-run] [--keep-logs] [--npm-uninstall]
 */

import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { removeInstalledAgentFiles } from "./claude-agents.js";
import {
  CLAUDE_CODE_MARKER,
  CLAUDE_SETTINGS_PATH,
  CODEX_INGEST_MARKER,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  OPENCODE_INGEST_MARKER,
  OPENCLAW_INGEST_MARKER,
  ORCHESTRATE_LOCK,
  ORCHESTRATE_RUN_LOG,
  QUERY_LOG,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SELFTUNE_CONFIG_DIR,
  SIGNAL_LOG,
  SKILL_LOG,
  TELEMETRY_LOG,
  CANONICAL_LOG,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UninstallResult {
  dryRun: boolean;
  schedule: { removed: boolean; details: string };
  hooks: { removed: number; details: string };
  agents: { removed: number; files: string[] };
  logs: { removed: number; skipped: boolean; files: string[] };
  config: { removed: boolean; path: string };
  markers: { removed: number; files: string[] };
  npm: { uninstalled: boolean; skipped: boolean };
}

// ---------------------------------------------------------------------------
// Step 1: Remove autonomy scheduling
// ---------------------------------------------------------------------------

async function removeScheduling(dryRun: boolean): Promise<{ removed: boolean; details: string }> {
  // Try launchd first (macOS)
  const label = "dev.selftune.orchestrate";
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

  if (existsSync(plistPath)) {
    if (dryRun) {
      return { removed: false, details: `Would remove launchd plist: ${plistPath}` };
    }
    try {
      // Unload before removing
      Bun.spawnSync(["launchctl", "unload", plistPath], { stderr: "pipe" });
      unlinkSync(plistPath);
      return { removed: true, details: `Removed launchd plist: ${plistPath}` };
    } catch (err) {
      return {
        removed: false,
        details: `Failed to remove launchd plist: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Try OpenClaw cron jobs
  if (dryRun) {
    return { removed: false, details: "Would remove cron jobs via selftune cron remove" };
  }
  try {
    const proc = Bun.spawnSync(["selftune", "cron", "remove"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return { removed: true, details: "Removed cron jobs via selftune cron remove" };
    }
  } catch {
    // selftune cron remove not available or failed — not critical
  }

  return { removed: false, details: "No scheduling artifacts found" };
}

// ---------------------------------------------------------------------------
// Step 2: Remove selftune hooks from settings.json
// ---------------------------------------------------------------------------

/** Selftune hook scripts — used to identify which entries to remove. */
const SELFTUNE_HOOK_SCRIPTS = [
  "hooks/prompt-log.ts",
  "hooks/auto-activate.ts",
  "hooks/skill-change-guard.ts",
  "hooks/evolution-guard.ts",
  "hooks/skill-eval.ts",
  "hooks/session-stop.ts",
];

function isSelfttuneHookEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const obj = entry as Record<string, unknown>;

  // Check direct command
  if (typeof obj.command === "string") {
    const command = obj.command;
    return SELFTUNE_HOOK_SCRIPTS.some((script) => command.includes(script));
  }

  // Check hooks array (the nested structure used in settings.json)
  if (Array.isArray(obj.hooks)) {
    return obj.hooks.some(
      (h: unknown) =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as Record<string, unknown>).command === "string" &&
        SELFTUNE_HOOK_SCRIPTS.some((script) =>
          ((h as Record<string, unknown>).command as string).includes(script),
        ),
    );
  }

  return false;
}

function removeHooksFromSettings(
  dryRun: boolean,
  settingsPath?: string,
): { removed: number; details: string } {
  const path = settingsPath ?? CLAUDE_SETTINGS_PATH;
  if (!existsSync(path)) {
    return { removed: 0, details: "No settings.json found" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { removed: 0, details: "Failed to parse settings.json" };
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== "object") {
    return { removed: 0, details: "No hooks section in settings.json" };
  }

  let totalRemoved = 0;

  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) continue;

    const before = hooks[key].length;
    hooks[key] = hooks[key].filter((entry) => !isSelfttuneHookEntry(entry));
    const removed = before - hooks[key].length;
    totalRemoved += removed;

    // Clean up empty arrays
    if (hooks[key].length === 0) {
      delete hooks[key];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  if (totalRemoved > 0 && !dryRun) {
    writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
  }

  return {
    removed: totalRemoved,
    details: dryRun
      ? `Would remove ${totalRemoved} selftune hook entries from ${path}`
      : `Removed ${totalRemoved} selftune hook entries from ${path}`,
  };
}

// ---------------------------------------------------------------------------
// Step 3: Remove bundled Claude subagents
// ---------------------------------------------------------------------------

function removeAgents(dryRun: boolean): { removed: number; files: string[] } {
  return removeInstalledAgentFiles({ dryRun });
}

// ---------------------------------------------------------------------------
// Step 4: Remove JSONL log files
// ---------------------------------------------------------------------------

const LOG_FILES = [
  TELEMETRY_LOG,
  SKILL_LOG,
  REPAIRED_SKILL_LOG,
  CANONICAL_LOG,
  QUERY_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  ORCHESTRATE_RUN_LOG,
  SIGNAL_LOG,
  ORCHESTRATE_LOCK,
];

function removeLogs(dryRun: boolean): { removed: number; files: string[] } {
  const removed: string[] = [];

  for (const logPath of LOG_FILES) {
    if (existsSync(logPath)) {
      if (!dryRun) {
        try {
          unlinkSync(logPath);
          removed.push(logPath);
        } catch {
          // Skip files we can't remove
        }
      } else {
        removed.push(logPath);
      }
    }
  }

  return { removed: removed.length, files: removed };
}

// ---------------------------------------------------------------------------
// Step 5: Remove config directory
// ---------------------------------------------------------------------------

function removeConfig(dryRun: boolean): { removed: boolean; path: string } {
  if (!existsSync(SELFTUNE_CONFIG_DIR)) {
    return { removed: false, path: SELFTUNE_CONFIG_DIR };
  }

  if (!dryRun) {
    try {
      rmSync(SELFTUNE_CONFIG_DIR, { recursive: true, force: true });
      return { removed: true, path: SELFTUNE_CONFIG_DIR };
    } catch {
      return { removed: false, path: SELFTUNE_CONFIG_DIR };
    }
  }

  return { removed: false, path: SELFTUNE_CONFIG_DIR };
}

// ---------------------------------------------------------------------------
// Step 6: Remove ingest marker files
// ---------------------------------------------------------------------------

const MARKER_FILES = [
  CLAUDE_CODE_MARKER,
  CODEX_INGEST_MARKER,
  OPENCODE_INGEST_MARKER,
  OPENCLAW_INGEST_MARKER,
  REPAIRED_SKILL_SESSIONS_MARKER,
];

function removeMarkers(dryRun: boolean): { removed: number; files: string[] } {
  const removed: string[] = [];

  for (const markerPath of MARKER_FILES) {
    if (existsSync(markerPath)) {
      if (!dryRun) {
        try {
          unlinkSync(markerPath);
          removed.push(markerPath);
        } catch {
          // Skip files we can't remove
        }
      } else {
        removed.push(markerPath);
      }
    }
  }

  return { removed: removed.length, files: removed };
}

// ---------------------------------------------------------------------------
// Step 7: npm uninstall
// ---------------------------------------------------------------------------

async function npmUninstall(dryRun: boolean): Promise<{ uninstalled: boolean }> {
  if (dryRun) {
    return { uninstalled: false };
  }

  try {
    const proc = Bun.spawnSync(["npm", "uninstall", "-g", "selftune"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { uninstalled: proc.exitCode === 0 };
  } catch {
    return { uninstalled: false };
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface UninstallOptions {
  dryRun: boolean;
  keepLogs: boolean;
  npmUninstall: boolean;
  settingsPath?: string;
}

export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  const { dryRun, keepLogs, settingsPath } = options;

  // Step 1: Remove scheduling
  const schedule = await removeScheduling(dryRun);

  // Step 2: Remove hooks
  const hooks = removeHooksFromSettings(dryRun, settingsPath);

  // Step 3: Remove bundled Claude subagents
  const agents = removeAgents(dryRun);

  // Step 4: Remove logs
  const logs = keepLogs
    ? { removed: 0, skipped: true, files: [] }
    : { ...removeLogs(dryRun), skipped: false };

  // Step 5: Remove config directory
  const config = removeConfig(dryRun);

  // Step 6: Remove ingest markers
  const markers = removeMarkers(dryRun);

  // Step 7: npm uninstall (optional)
  const npm = options.npmUninstall
    ? { ...(await npmUninstall(dryRun)), skipped: false }
    : { uninstalled: false, skipped: true };

  return { dryRun, schedule, hooks, agents, logs, config, markers, npm };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "keep-logs": { type: "boolean", default: false },
      "npm-uninstall": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune uninstall — Clean removal of all selftune data and configuration

Usage:
  selftune uninstall [options]

Options:
  --dry-run        Preview what would be removed without deleting anything
  --keep-logs      Preserve JSONL telemetry logs (remove everything else)
  --npm-uninstall  Also run 'npm uninstall -g selftune'
  --help           Show this help message

Removes:
  1. Autonomy scheduling (launchd/cron/systemd)
  2. Selftune hooks from ~/.claude/settings.json (preserves user hooks)
  3. Selftune-managed Claude subagents from ~/.claude/agents/
  4. JSONL telemetry logs from ~/.claude/
  5. Selftune config directory (~/.selftune/)
  6. Ingest marker files
  7. npm global package (with --npm-uninstall)`);
    process.exit(0);
  }

  const result = await uninstall({
    dryRun: values["dry-run"] ?? false,
    keepLogs: values["keep-logs"] ?? false,
    npmUninstall: values["npm-uninstall"] ?? false,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
