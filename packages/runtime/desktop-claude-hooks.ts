import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";

import {
  ClaudeCodeSettings,
  type ClaudeCodeHookEntry,
  type ClaudeCodeHooks,
  isSelftuneCommand,
} from "./utils/hooks.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function windowsQuote(value: string): string {
  if (value.includes('"') || value.includes("\u0000") || /[\r\n]/.test(value)) {
    throw new Error(
      "The SelfTune executable path cannot be represented in a Windows hook command.",
    );
  }
  return `"${value}"`;
}

export function buildPackagedClaudeHookCommand(
  executablePath: string,
  hookName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!/^[a-z0-9-]+$/.test(hookName)) {
    throw new Error(`Invalid SelfTune hook name: ${hookName}`);
  }
  const executable =
    platform === "win32" ? windowsQuote(executablePath) : shellQuote(executablePath);
  return `${executable} hook ${hookName}`;
}

function replaceHookCommands(
  value: ClaudeCodeHookEntry,
  executablePath: string,
  platform: NodeJS.Platform,
): ClaudeCodeHookEntry {
  if (value.command !== undefined) {
    const hookName = value.command.match(/[\\/]hooks[\\/]([a-z0-9-]+)\.ts(?:\s|$)/)?.[1];
    if (hookName) {
      return {
        ...value,
        command: buildPackagedClaudeHookCommand(executablePath, hookName, platform),
      };
    }
  }

  const next = { ...value };
  if (value.hooks !== undefined) {
    next.hooks = value.hooks.map((hook) => {
      const hookName = hook.command?.match(/[\\/]hooks[\\/]([a-z0-9-]+)\.ts(?:\s|$)/)?.[1];
      return hookName
        ? { ...hook, command: buildPackagedClaudeHookCommand(executablePath, hookName, platform) }
        : hook;
    });
  }
  return next;
}

function removeManagedHooks(value: ClaudeCodeHookEntry): ClaudeCodeHookEntry | null {
  if (value.command !== undefined && isSelftuneCommand(value.command)) return null;
  if (value.hooks === undefined) return value;

  const hooks = value.hooks.filter(
    (hook) => hook.command === undefined || !isSelftuneCommand(hook.command),
  );
  if (hooks.length === 0) return null;
  return { ...value, hooks };
}

export function installPackagedClaudeHooks(options: {
  executablePath: string;
  platform?: NodeJS.Platform;
  snippetPath: string;
  settingsPath?: string;
}): string[] {
  const settingsPath = options.settingsPath ?? join(homedir(), ".claude", "settings.json");
  if (!existsSync(options.snippetPath)) {
    throw new Error(`Claude Code hook template is missing at ${options.snippetPath}.`);
  }

  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeCodeSettings));
  const snippet = decode(readFileSync(options.snippetPath, "utf8"));
  if (snippet.hooks === undefined) {
    throw new Error("Claude Code hook template has no hooks object.");
  }

  let settings: ClaudeCodeSettings = {};
  if (existsSync(settingsPath)) {
    settings = decode(readFileSync(settingsPath, "utf8"));
  }
  const existingHooks = settings.hooks ?? {};
  const nextHooks: ClaudeCodeHooks = { ...existingHooks };
  const changedKeys: string[] = [];

  for (const [eventName, rawEntries] of Object.entries(snippet.hooks)) {
    const retained = (existingHooks[eventName] ?? [])
      .map(removeManagedHooks)
      .filter((entry): entry is Exclude<typeof entry, null> => entry !== null);
    const managed = rawEntries.map((entry) =>
      replaceHookCommands(entry, options.executablePath, options.platform ?? process.platform),
    );
    const nextEntries = [...retained, ...managed];
    if (JSON.stringify(existingHooks[eventName] ?? []) !== JSON.stringify(nextEntries)) {
      changedKeys.push(eventName);
    }
    nextHooks[eventName] = nextEntries;
  }

  if (changedKeys.length > 0) {
    settings.hooks = nextHooks;
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, settingsPath);
  }
  return changedKeys;
}
