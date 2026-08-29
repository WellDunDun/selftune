import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { classifyPromptKind } from "@selftune/runtime/normalization";

export const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function truncateToBytes(value: string, limit: number): string {
  let result = "";
  for (const character of value) {
    if (byteLength(`${result}${character}`) > limit) break;
    result += character;
  }
  return result;
}

export const redactedPortableText = (value: string): string =>
  value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]");

function removeExplicitSkillInvocation(value: string, skillName?: string): string {
  const normalized = skillName?.trim();
  if (!normalized) return value;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`(?:^|\\s)/${escaped}(?=\\s|$)`, "gi"), " ").trim();
}

export function boundedHistoricalTask(
  value: string | null | undefined,
  invokedSkillName?: string,
): string | null {
  const task = value ? removeExplicitSkillInvocation(value.trim(), invokedSkillName) : undefined;
  if (!task || classifyPromptKind(task) !== "user") return null;
  if (
    task.startsWith("<in-app-browser-context") ||
    task.startsWith("<task-notification") ||
    task.startsWith("You are a worker subagent")
  ) {
    return null;
  }
  return truncateToBytes(redactedPortableText(task), 512).trim() || null;
}

export function latestPackageMtimeMs(packagePath: string): number {
  let latest = statSync(packagePath).mtimeMs;
  for (const entry of readdirSync(packagePath, { withFileTypes: true })) {
    const path = join(packagePath, entry.name);
    latest = Math.max(
      latest,
      entry.isDirectory() ? latestPackageMtimeMs(path) : statSync(path).mtimeMs,
    );
  }
  return latest;
}

export function pathCanUseInstalledSnapshot(
  observedPath: string | null,
  installedPath: string,
): boolean {
  return (
    observedPath === null ||
    /^\([A-Za-z0-9_-]+:[A-Za-z0-9._-]+\)$/.test(observedPath) ||
    resolve(observedPath) === resolve(installedPath)
  );
}

export function bodyBelowTitle(content: string): string {
  const lines = content.split("\n");
  const title = lines.findIndex((line) => line.startsWith("# ") && !line.startsWith("## "));
  return (title === -1 ? content : lines.slice(title + 1).join("\n")).trim();
}

export function changedLineCount(before: string, after: string): number {
  const left = before.split("\n");
  const right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) {
    suffix++;
  }
  return Math.max(left.length - prefix - suffix, right.length - prefix - suffix);
}
