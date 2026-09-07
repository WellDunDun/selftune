import { CLAUDE_CODE_HOOK_KEYS } from "../constants.js";
import { Option, Schema } from "effect";

export const ClaudeCodeHookCommand = Schema.StructWithRest(
  Schema.Struct({ command: Schema.optionalKey(Schema.mutableKey(Schema.String)) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type ClaudeCodeHookCommand = typeof ClaudeCodeHookCommand.Type;
export const ClaudeCodeHookEntry = Schema.StructWithRest(
  Schema.Struct({
    command: Schema.optionalKey(Schema.String),
    hooks: Schema.optionalKey(
      Schema.mutableKey(Schema.mutable(Schema.Array(ClaudeCodeHookCommand))),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type ClaudeCodeHookEntry = typeof ClaudeCodeHookEntry.Type;
export const ClaudeCodeHooks = Schema.Record(
  Schema.String,
  Schema.mutableKey(Schema.mutable(Schema.Array(ClaudeCodeHookEntry))),
);
export type ClaudeCodeHooks = typeof ClaudeCodeHooks.Type;
export const ClaudeCodeSettings = Schema.StructWithRest(
  Schema.Struct({ hooks: Schema.optionalKey(Schema.mutableKey(ClaudeCodeHooks)) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type ClaudeCodeSettings = typeof ClaudeCodeSettings.Type;

/** Check if a command string references a selftune-managed hook. */
export function isSelftuneCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return (
    normalized.includes("/cli/selftune/hooks/") ||
    normalized.includes("/bin/run-hook.cjs") ||
    normalized.includes("/selftune-hook-") ||
    /(?:^|\/)selftune(?:\.exe)?["']?\s+hook\s+[a-z0-9-]+(?:\s|$)/i.test(normalized) ||
    normalized.startsWith("npx selftune hook ")
  );
}

export function entryReferencesSelftune(entry: ClaudeCodeHookEntry): boolean {
  if (entry.command !== undefined && isSelftuneCommand(entry.command)) {
    return true;
  }

  if (entry.hooks !== undefined) {
    return entry.hooks.some(
      (hook) => hook.command !== undefined && isSelftuneCommand(hook.command),
    );
  }

  return false;
}

export function hookKeyHasSelftuneEntry(
  hooks: Readonly<Record<string, Schema.Json>>,
  key: string,
): boolean {
  const entries = hooks[key];
  if (!Array.isArray(entries) || entries.length === 0) {
    return false;
  }

  return entries.some((entry) => {
    const decoded = Schema.decodeUnknownOption(ClaudeCodeHookEntry)(entry);
    return Option.isSome(decoded) && entryReferencesSelftune(decoded.value);
  });
}

export function missingClaudeCodeHookKeys(hooks: Readonly<Record<string, Schema.Json>>): string[] {
  return CLAUDE_CODE_HOOK_KEYS.filter((key) => !hookKeyHasSelftuneEntry(hooks, key));
}
