import type { SkillUsageRecord } from "../types.js";

const HIGH_CONFIDENCE_POSITIVE_SOURCES = new Set([
  "claude_code_replay",
  "claude_code_repair",
  "codex_rollout_explicit",
]);

export function isHighConfidencePositiveSkillRecord(
  record: SkillUsageRecord,
  skillName?: string,
): boolean {
  if (!record || record.triggered !== true) return false;
  if (skillName && record.skill_name !== skillName) return false;

  const source = record.source?.trim();
  return !source || HIGH_CONFIDENCE_POSITIVE_SOURCES.has(source);
}
