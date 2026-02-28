#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook: prompt-log.ts
 *
 * Fires on every user message before Claude processes it.
 * Logs the query to ~/.claude/all_queries_log.jsonl so that
 * hooks-to-evals can identify prompts that did NOT trigger
 * a skill — the raw material for false-negative eval entries.
 */

import { QUERY_LOG, SKIP_PREFIXES } from "../constants.js";
import type { PromptSubmitPayload, QueryLogRecord } from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 */
export function processPrompt(
  payload: PromptSubmitPayload,
  logPath: string = QUERY_LOG,
): QueryLogRecord | null {
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

  appendJsonl(logPath, record);
  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: PromptSubmitPayload = JSON.parse(await Bun.stdin.text());
    processPrompt(payload);
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
