import { SKIP_PREFIXES } from "../constants.js";
import type { QueryLogRecord, SkillUsageRecord } from "../types.js";

const NON_USER_QUERY_PREFIXES = [
  "<system_instruction>",
  "<system-instruction>",
  "<system-reminder>",
  "<available-deferred-tools>",
  "<fast_mode_info>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<task-notification>",
  "<teammate-message",
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
  "Base directory for this skill:",
  "This session is being continued from a previous conversation that ran out of context.",
  "USER'S CURRENT MESSAGE (summarize THIS):",
  "CONTEXT:",
  "Completing task",
  "Tool loaded.",
  "Continue from where you left off.",
  "You are an evaluation assistant.",
  "You are a skill description optimizer for an AI agent routing system.",
  "The following skills are available",
] as const;

/**
 * Regex patterns for wrapper/hook pipeline artifacts that are never real user prompts.
 * These fire after prefix checks and cover structured hook callback lines.
 */
const NON_USER_QUERY_PATTERNS = [
  // Hook callback output lines (e.g. "SessionStart:startup hook success: ...")
  // "Stop" excluded from general alternation — too common as English word.
  /^(SessionStart|UserPromptSubmit|PreToolUse|PostToolUse):/,
  // Stop hook callbacks follow a structured shape: "Stop:" + lowercase/callback text
  /^Stop:(session |cleanup |hook |Callback )/,
  // Injected git context blocks
  /^gitStatus:\s/,
] as const;

const LEADING_WRAPPED_QUERY_TAGS = [
  "system_instruction",
  "system-instruction",
  "system-reminder",
  "available-deferred-tools",
  "fast_mode_info",
  "task-notification",
  "teammate-message",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
] as const;

function stripLeadingWrappedQueryText(query: string): string {
  let current = query.trim();

  for (;;) {
    let changed = false;

    for (const tag of LEADING_WRAPPED_QUERY_TAGS) {
      const pattern = new RegExp(`^<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>\\s*`, "i");
      const next = current.replace(pattern, "").trim();
      if (next !== current) {
        current = next;
        changed = true;
        break;
      }
    }

    if (!changed) return current;
  }
}

export function extractActionableQueryText(query: string): string | null {
  if (typeof query !== "string") return null;

  const trimmed = query.trim();
  if (!trimmed || trimmed === "-" || trimmed === "(query not found)") return null;

  const candidate = stripLeadingWrappedQueryText(trimmed) || trimmed;
  if (!candidate || candidate === "-" || candidate === "(query not found)") return null;

  const isBlocked =
    SKIP_PREFIXES.some((prefix) => candidate.startsWith(prefix)) ||
    NON_USER_QUERY_PREFIXES.some((prefix) => candidate.startsWith(prefix)) ||
    NON_USER_QUERY_PATTERNS.some((pattern) => pattern.test(candidate));

  return isBlocked ? null : candidate;
}

export function isActionableQueryText(query: string): boolean {
  return extractActionableQueryText(query) !== null;
}

export function filterActionableQueryRecords(queryRecords: QueryLogRecord[]): QueryLogRecord[] {
  const actionable: QueryLogRecord[] = [];

  for (const record of queryRecords) {
    if (record == null) continue;
    const normalizedQuery = extractActionableQueryText((record as QueryLogRecord).query);
    if (!normalizedQuery) continue;
    actionable.push(
      normalizedQuery === record.query ? record : { ...record, query: normalizedQuery },
    );
  }

  return actionable;
}

export function isActionableSkillUsageRecord(record: SkillUsageRecord | null | undefined): boolean {
  if (record == null) return false;
  if (typeof record.skill_name !== "string" || !record.skill_name.trim()) return false;
  if (typeof record.query !== "string") return false;

  const query = record.query.trim();
  if (!query || query === "(query not found)") return false;

  return extractActionableQueryText(query) !== null;
}

export function filterActionableSkillUsageRecords(
  skillRecords: SkillUsageRecord[],
): SkillUsageRecord[] {
  const actionable: SkillUsageRecord[] = [];

  for (const record of skillRecords) {
    const normalizedQuery = extractActionableQueryText(record?.query);
    if (!normalizedQuery) continue;
    actionable.push(
      normalizedQuery === record.query ? record : { ...record, query: normalizedQuery },
    );
  }

  return actionable;
}
