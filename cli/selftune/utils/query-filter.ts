import { SKIP_PREFIXES } from "../constants.js";
import type { QueryLogRecord, SkillUsageRecord } from "../types.js";

const NON_USER_QUERY_PREFIXES = [
  "<system_instruction>",
  "<system-instruction>",
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
] as const;

export function isActionableQueryText(query: string): boolean {
  if (typeof query !== "string") return false;
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (trimmed === "-") return false;

  return (
    !SKIP_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) &&
    !NON_USER_QUERY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  );
}

export function filterActionableQueryRecords(queryRecords: QueryLogRecord[]): QueryLogRecord[] {
  return queryRecords.filter(
    (record) => record != null && isActionableQueryText((record as QueryLogRecord).query),
  );
}

export function isActionableSkillUsageRecord(record: SkillUsageRecord | null | undefined): boolean {
  if (record == null) return false;
  if (typeof record.skill_name !== "string" || !record.skill_name.trim()) return false;
  if (typeof record.query !== "string") return false;

  const query = record.query.trim();
  if (!query || query === "(query not found)") return false;

  return isActionableQueryText(query);
}

export function filterActionableSkillUsageRecords(
  skillRecords: SkillUsageRecord[],
): SkillUsageRecord[] {
  return skillRecords.filter((record) => isActionableSkillUsageRecord(record));
}
