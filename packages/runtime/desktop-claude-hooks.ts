import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isSelftuneCommand } from "./utils/hooks.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  value: unknown,
  executablePath: string,
  platform: NodeJS.Platform,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceHookCommands(entry, executablePath, platform));
  }
  if (!isRecord(value)) return value;

  if (typeof value.command === "string") {
    const hookName = value.command.match(/[\\/]hooks[\\/]([a-z0-9-]+)\.ts(?:\s|$)/)?.[1];
    if (hookName) {
      return {
        ...value,
        command: buildPackagedClaudeHookCommand(executablePath, hookName, platform),
      };
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      replaceHookCommands(entry, executablePath, platform),
    ]),
  );
}

function removeManagedHooks(value: unknown): unknown | null {
  if (!isRecord(value)) return value;
  if (typeof value.command === "string" && isSelftuneCommand(value.command)) return null;
  if (!Array.isArray(value.hooks)) return value;

  const hooks = value.hooks.filter(
    (hook) =>
      !isRecord(hook) || typeof hook.command !== "string" || !isSelftuneCommand(hook.command),
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

  const snippet: unknown = JSON.parse(readFileSync(options.snippetPath, "utf8"));
  if (!isRecord(snippet) || !isRecord(snippet.hooks)) {
    throw new Error("Claude Code hook template has no hooks object.");
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isRecord(parsed)) throw new Error(`Claude Code settings at ${settingsPath} are invalid.`);
    settings = parsed;
  }
  const existingHooks = isRecord(settings.hooks) ? settings.hooks : {};
  const nextHooks: Record<string, unknown> = { ...existingHooks };
  const changedKeys: string[] = [];

  for (const [eventName, rawEntries] of Object.entries(snippet.hooks)) {
    if (!Array.isArray(rawEntries)) continue;
    const retained = Array.isArray(existingHooks[eventName])
      ? existingHooks[eventName]
          .map(removeManagedHooks)
          .filter((entry): entry is Exclude<typeof entry, null> => entry !== null)
      : [];
    const managed = replaceHookCommands(
      rawEntries,
      options.executablePath,
      options.platform ?? process.platform,
    );
    const nextEntries = [...retained, ...(Array.isArray(managed) ? managed : [])];
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
