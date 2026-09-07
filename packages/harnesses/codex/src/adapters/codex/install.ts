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

import { Option, Schema } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  JsonFields,
  CodexHooksByEvent,
  type CodexHookHandler,
  type CodexMatcherGroup,
} from "./hooks-config.js";
export { CodexHooksByEvent, CodexHooksFile } from "./hooks-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CodexHookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit" | "Stop";

const LegacyCodexHookEntry = Schema.StructWithRest(
  Schema.Struct({
    event: Schema.String,
    command: Schema.String,
  }),
  [JsonFields],
);
const LegacyCodexHooks = Schema.mutable(Schema.Array(LegacyCodexHookEntry));
const StoredCodexHooksFile = Schema.StructWithRest(
  Schema.Struct({
    hooks: Schema.optionalKey(Schema.Union([LegacyCodexHooks, CodexHooksByEvent])),
  }),
  [JsonFields],
);

interface ParsedCodexHooksFile {
  hooksByEvent: CodexHooksByEvent;
  otherFields: typeof JsonFields.Type;
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

function convertLegacyHooks(entries: typeof LegacyCodexHooks.Type): CodexHooksByEvent {
  const hooksByEvent: CodexHooksByEvent = {};
  for (const entry of entries) {
    const handler: CodexHookHandler = { type: "command", command: entry.command };
    const timeout = Schema.decodeUnknownOption(Schema.Finite)(entry.timeout_ms);
    if (Option.isSome(timeout)) handler.timeout = Math.max(1, Math.ceil(timeout.value / 1000));
    if (entry._selftune === true) handler._selftune = true;
    const matchers = Schema.decodeUnknownOption(Schema.Array(Schema.String))(entry.matchers);
    const groups = hooksByEvent[entry.event] ?? [];
    if (Option.isNone(matchers) || matchers.value.length === 0) {
      groups.push({ hooks: [{ ...handler }] });
    } else {
      for (const matcher of matchers.value) groups.push({ matcher, hooks: [{ ...handler }] });
    }
    hooksByEvent[entry.event] = groups;
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

    const { hooks, ...otherFields } = Schema.decodeUnknownSync(
      Schema.fromJsonString(StoredCodexHooksFile),
    )(raw);
    if (hooks === undefined) return { hooksByEvent: {}, otherFields };
    if (Schema.is(LegacyCodexHooks)(hooks)) {
      return { hooksByEvent: convertLegacyHooks(hooks), otherFields };
    }
    return { hooksByEvent: hooks, otherFields };
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
  if (entry.command === undefined) return false;
  return entry.command === HOOK_COMMAND || LEGACY_SELFTUNE_COMMANDS.has(entry.command);
}

function stripSelftuneHooks(existing: CodexHooksByEvent) {
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
