import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CLAUDE_CODE_HOOK_KEYS } from "../constants.js";
import { findSelftunePackageRoot } from "../package-root.js";
import { hookKeyHasSelftuneEntry, isSelftuneCommand } from "../utils/hooks.js";

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
// Hook installation (Claude Code only)
// ---------------------------------------------------------------------------

/** Bundled settings snippet (ships with the npm package). */
const SETTINGS_SNIPPET_PATH = join(findSelftunePackageRoot(), "skill", "settings_snippet.json");

/**
 * Install selftune hooks into ~/.claude/settings.json by merging entries
 * from the bundled settings_snippet.json.
 *
 * - Creates settings.json if it does not exist
 * - Creates the hooks section if it does not exist
 * - Adds hook entries for keys that don't already have a selftune entry
 * - Updates existing selftune entries with new attributes from the snippet
 *   (e.g. `if`, `statusMessage`, `async`, `timeout`) while preserving
 *   the resolved `command` path from the existing entry
 * - Never overwrites existing non-selftune hooks
 *
 * Returns the list of hook keys that were added or updated.
 */
export function installClaudeCodeHooks(options?: {
  settingsPath?: string;
  snippetPath?: string;
  cliPath?: string;
}): string[] {
  const settingsPath = options?.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const snippetPath = options?.snippetPath ?? SETTINGS_SNIPPET_PATH;

  // Read the snippet
  if (!existsSync(snippetPath)) {
    console.error(`[WARN] Hook snippet not found at ${snippetPath}, skipping hook installation`);
    return [];
  }

  let snippet: Record<string, unknown>;
  try {
    snippet = JSON.parse(readFileSync(snippetPath, "utf-8"));
  } catch {
    console.error(`[WARN] Failed to parse hook snippet at ${snippetPath}`);
    return [];
  }

  const snippetHooks = snippet.hooks as Record<string, unknown[]> | undefined;
  if (!snippetHooks || typeof snippetHooks !== "object") {
    console.error("[WARN] Hook snippet has no 'hooks' section");
    return [];
  }

  // Read existing settings (or start with empty object)
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error(`[WARN] Failed to parse ${settingsPath}, starting with empty settings`);
      settings = {};
    }
  }

  // Ensure hooks section exists
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const existingHooks = settings.hooks as Record<string, unknown[]>;

  // Resolve the package root for path substitution
  const cliPath = options?.cliPath;
  const packageRoot = cliPath
    ? findSelftunePackageRoot(dirname(cliPath)).replace(/\\/g, "/")
    : null;

  const changedKeys: string[] = [];

  for (const key of Object.keys(snippetHooks)) {
    // Get the snippet entries for this key, replacing /PATH/TO/ with actual package root
    let entries = snippetHooks[key];
    if (packageRoot) {
      // Deep clone and substitute all /PATH/TO/ references with the resolved package root
      const raw = JSON.stringify(entries).replace(/\/PATH\/TO\//g, `${packageRoot}/`);
      entries = JSON.parse(raw);
    }
    if (hookKeyHasSelftuneEntry(existingHooks, key)) {
      // Key already has selftune hooks — update them in-place with new attributes
      // while preserving non-selftune entries and the resolved command paths
      if (updateExistingSelftuneHooks(existingHooks, key, entries)) {
        changedKeys.push(key);
      }
    } else {
      // No selftune entry yet — add the snippet entries
      if (Array.isArray(existingHooks[key])) {
        existingHooks[key] = [...existingHooks[key], ...entries];
      } else {
        existingHooks[key] = entries;
      }
      changedKeys.push(key);
    }
  }

  if (changedKeys.length > 0) {
    // Ensure ~/.claude/ directory exists
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  return changedKeys;
}

/**
 * Update existing selftune hook entries in-place with new attributes from the snippet.
 *
 * For each matcher group that contains selftune hooks, replaces ALL selftune
 * hook entries with the full set of snippet entries while:
 *   - Resolving snippet commands using the package root from existing entries
 *   - Preserving non-selftune hooks in the same matcher group
 *   - Handling N→M changes (e.g. 2 hooks expanding to 4 with Write/Edit splits)
 *
 * Returns true if any entries were actually modified.
 */
export function updateExistingSelftuneHooks(
  existingHooks: Record<string, unknown[]>,
  key: string,
  snippetEntries: unknown[],
): boolean {
  const existingArray = existingHooks[key];
  if (!Array.isArray(existingArray)) return false;

  // Collect all snippet hooks (flattened from matcher groups)
  const allSnippetHooks: Array<Record<string, unknown>> = [];
  for (const group of snippetEntries) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as Record<string, unknown>;
    const hooks = g.hooks as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(hooks)) continue;
    allSnippetHooks.push(...hooks);
  }

  if (allSnippetHooks.length === 0) return false;

  let modified = false;

  for (let i = 0; i < existingArray.length; i++) {
    const group = existingArray[i];
    if (typeof group !== "object" || group === null) continue;
    const g = group as Record<string, unknown>;
    const hooks = g.hooks as Array<Record<string, unknown>> | undefined;

    // Handle flat entries (direct { command: "..." } without nested hooks array).
    // These are a legacy format from older selftune versions or manual installs.
    if (!Array.isArray(hooks)) {
      if (!isHookSelftune(g)) continue;
      const pkgRoot = derivePackageRootFromCommand(typeof g.command === "string" ? g.command : "");

      // Replace the flat entry with the full snippet group structure.
      // If we can derive a package root, resolve /PATH/TO/ in the snippet.
      // If not (e.g. "npx selftune hook ..."), use snippet entries as-is
      // (they were already resolved by the caller if a cliPath was provided).
      const resolvedEntries = snippetEntries.map((se) => {
        if (!pkgRoot) return se;
        const raw = JSON.stringify(se).replace(/\/PATH\/TO\//g, `${pkgRoot}/`);
        return JSON.parse(raw);
      });
      existingArray.splice(i, 1, ...resolvedEntries);
      modified = true;
      continue;
    }

    // Derive package root from the first selftune hook in this group
    let packageRoot: string | null = null;
    for (const hook of hooks) {
      if (isHookSelftune(hook)) {
        packageRoot = derivePackageRootFromCommand(
          typeof hook.command === "string" ? hook.command : "",
        );
        if (packageRoot) break;
      }
    }

    // Check if this group has any selftune hooks at all
    const hasSelftuneHooks = hooks.some(isHookSelftune);
    if (!hasSelftuneHooks) continue;

    // Build resolved snippet hooks using the derived package root.
    // If no package root was derivable (e.g. "npx selftune hook ..."),
    // use snippet hooks as-is (already resolved by caller if cliPath was provided).
    const resolvedSnippetHooks = allSnippetHooks.map((snippetHook) => {
      const cmd = typeof snippetHook.command === "string" ? snippetHook.command : "";
      const resolvedCmd = packageRoot ? cmd.replace(/\/PATH\/TO\//g, `${packageRoot}/`) : cmd;
      return { ...snippetHook, command: resolvedCmd };
    });

    // Check if anything actually changed (compare sorted JSON for order independence)
    const oldSelftune = hooks.filter(isHookSelftune);
    const oldSorted = JSON.stringify(sortKeys(oldSelftune));
    const newSorted = JSON.stringify(sortKeys(resolvedSnippetHooks));
    if (oldSorted !== newSorted) {
      modified = true;
    }

    // Rebuild hooks preserving original ordering of non-selftune entries:
    // replace the first selftune hook with all resolved snippet hooks,
    // remove remaining old selftune hooks, keep non-selftune hooks in place
    const updatedHooks: Array<Record<string, unknown>> = [];
    let selftuneInserted = false;
    for (const hook of hooks) {
      if (isHookSelftune(hook)) {
        if (!selftuneInserted) {
          // Insert all resolved snippet hooks at the position of the first selftune hook
          updatedHooks.push(...resolvedSnippetHooks);
          selftuneInserted = true;
        }
        // Skip remaining old selftune hooks (replaced by snippet set above)
      } else {
        updatedHooks.push(hook);
      }
    }
    g.hooks = updatedHooks;
  }

  return modified;
}

/** Check if a hook entry is a selftune-managed hook. Delegates to shared isSelftuneCommand. */
function isHookSelftune(hook: Record<string, unknown>): boolean {
  return typeof hook.command === "string" && isSelftuneCommand(hook.command);
}

/** Sort object keys recursively for order-independent JSON comparison. */
function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/**
 * Derive the selftune package root from an existing hook command.
 * Supports the old direct format ("bun run .../cli/selftune/hooks/X.ts"),
 * the legacy runner format ("node .../bin/run-hook.cjs .../hooks/X.ts"),
 * and the current runner format ("bun .../bin/run-hook.cjs .../hooks/X.ts").
 *
 * Handles paths with spaces (e.g. "/Users/Alice Smith/...") and
 * optional surrounding quotes in the command string.
 */
export function derivePackageRootFromCommand(command: string): string | null {
  // Normalize: strip quotes, collapse backslashes (for Windows-style paths)
  const normalized = command.replace(/["']/g, "").replace(/\\/g, "/");
  // Split on the known directory marker and take the prefix.
  // The command may contain the package root multiple times (e.g.
  // "bun /root/bin/run-hook.cjs /root/cli/selftune/hooks/script.ts")
  // so we split on the LAST occurrence of the marker.
  for (const marker of ["/cli/selftune/hooks/", "/bin/run-hook.cjs"]) {
    const idx = normalized.lastIndexOf(marker);
    if (idx === -1) continue;
    // Everything before the marker is "<prefix> <package-root>" or just "<package-root>"
    const beforeMarker = normalized.slice(0, idx);
    // Find the start of the path: scan backwards from end for the path start.
    // Paths start with / (Unix) or a drive letter like C:/ (Windows).
    // The command prefix (e.g. "node " or "bun run ") precedes the path.
    const pathMatch = beforeMarker.match(/.*\s(\/.*|[A-Za-z]:\/.*)/);
    if (pathMatch) return pathMatch[1];
    // No space prefix — the entire string is the path (e.g. no "node " prefix)
    if (beforeMarker.startsWith("/") || /^[A-Za-z]:\//.test(beforeMarker)) {
      return beforeMarker;
    }
  }
  return null;
}
