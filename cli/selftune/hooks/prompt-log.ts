#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook: prompt-log.ts
 *
 * Fires on every user message before Claude processes it.
 * Writes the query to SQLite via writeQueryToDb() so that
 * hooks-to-evals can identify prompts that did NOT trigger
 * a skill — the raw material for false-negative eval entries.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CANONICAL_LOG, QUERY_LOG, SKIP_PREFIXES } from "../constants.js";
import {
  appendCanonicalRecord,
  buildCanonicalPrompt,
  type CanonicalBaseInput,
  classifyIsActionable,
  reservePromptIdentity,
} from "../normalization.js";
import type { ImprovementSignalRecord, PromptSubmitPayload, QueryLogRecord } from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";

// ---------------------------------------------------------------------------
// Installed skill name cache
// ---------------------------------------------------------------------------

let cachedSkillNames: string[] | null = null;

/**
 * Read directory names from ~/.claude/skills. Cached after first call.
 * Returns empty array on any error (graceful degradation).
 */
export function getInstalledSkillNames(): string[] {
  if (cachedSkillNames !== null) return cachedSkillNames;
  try {
    const skillsDir = join(homedir(), ".claude", "skills");
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    cachedSkillNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    cachedSkillNames = [];
  }
  return cachedSkillNames;
}

// ---------------------------------------------------------------------------
// Signal detection patterns
// ---------------------------------------------------------------------------

interface SignalPattern {
  regex: RegExp;
  signal_type: "correction" | "explicit_request";
  /** Named capture group index for the skill name. */
  skillGroup: string;
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  // "why didn't you use/run/invoke X" → correction
  {
    regex: /why\s+didn['']t\s+you\s+(?:use|run|invoke)\s+(?:the\s+)?(?<skill>[\w-]+)/i,
    signal_type: "correction",
    skillGroup: "skill",
  },
  // "you should have used X" → correction
  {
    regex: /you\s+should\s+have\s+used\s+(?:the\s+)?(?<skill>[\w-]+)/i,
    signal_type: "correction",
    skillGroup: "skill",
  },
  // "next time use X" → correction
  {
    regex: /next\s+time\s+use\s+(?:the\s+)?(?<skill>[\w-]+)/i,
    signal_type: "correction",
    skillGroup: "skill",
  },
  // "forgot to use X" → correction
  {
    regex: /forgot\s+to\s+use\s+(?:the\s+)?(?<skill>[\w-]+)/i,
    signal_type: "correction",
    skillGroup: "skill",
  },
  // "please use X skill" / "please use the X skill" → explicit_request
  {
    regex: /please\s+use\s+(?:the\s+)?(?<skill>[\w-]+)\s+skill/i,
    signal_type: "explicit_request",
    skillGroup: "skill",
  },
  // "use the X skill" → explicit_request (must have "the" and "skill" to avoid false positives)
  {
    regex: /\buse\s+the\s+(?<skill>[\w-]+)\s+skill/i,
    signal_type: "explicit_request",
    skillGroup: "skill",
  },
];

/**
 * Detect whether a user query contains an improvement signal.
 * Pure regex — no LLM, no network.
 */
export function detectImprovementSignal(
  query: string,
  sessionId: string,
  installedSkills?: string[],
): ImprovementSignalRecord | null {
  const skills = installedSkills ?? getInstalledSkillNames();
  const skillsLower = skills.map((s) => s.toLowerCase());

  for (const pattern of SIGNAL_PATTERNS) {
    const match = query.match(pattern.regex);
    if (!match?.groups?.[pattern.skillGroup]) continue;

    const rawSkill = match.groups[pattern.skillGroup];

    // Skip generic words that aren't skill names
    const genericWords = new Set(["strict", "git", "the", "a", "an", "this", "that", "it", "my"]);
    if (genericWords.has(rawSkill.toLowerCase())) continue;

    // Try to match against installed skills (case-insensitive)
    let mentionedSkill: string | undefined;
    const idx = skillsLower.indexOf(rawSkill.toLowerCase());
    if (idx !== -1) {
      mentionedSkill = skills[idx];
    } else {
      // Use the raw captured name if it looks like a skill (capitalized or known)
      mentionedSkill = rawSkill;
    }

    return {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      query,
      signal_type: pattern.signal_type,
      mentioned_skill: mentionedSkill,
      consumed: false,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core prompt processing
// ---------------------------------------------------------------------------

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 */
export async function processPrompt(
  payload: PromptSubmitPayload,
  logPath: string = QUERY_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  promptStatePath?: string,
  _signalLogPath?: string,
): Promise<QueryLogRecord | null> {
  const query = (payload.user_prompt ?? "").trim();

  if (!query) return null;

  // Skip automated/tool messages
  if (SKIP_PREFIXES.some((p) => query.startsWith(p))) return null;

  // Skip very short noise (single chars, punctuation)
  if (query.length < 4) return null;

  const record: QueryLogRecord = {
    timestamp: new Date().toISOString(),
    session_id: payload.session_id ?? "unknown",
    query,
  };

  // Write to SQLite (dynamic import to reduce hook startup cost)
  try {
    const { writeQueryToDb } = await import("../localdb/direct-write.js");
    writeQueryToDb(record);
  } catch {
    /* hooks must never block */
  }

  // JSONL backup (best-effort, hooks must never block)
  try {
    appendJsonl(logPath, record);
  } catch {
    /* hooks must never block */
  }

  // Emit canonical prompt record (additive)
  const baseInput: CanonicalBaseInput = {
    platform: "claude_code",
    capture_mode: "hook",
    source_session_kind: "interactive",
    session_id: record.session_id,
    raw_source_ref: { event_type: "UserPromptSubmit" },
  };
  const isActionable = classifyIsActionable(query);
  const promptIdentity = reservePromptIdentity(
    record.session_id,
    isActionable,
    promptStatePath,
    canonicalLogPath,
  );
  const canonical = buildCanonicalPrompt({
    ...baseInput,
    prompt_id: promptIdentity.prompt_id,
    occurred_at: record.timestamp,
    prompt_text: query,
    prompt_index: promptIdentity.prompt_index,
    is_actionable: isActionable,
  });
  appendCanonicalRecord(canonical, canonicalLogPath);

  // Detect and log improvement signals (never throws, dynamic import to reduce hook startup cost)
  try {
    const signal = detectImprovementSignal(query, record.session_id);
    if (signal) {
      const { writeImprovementSignalToDb } = await import("../localdb/direct-write.js");
      writeImprovementSignalToDb(signal);
    }
  } catch {
    // silent — hooks must never block Claude
  }

  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: PromptSubmitPayload = JSON.parse(await Bun.stdin.text());
    await processPrompt(payload);
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
