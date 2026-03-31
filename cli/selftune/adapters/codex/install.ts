#!/usr/bin/env bun
/**
 * Install selftune hooks into Codex environment.
 *
 * Writes hook entries to ~/.codex/hooks.json so Codex pipes events to selftune.
 * Preserves existing non-selftune hooks. Supports --dry-run and --uninstall.
 *
 * Usage:
 *   selftune codex install             # Install hooks
 *   selftune codex install --dry-run   # Preview changes without writing
 *   selftune codex install --uninstall # Remove selftune hooks
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodexHookEntry {
  event: string;
  command: string;
  timeout_ms?: number;
  matchers?: string[];
  /** Marker field so selftune can identify its own hooks. */
  _selftune?: boolean;
}

interface CodexHooksFile {
  hooks?: CodexHookEntry[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CODEX_HOME = join(homedir(), ".codex");
const HOOKS_FILENAME = "hooks.json";
const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 30_000;

/** The command Codex will run for each hook event. */
const HOOK_COMMAND =
  'bash -c \'if [ -n "$SELFTUNE_CLI_PATH" ]; then exec "$SELFTUNE_CLI_PATH" codex hook; else exec npx -y selftune@latest codex hook; fi\'';

/** Hook entries selftune installs into Codex. */
const SELFTUNE_HOOKS: CodexHookEntry[] = [
  {
    event: "SessionStart",
    command: HOOK_COMMAND,
    timeout_ms: SESSION_TIMEOUT_MS,
    _selftune: true,
  },
  {
    event: "PreToolUse",
    command: HOOK_COMMAND,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    _selftune: true,
  },
  {
    event: "PostToolUse",
    command: HOOK_COMMAND,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    _selftune: true,
  },
  {
    event: "Stop",
    command: HOOK_COMMAND,
    timeout_ms: SESSION_TIMEOUT_MS,
    _selftune: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCodexHooksPath(): string {
  const codexHome = process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME;
  return join(codexHome, HOOKS_FILENAME);
}

function getCodexHome(): string {
  return process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME;
}

/** Read and parse existing hooks.json, or return empty structure. */
function readHooksFile(path: string): CodexHooksFile {
  if (!existsSync(path)) return { hooks: [] };
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return { hooks: [] };
    const parsed = JSON.parse(raw) as CodexHooksFile;
    if (parsed.hooks !== undefined && !Array.isArray(parsed.hooks)) {
      throw new Error(`Invalid Codex hooks file: "hooks" must be an array`);
    }
    if (!Array.isArray(parsed.hooks)) parsed.hooks = [];
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check if a hook entry was installed by selftune. */
function isSelftuneHook(entry: CodexHookEntry): boolean {
  // Check marker field first
  if (entry._selftune === true) return true;
  // Fallback: check if command references selftune
  return (
    typeof entry.command === "string" &&
    entry.command.includes("selftune") &&
    entry.command.includes("codex hook")
  );
}

/** Merge selftune hooks into existing hooks, replacing any previous selftune entries. */
export function mergeHooks(
  existing: CodexHookEntry[],
  incoming: CodexHookEntry[],
): CodexHookEntry[] {
  // Keep all non-selftune hooks
  const preserved = existing.filter((h) => !isSelftuneHook(h));
  // Append new selftune hooks
  return [...preserved, ...incoming];
}

/** Remove all selftune hooks from the list. */
export function removeSelftuneHooks(existing: CodexHookEntry[]): CodexHookEntry[] {
  return existing.filter((h) => !isSelftuneHook(h));
}

// ---------------------------------------------------------------------------
// Install / uninstall logic
// ---------------------------------------------------------------------------

export interface InstallResult {
  hooksPath: string;
  action: "installed" | "uninstalled" | "no_change";
  hooksWritten: number;
  hooksRemoved: number;
  dryRun: boolean;
}

export function installHooks(options: { dryRun?: boolean } = {}): InstallResult {
  const hooksPath = getCodexHooksPath();
  const codexHome = getCodexHome();
  const hooksFile = readHooksFile(hooksPath);
  const existingHooks = hooksFile.hooks ?? [];

  const merged = mergeHooks(existingHooks, SELFTUNE_HOOKS);

  // Check if anything changed
  const existingJson = JSON.stringify(existingHooks);
  const mergedJson = JSON.stringify(merged);

  if (existingJson === mergedJson) {
    return {
      hooksPath,
      action: "no_change",
      hooksWritten: 0,
      hooksRemoved: 0,
      dryRun: options.dryRun ?? false,
    };
  }

  if (!options.dryRun) {
    if (!existsSync(codexHome)) {
      mkdirSync(codexHome, { recursive: true });
    }
    hooksFile.hooks = merged;
    writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2) + "\n", "utf-8");
  }

  return {
    hooksPath,
    action: "installed",
    hooksWritten: SELFTUNE_HOOKS.length,
    hooksRemoved: existingHooks.filter((h) => isSelftuneHook(h)).length,
    dryRun: options.dryRun ?? false,
  };
}

export function uninstallHooks(options: { dryRun?: boolean } = {}): InstallResult {
  const hooksPath = getCodexHooksPath();
  const hooksFile = readHooksFile(hooksPath);
  const existingHooks = hooksFile.hooks ?? [];

  const cleaned = removeSelftuneHooks(existingHooks);
  const removedCount = existingHooks.length - cleaned.length;

  if (removedCount === 0) {
    return {
      hooksPath,
      action: "no_change",
      hooksWritten: 0,
      hooksRemoved: 0,
      dryRun: options.dryRun ?? false,
    };
  }

  if (!options.dryRun) {
    hooksFile.hooks = cleaned;
    writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2) + "\n", "utf-8");
  }

  return {
    hooksPath,
    action: "uninstalled",
    hooksWritten: 0,
    hooksRemoved: removedCount,
    dryRun: options.dryRun ?? false,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry point for `selftune codex install`.
 */
export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");

  try {
    if (uninstall) {
      const result = uninstallHooks({ dryRun });

      if (result.action === "no_change") {
        console.log("No selftune hooks found in Codex configuration.");
        console.log(`Config: ${result.hooksPath}`);
      } else {
        const prefix = dryRun ? "[dry-run] Would remove" : "Removed";
        console.log(`${prefix} ${result.hooksRemoved} selftune hook(s) from Codex.`);
        console.log(`Config: ${result.hooksPath}`);
      }

      if (dryRun) {
        console.log("\nNo changes written (--dry-run).");
      }
    } else {
      const result = installHooks({ dryRun });

      if (result.action === "no_change") {
        console.log("selftune hooks already installed in Codex. No changes needed.");
        console.log(`Config: ${result.hooksPath}`);
      } else {
        const prefix = dryRun ? "[dry-run] Would install" : "Installed";
        console.log(`${prefix} ${result.hooksWritten} selftune hook(s) into Codex.`);
        console.log(`Config: ${result.hooksPath}`);
        console.log("Events: SessionStart, PreToolUse, PostToolUse, Stop");

        if (result.hooksRemoved > 0) {
          console.log(`Replaced ${result.hooksRemoved} previous selftune hook(s).`);
        }
      }

      if (dryRun) {
        console.log("\nNo changes written (--dry-run).");
      } else if (result.action === "installed") {
        console.log("\nNext step: run `selftune doctor` to verify hook health.");
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    console.error("Next step: check that ~/.codex/ is writable and try again.");
    process.exit(1);
  }
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    await cliMain();
  } catch (err) {
    console.error(
      `[selftune] Codex install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
