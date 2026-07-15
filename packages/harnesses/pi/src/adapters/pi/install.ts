#!/usr/bin/env bun
/**
 * Install selftune hooks into Pi coding agent environment.
 *
 * Pi supports extensions that hook into its lifecycle. This installer
 * creates a selftune extension that pipes events to `selftune pi hook`.
 *
 * Extension location: ~/.pi/extensions/selftune/
 *
 * Events hooked:
 *   - tool_call        (pre-tool — skill guards, inline)
 *   - tool_result      (post-tool — skill eval + commit tracking, inline)
 *   - message          (prompt submit — prompt logging + auto-activate, inline)
 *   - session_shutdown (session end — session telemetry, background)
 *
 * Usage: selftune pi install [--dry-run] [--uninstall]
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_DIR = process.env.SELFTUNE_PI_DIR ?? join(homedir(), ".pi");
const PI_EXTENSIONS_DIR = join(PI_DIR, "extensions", "selftune");
const MARKER = "# selftune-managed";

// ---------------------------------------------------------------------------
// Hook script generators
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Build a hook command that prefers the installer-provided desktop CLI path. */
const installedCliPath = process.env.SELFTUNE_INSTALL_CLI_PATH?.trim();
const HOOK_CMD = installedCliPath
  ? `${shellQuote(installedCliPath)} pi hook`
  : 'if [ -n "$SELFTUNE_CLI_PATH" ]; then "$SELFTUNE_CLI_PATH" pi hook; else npx selftune pi hook; fi';

function hookScript(eventType: string, inline: boolean): string {
  if (inline) {
    // Inline — fast path; finish before Pi moves on.
    // Capture output and exit code separately to avoid double JSON and preserve guard blocks (exit 2).
    return `#!/usr/bin/env bash
${MARKER}
input=$(cat)
result=$(echo "$input" | (${HOOK_CMD}) 2>/dev/null)
rc=$?
[ -z "$result" ] && result='{}'
echo "$result"
exit $rc
`;
  }

  // Background — don't block Pi
  return `#!/usr/bin/env bash
${MARKER}
input=$(cat)
echo "$input" | (${HOOK_CMD}) &>/dev/null &
echo '{}'
`;
}

// ---------------------------------------------------------------------------
// Hook definitions
// ---------------------------------------------------------------------------

const HOOKS: Array<{ name: string; description: string; inline: boolean }> = [
  {
    name: "tool_call",
    description: "Pre-tool guards (evolution, skill change)",
    inline: true,
  },
  {
    name: "tool_result",
    description: "Post-tool eval + commit tracking",
    inline: true,
  },
  {
    name: "message",
    description: "Prompt logging + auto-activate",
    inline: true,
  },
  {
    name: "session_shutdown",
    description: "Session telemetry recording",
    inline: false,
  },
];

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function installHooks(dryRun: boolean): void {
  console.log("Setting up selftune hooks for Pi...");
  console.log(`Extensions directory: ${PI_EXTENSIONS_DIR}`);
  console.log("");

  if (!dryRun) {
    mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });
  }

  let installed = 0;
  let skipped = 0;

  for (const hook of HOOKS) {
    const hookPath = join(PI_EXTENSIONS_DIR, hook.name);

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes(MARKER)) {
        if (dryRun) {
          console.log(`  Would update: ${hook.name}`);
        } else {
          writeFileSync(hookPath, hookScript(hook.name, hook.inline), {
            mode: 0o755,
          });
          chmodSync(hookPath, 0o755);
          console.log(`  Updated: ${hook.name}`);
        }
        installed++;
      } else {
        console.log(`  Skipped: ${hook.name} (existing hook not managed by selftune)`);
        skipped++;
      }
    } else {
      if (dryRun) {
        console.log(`  Would create: ${hook.name}`);
      } else {
        writeFileSync(hookPath, hookScript(hook.name, hook.inline), {
          mode: 0o755,
        });
        console.log(`  Created: ${hook.name}`);
      }
      installed++;
    }
  }

  console.log("");
  if (dryRun) {
    console.log(`Dry run: ${installed} hook(s) would be installed.`);
  } else if (installed > 0) {
    console.log(`Installed ${installed} hook(s).`);
  }
  if (skipped > 0) {
    console.log(`Skipped ${skipped} hook(s) with existing non-selftune content.`);
  }
  if (!dryRun && installed > 0) {
    console.log("");
    if (skipped === 0) {
      console.log("Pi will now track commits and record session telemetry.");
    } else {
      console.log("Partial install: some hooks were skipped. Telemetry may be incomplete.");
    }
    console.log("Run `selftune status` to verify setup.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstallHooks(dryRun: boolean): void {
  console.log("Removing selftune hooks from Pi...");
  console.log("");

  let removed = 0;
  let skipped = 0;

  for (const hook of HOOKS) {
    const hookPath = join(PI_EXTENSIONS_DIR, hook.name);

    if (!existsSync(hookPath)) {
      console.log(`  Not found: ${hook.name}`);
      continue;
    }

    const existing = readFileSync(hookPath, "utf-8");
    if (!existing.includes(MARKER)) {
      console.log(`  Skipped: ${hook.name} (not managed by selftune)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  Would remove: ${hook.name}`);
    } else {
      rmSync(hookPath);
      console.log(`  Removed: ${hook.name}`);
    }
    removed++;
  }

  console.log("");
  if (dryRun) {
    console.log(`Dry run: ${removed} hook(s) would be removed.`);
  } else if (removed > 0) {
    console.log(`Removed ${removed} hook(s).`);
  }
  if (skipped > 0) {
    console.log(`Skipped ${skipped} hook(s) not managed by selftune.`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");

  if (uninstall) {
    uninstallHooks(dryRun);
  } else {
    installHooks(dryRun);
  }
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    await cliMain();
  } catch (err) {
    console.error(
      `[selftune] Pi install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
