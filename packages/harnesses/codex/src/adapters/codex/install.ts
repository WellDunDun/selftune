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

type CodexHookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit" | "Stop";

type CodexHookHandler = Record<string, unknown> & {
  command?: string;
  _selftune?: boolean;
};

type CodexMatcherGroup = Record<string, unknown> & {
  hooks: CodexHookHandler[];
};

type CodexHooksByEvent = Record<string, CodexMatcherGroup[]>;

type LegacyCodexHookEntry = Record<string, unknown> & {
  event?: unknown;
  command?: unknown;
  timeout_ms?: unknown;
  matchers?: unknown;
  _selftune?: unknown;
};

interface ParsedCodexHooksFile {
  hooksByEvent: CodexHooksByEvent;
  otherFields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CODEX_HOME = join(homedir(), ".codex");
const HOOKS_FILENAME = "hooks.json";
const DEFAULT_TIMEOUT_SEC = 10;
const SESSION_TIMEOUT_SEC = 30;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The command Codex will run for each hook event. */
const installedCliPath = process.env.SELFTUNE_INSTALL_CLI_PATH?.trim();
const HOOK_COMMAND = installedCliPath
  ? `${shellQuote(installedCliPath)} codex hook`
  : 'bash -c \'if [ -n "$SELFTUNE_CLI_PATH" ]; then exec "$SELFTUNE_CLI_PATH" codex hook; else exec npx -y selftune@latest codex hook; fi\'';

/** Hook entries selftune installs into Codex. */
const SELFTUNE_HOOKS: Record<Exclude<CodexHookEvent, "UserPromptSubmit">, CodexMatcherGroup[]> = {
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
          timeout: SESSION_TIMEOUT_SEC,
          _selftune: true,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
          timeout: DEFAULT_TIMEOUT_SEC,
          _selftune: true,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
          timeout: DEFAULT_TIMEOUT_SEC,
          _selftune: true,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
          timeout: SESSION_TIMEOUT_SEC,
          _selftune: true,
        },
      ],
    },
  ],
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneHooksByEvent(hooksByEvent: CodexHooksByEvent): CodexHooksByEvent {
  return Object.fromEntries(
    Object.entries(hooksByEvent).map(([eventName, groups]) => [
      eventName,
      groups.map((group) => ({
        ...group,
        hooks: group.hooks.map((handler) => ({ ...handler })),
      })),
    ]),
  );
}

function normalizeMatcherGroup(
  value: unknown,
  eventName: string,
  index: number,
): CodexMatcherGroup {
  if (!isRecord(value)) {
    throw new Error(`Invalid Codex hooks file: hooks.${eventName}[${index}] must be an object`);
  }

  if (!Array.isArray(value.hooks)) {
    throw new Error(
      `Invalid Codex hooks file: hooks.${eventName}[${index}].hooks must be an array`,
    );
  }

  return {
    ...value,
    hooks: value.hooks.map((handler, handlerIndex) => {
      if (!isRecord(handler)) {
        throw new Error(
          `Invalid Codex hooks file: hooks.${eventName}[${index}].hooks[${handlerIndex}] must be an object`,
        );
      }
      return { ...handler };
    }),
  };
}

function normalizeEventMapHooks(value: unknown): CodexHooksByEvent {
  if (!isRecord(value)) {
    throw new Error(`Invalid Codex hooks file: "hooks" must be an object or legacy array`);
  }

  const hooksByEvent: CodexHooksByEvent = {};
  for (const [eventName, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Invalid Codex hooks file: hooks.${eventName} must be an array`);
    }
    hooksByEvent[eventName] = groups.map((group, index) =>
      normalizeMatcherGroup(group, eventName, index),
    );
  }
  return hooksByEvent;
}

function convertLegacyHooks(entries: unknown[]): CodexHooksByEvent {
  const hooksByEvent: CodexHooksByEvent = {};

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || typeof entry.event !== "string" || typeof entry.command !== "string") {
      throw new Error(
        `Invalid Codex hooks file: legacy hooks[${index}] must include string event and command`,
      );
    }

    const legacyEntry = entry as LegacyCodexHookEntry;
    const handler: CodexHookHandler = {
      type: "command",
      command: legacyEntry.command as string,
    };

    if (typeof legacyEntry.timeout_ms === "number" && Number.isFinite(legacyEntry.timeout_ms)) {
      handler.timeout = Math.max(1, Math.ceil((legacyEntry.timeout_ms as number) / 1000));
    }

    if (legacyEntry._selftune === true) {
      handler._selftune = true;
    }

    const matchers =
      Array.isArray(legacyEntry.matchers) &&
      legacyEntry.matchers.every((matcher) => typeof matcher === "string")
        ? (legacyEntry.matchers as string[])
        : [];

    const groups = hooksByEvent[legacyEntry.event as string] ?? [];
    if (matchers.length === 0) {
      groups.push({ hooks: [{ ...handler }] });
    } else {
      for (const matcher of matchers) {
        groups.push({ matcher, hooks: [{ ...handler }] });
      }
    }
    hooksByEvent[legacyEntry.event as string] = groups;
  }

  return hooksByEvent;
}

function serializeHooksByEvent(hooksByEvent: CodexHooksByEvent): CodexHooksByEvent {
  return Object.fromEntries(
    Object.entries(hooksByEvent).map(([eventName, groups]) => [
      eventName,
      groups.map((group) => {
        const { hooks, ...rest } = group;
        return {
          ...rest,
          hooks: hooks.map((handler) => {
            const { _selftune, ...serialized } = handler;
            return serialized;
          }),
        };
      }),
    ]),
  );
}

/** Read and parse existing hooks.json, or return empty structure. */
function readHooksFile(path: string): ParsedCodexHooksFile {
  if (!existsSync(path)) return { hooksByEvent: {}, otherFields: {} };
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return { hooksByEvent: {}, otherFields: {} };

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Invalid Codex hooks file: root must be an object`);
    }

    const { hooks, ...otherFields } = parsed;
    if (hooks === undefined) {
      return { hooksByEvent: {}, otherFields };
    }

    if (Array.isArray(hooks)) {
      return { hooksByEvent: convertLegacyHooks(hooks), otherFields };
    }

    return { hooksByEvent: normalizeEventMapHooks(hooks), otherFields };
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }
}

/** Legacy command strings that identify selftune-installed hooks (before the _selftune marker). */
const LEGACY_SELFTUNE_COMMANDS = new Set([
  "npx selftune codex hook",
  "npx -y selftune@latest codex hook",
  "npx -y selftune codex hook",
]);

/** Check if a hook entry was installed by selftune. */
function isSelftuneHook(entry: CodexHookHandler): boolean {
  if (entry._selftune === true) return true;
  // Exact match against known legacy commands only
  if (typeof entry.command !== "string") return false;
  return entry.command === HOOK_COMMAND || LEGACY_SELFTUNE_COMMANDS.has(entry.command);
}

function stripSelftuneHooks(existing: CodexHooksByEvent): {
  hooksByEvent: CodexHooksByEvent;
  removedCount: number;
} {
  const hooksByEvent: CodexHooksByEvent = {};
  let removedCount = 0;

  for (const [eventName, groups] of Object.entries(existing)) {
    const cleanedGroups: CodexMatcherGroup[] = [];

    for (const group of groups) {
      const preservedHooks = group.hooks.filter((handler) => !isSelftuneHook(handler));
      removedCount += group.hooks.length - preservedHooks.length;
      if (preservedHooks.length > 0) {
        cleanedGroups.push({
          ...group,
          hooks: preservedHooks.map((handler) => ({ ...handler })),
        });
      }
    }

    if (cleanedGroups.length > 0) {
      hooksByEvent[eventName] = cleanedGroups;
    }
  }

  return { hooksByEvent, removedCount };
}

/** Merge selftune hooks into existing hooks, replacing any previous selftune entries. */
export function mergeHooks(
  existing: CodexHooksByEvent,
  incoming: CodexHooksByEvent,
): CodexHooksByEvent {
  const { hooksByEvent } = stripSelftuneHooks(existing);
  const merged = cloneHooksByEvent(hooksByEvent);

  for (const [eventName, groups] of Object.entries(incoming)) {
    merged[eventName] = [
      ...(merged[eventName] ?? []),
      ...cloneHooksByEvent({ [eventName]: groups })[eventName],
    ];
  }

  return merged;
}

/** Remove all selftune hooks from the list. */
export function removeSelftuneHooks(existing: CodexHooksByEvent): CodexHooksByEvent {
  return stripSelftuneHooks(existing).hooksByEvent;
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
  const existingHooks = hooksFile.hooksByEvent;
  const merged = mergeHooks(existingHooks, SELFTUNE_HOOKS);
  const serializedExisting = serializeHooksByEvent(existingHooks);
  const serializedMerged = serializeHooksByEvent(merged);

  // Compare the persisted shape; _selftune markers are internal only.
  const existingJson = JSON.stringify(serializedExisting);
  const mergedJson = JSON.stringify(serializedMerged);

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
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          ...hooksFile.otherFields,
          hooks: serializedMerged,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  }

  const { removedCount } = stripSelftuneHooks(existingHooks);

  return {
    hooksPath,
    action: "installed",
    hooksWritten: Object.keys(SELFTUNE_HOOKS).length,
    hooksRemoved: removedCount,
    dryRun: options.dryRun ?? false,
  };
}

export function uninstallHooks(options: { dryRun?: boolean } = {}): InstallResult {
  const hooksPath = getCodexHooksPath();
  const hooksFile = readHooksFile(hooksPath);
  const existingHooks = hooksFile.hooksByEvent;
  const { hooksByEvent: cleaned, removedCount } = stripSelftuneHooks(existingHooks);

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
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          ...hooksFile.otherFields,
          hooks: serializeHooksByEvent(cleaned),
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
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
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const uninstall = args.has("--uninstall");

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
