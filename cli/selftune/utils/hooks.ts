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

export function entryReferencesSelftune(entry: ClaudeCodeHookEntry): boolean {
  if (typeof entry.command === "string" && entry.command.includes("selftune")) {
    return true;
  }

  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(
      (hook) => typeof hook.command === "string" && hook.command.includes("selftune"),
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
