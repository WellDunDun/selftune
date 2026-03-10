#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook: prompt-log.ts
 *
 * Fires on every user message before Claude processes it.
 * Logs the query to ~/.claude/all_queries_log.jsonl so that
 * hooks-to-evals can identify prompts that did NOT trigger
 * a skill — the raw material for false-negative eval entries.
 */

import { CANONICAL_LOG, QUERY_LOG, SKIP_PREFIXES } from "../constants.js";
import {
  appendCanonicalRecord,
  buildCanonicalPrompt,
  type CanonicalBaseInput,
  classifyIsActionable,
  reservePromptIdentity,
} from "../normalization.js";
import type { PromptSubmitPayload, QueryLogRecord } from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 */
export function processPrompt(
  payload: PromptSubmitPayload,
  logPath: string = QUERY_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  promptStatePath?: string,
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
