#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook: skill-change-guard.ts
 *
 * Fires before Write/Edit tool calls. If the target is a SKILL.md file,
 * outputs a suggestion to run `selftune watch --skill <name>` to monitor
 * the impact of the change.
 *
 * This is advisory only — exit code is always 0, never blocking.
 * Uses session state to avoid repeating suggestions for the same skill.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { sessionStatePath } from "../constants.js";
import type { PreToolUsePayload } from "../types.js";

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Check if a tool call is a Write or Edit targeting a SKILL.md file. */
export function isSkillMdWrite(toolName: string, filePath: string): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  return basename(filePath).toUpperCase() === "SKILL.MD";
}

/** Extract the skill folder name from a path ending in SKILL.md. */
export function extractSkillNameFromPath(filePath: string): string {
  return basename(dirname(filePath)) || "unknown";
}

// ---------------------------------------------------------------------------
// Session state (minimal — just tracks which skills we've already warned about)
// ---------------------------------------------------------------------------

interface GuardState {
  session_id: string;
  warned_skills: string[];
}

function loadGuardState(path: string, sessionId: string): GuardState {
  if (!existsSync(path)) {
    return { session_id: sessionId, warned_skills: [] };
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as GuardState;
    if (data.session_id === sessionId && Array.isArray(data.warned_skills)) {
      return data;
    }
  } catch {
    // corrupt — start fresh
  }
  return { session_id: sessionId, warned_skills: [] };
}

function saveGuardState(path: string, state: GuardState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Core processing logic
// ---------------------------------------------------------------------------

/**
 * Process a PreToolUse payload and return a suggestion string if the tool
 * call is writing to a SKILL.md file that hasn't been warned about yet.
 */
export function processPreToolUse(payload: PreToolUsePayload, statePath: string): string | null {
  const filePath =
    typeof payload.tool_input?.file_path === "string" ? payload.tool_input.file_path : "";

  if (!isSkillMdWrite(payload.tool_name, filePath)) return null;

  const skillName = extractSkillNameFromPath(filePath);
  const sessionId = payload.session_id ?? "unknown";

  // Check if we've already warned about this skill in this session
  const state = loadGuardState(statePath, sessionId);
  if (state.warned_skills.includes(skillName)) return null;

  // Record that we warned about this skill
  state.warned_skills.push(skillName);
  saveGuardState(statePath, state);

  return `Run \`selftune watch --skill ${skillName}\` to monitor the impact of this SKILL.md change.`;
}

// ---------------------------------------------------------------------------
// stdin main (only when executed directly, not when imported)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const payload: PreToolUsePayload = JSON.parse(await Bun.stdin.text());
    const sessionId = payload.session_id ?? "unknown";
    const statePath = sessionStatePath(sessionId);

    const suggestion = processPreToolUse(payload, statePath);
    if (suggestion) {
      process.stderr.write(`[selftune] 💡 Suggestion: ${suggestion}\n`);
    }
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
