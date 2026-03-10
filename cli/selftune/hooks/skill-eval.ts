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

import { existsSync, readFileSync } from "node:fs";
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
 * Check whether the transcript contains a Skill tool invocation for the given
 * skill name, indicating an actual skill use rather than casual browsing.
 * Scans the transcript backwards for efficiency.
 */
export function hasSkillToolInvocation(transcriptPath: string, skillName: string): boolean {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      const msg = (entry.message as Record<string, unknown>) ?? entry;
      const role = (msg.role as string) ?? (entry.role as string) ?? "";
      if (role !== "assistant") continue;

      const entryContent = msg.content ?? entry.content ?? "";
      if (!Array.isArray(entryContent)) continue;

      for (const block of entryContent) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;

        const toolName = (b.name as string) ?? "";
        if (toolName === "Skill") {
          const inp = (b.input as Record<string, unknown>) ?? {};
          const skillArg = (inp.skill as string) ?? (inp.name as string) ?? "";
          if (skillArg === skillName) return true;
        }
      }
    }
  } catch {
    // silent — hooks must never block Claude
  }

  return false;
}

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 *
 * To reduce false triggers, checks whether the Read of SKILL.md was
 * preceded by an actual Skill tool invocation in the same transcript.
 * If not, the record is still logged but marked as triggered: false.
 */
export function processToolUse(
  payload: PostToolUsePayload,
  logPath: string = SKILL_LOG,
): SkillUsageRecord | null {
  // Only care about Read tool
  if (payload.tool_name !== "Read") return null;

  const rawPath = payload.tool_input?.file_path;
  const filePath = typeof rawPath === "string" ? rawPath : "";
  const skillName = extractSkillName(filePath);

  if (skillName === null) return null;

  const transcriptPath = payload.transcript_path ?? "";
  const sessionId = payload.session_id ?? "unknown";

  const query = getLastUserMessage(transcriptPath);
  if (!query) return null;

  // Distinguish actual invocation from browsing by checking for a Skill tool call
  const wasInvoked = hasSkillToolInvocation(transcriptPath, skillName);

  const record: SkillUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill_name: skillName,
    skill_path: filePath,
    query,
    triggered: wasInvoked,
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
