#!/usr/bin/env bun
/**
 * Claude Code Stop hook: session-stop.ts
 *
 * Fires when a Claude Code session ends. Reads the session's transcript JSONL
 * and extracts process-level telemetry (tool calls, errors, skills triggered, etc).
 * Appends one record per session to ~/.claude/session_telemetry_log.jsonl.
 */

import { CANONICAL_LOG, TELEMETRY_LOG } from "../constants.js";
import {
  appendCanonicalRecords,
  buildCanonicalExecutionFact,
  buildCanonicalSession,
  type CanonicalBaseInput,
  getLatestPromptIdentity,
} from "../normalization.js";
import type { SessionTelemetryRecord, StopPayload } from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";
import { parseTranscript } from "../utils/transcript.js";

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended.
 */
export function processSessionStop(
  payload: StopPayload,
  logPath: string = TELEMETRY_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  promptStatePath?: string,
): SessionTelemetryRecord {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";

  const metrics = parseTranscript(transcriptPath);

  const record: SessionTelemetryRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    source: "claude_code",
    ...metrics,
  };

  appendJsonl(logPath, record);

  // Emit canonical session + execution fact records (additive)
  const baseInput: CanonicalBaseInput = {
    platform: "claude_code",
    capture_mode: "hook",
    source_session_kind: "interactive",
    session_id: sessionId,
    raw_source_ref: {
      path: transcriptPath || undefined,
      event_type: "Stop",
    },
  };
  const latestPrompt = getLatestPromptIdentity(sessionId, promptStatePath);

  const canonicalSession = buildCanonicalSession({
    ...baseInput,
    workspace_path: cwd || undefined,
  });

  const canonicalFact = buildCanonicalExecutionFact({
    ...baseInput,
    occurred_at: record.timestamp,
    prompt_id: latestPrompt.last_actionable_prompt_id ?? latestPrompt.last_prompt_id,
    tool_calls_json: metrics.tool_calls,
    total_tool_calls: metrics.total_tool_calls,
    bash_commands_redacted: metrics.bash_commands,
    assistant_turns: metrics.assistant_turns,
    errors_encountered: metrics.errors_encountered,
  });
  appendCanonicalRecords([canonicalSession, canonicalFact], canonicalLogPath);

  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: StopPayload = JSON.parse(await Bun.stdin.text());
    processSessionStop(payload);
  } catch (err) {
    // silent — hooks must never block Claude
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("session-stop hook failed:", err);
    }
  }
  process.exit(0);
}
