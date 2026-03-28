import { CLAUDE_CODE_HOOK_KEYS } from "../constants.js";

export interface ClaudeCodeHookCommand {
  command?: string;
}

export interface ClaudeCodeHookEntry {
  command?: string;
  hooks?: ClaudeCodeHookCommand[];
}

function isHookEntry(value: unknown): value is ClaudeCodeHookEntry {
  return typeof value === "object" && value !== null;
}

/** Check if a command string references a selftune-managed hook. */
export function isSelftuneCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return (
    normalized.includes("/cli/selftune/hooks/") ||
    normalized.includes("/bin/run-hook.cjs") ||
    normalized.startsWith("npx selftune hook ")
  );
}

export function entryReferencesSelftune(entry: ClaudeCodeHookEntry): boolean {
  if (typeof entry.command === "string" && isSelftuneCommand(entry.command)) {
    return true;
  }

  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(
      (hook) => typeof hook.command === "string" && isSelftuneCommand(hook.command),
    );
  }

  return false;
}

export function hookKeyHasSelftuneEntry(hooks: Record<string, unknown>, key: string): boolean {
  const entries = hooks[key];
  if (!Array.isArray(entries) || entries.length === 0) {
    return false;
  }

  return entries.some((entry) => isHookEntry(entry) && entryReferencesSelftune(entry));
}

export function missingClaudeCodeHookKeys(hooks: Record<string, unknown>): string[] {
  return CLAUDE_CODE_HOOK_KEYS.filter((key) => !hookKeyHasSelftuneEntry(hooks, key));
}
