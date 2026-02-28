#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook: skill-eval.ts
 *
 * Fires whenever Claude reads a file. If that file is a SKILL.md, this hook:
 *   1. Finds the triggering user query from the transcript JSONL
 *   2. Appends a usage record to ~/.claude/skill_usage_log.jsonl
 *
 * This builds a real-usage eval dataset over time, seeding the
 * `should_trigger: true` half of trigger evals.
 */

import { basename, dirname } from "node:path";
import { SKILL_LOG } from "../constants.js";
import type { PostToolUsePayload, SkillUsageRecord } from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";
import { getLastUserMessage } from "../utils/transcript.js";

/**
 * Extract the skill folder name from a file path ending in SKILL.md.
 * Returns null if this doesn't look like a skill file.
 */
export function extractSkillName(filePath: string): string | null {
  if (basename(filePath).toUpperCase() !== "SKILL.MD") return null;
  return basename(dirname(filePath)) || "unknown";
}

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 */
export function processToolUse(
  payload: PostToolUsePayload,
  logPath: string = SKILL_LOG,
): SkillUsageRecord | null {
  // Only care about Read tool
  if (payload.tool_name !== "Read") return null;

  const filePath = (payload.tool_input?.file_path as string) ?? "";
  const skillName = extractSkillName(filePath);

  if (skillName === null) return null;

  const transcriptPath = payload.transcript_path ?? "";
  const sessionId = payload.session_id ?? "unknown";

  const query = getLastUserMessage(transcriptPath) ?? "(query not found)";

  const record: SkillUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill_name: skillName,
    skill_path: filePath,
    query,
    triggered: true,
    source: "claude_code",
  };

  appendJsonl(logPath, record);
  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: PostToolUsePayload = JSON.parse(await Bun.stdin.text());
    processToolUse(payload);
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
