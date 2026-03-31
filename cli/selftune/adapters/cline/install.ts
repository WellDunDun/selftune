#!/usr/bin/env bun
/**
 * Install selftune hooks into Cline environment.
 *
 * Creates hook scripts in ~/Documents/Cline/Hooks/ for:
 *   - PostToolUse  (inline  — commit tracking, fast path)
 *   - TaskComplete (background — session telemetry)
 *   - TaskCancel   (background — session cleanup)
 *
 * Each hook is a bash shim that pipes stdin to `npx selftune cline hook`.
 *
 * Usage: selftune cline install [--dry-run] [--uninstall]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLINE_HOOKS_DIR = join(homedir(), "Documents", "Cline", "Hooks");
const MARKER = "# selftune-managed";

// ---------------------------------------------------------------------------
// Hook script generators
// ---------------------------------------------------------------------------

function hookScript(hookName: string): string {
  if (hookName === "PostToolUse") {
    // Inline — commit tracking is fast; finish before Cline moves on.
    // hook.ts writes {"cancel": false} to stdout, so we suppress only stderr.
    return `#!/usr/bin/env bash
${MARKER}
input=$(cat)
echo "$input" | npx selftune cline hook 2>/dev/null || echo '{"cancel": false}'
`;
  }

  // Background — session telemetry upload can be slow; don't block Cline
  return `#!/usr/bin/env bash
${MARKER}
input=$(cat)
echo "$input" | npx selftune cline hook &>/dev/null &
echo '{"cancel": false}'
`;
}

// ---------------------------------------------------------------------------
// Hook definitions
// ---------------------------------------------------------------------------

const HOOKS: Array<{ name: string; description: string }> = [
  { name: "PostToolUse", description: "Track git commits via selftune" },
  { name: "TaskComplete", description: "Record session telemetry when a Cline task completes" },
  { name: "TaskCancel", description: "Record session telemetry when a Cline task is cancelled" },
];

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function installHooks(dryRun: boolean): void {
  console.log("Setting up selftune hooks for Cline...");
  console.log(`Hooks directory: ${CLINE_HOOKS_DIR}`);
  console.log("");

  if (!dryRun) {
    mkdirSync(CLINE_HOOKS_DIR, { recursive: true });
  }

  let installed = 0;
  let skipped = 0;

  for (const hook of HOOKS) {
    const hookPath = join(CLINE_HOOKS_DIR, hook.name);

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes(MARKER)) {
        if (dryRun) {
          console.log(`  Would update: ${hook.name}`);
        } else {
          writeFileSync(hookPath, hookScript(hook.name), { mode: 0o755 });
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
        writeFileSync(hookPath, hookScript(hook.name), { mode: 0o755 });
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
    console.log("Cline will now track commits and record session telemetry.");
    console.log("Run `selftune status` to verify setup.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstallHooks(dryRun: boolean): void {
  console.log("Removing selftune hooks from Cline...");
  console.log("");

  let removed = 0;
  let skipped = 0;

  for (const hook of HOOKS) {
    const hookPath = join(CLINE_HOOKS_DIR, hook.name);

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
      `[selftune] Cline install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
