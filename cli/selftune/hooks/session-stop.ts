#!/usr/bin/env bun
/**
 * Claude Code Stop hook: session-stop.ts
 *
 * Fires when a Claude Code session ends. Reads the session's transcript JSONL
 * and extracts process-level telemetry (tool calls, errors, skills triggered, etc).
 * Appends one record per session to ~/.claude/session_telemetry_log.jsonl.
 */

import { TELEMETRY_LOG } from "../constants.js";
import type { SessionTelemetryRecord, StopPayload } from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";
import { parseTranscript } from "../utils/transcript.js";

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 */
export function processSessionStop(
  payload: StopPayload,
  logPath: string = TELEMETRY_LOG,
): SessionTelemetryRecord | null {
  const sessionId = payload.session_id ?? "unknown";
  const transcriptPath = payload.transcript_path ?? "";
  const cwd = payload.cwd ?? "";

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
  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: StopPayload = JSON.parse(await Bun.stdin.text());
    processSessionStop(payload);
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
