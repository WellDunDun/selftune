#!/usr/bin/env bun
/**
 * Claude Code transcript ingestor: claude-replay.ts
 *
 * Retroactively ingests Claude Code session transcripts into our shared
 * skill eval log format.
 *
 * Claude Code saves transcripts to:
 *   ~/.claude/projects/<hash>/<session-id>.jsonl
 *
 * This script scans those files and populates:
 *   ~/.claude/all_queries_log.jsonl
 *   ~/.claude/session_telemetry_log.jsonl
 *   ~/.claude/skill_usage_log.jsonl
 *
 * Usage:
 *   bun claude-replay.ts
 *   bun claude-replay.ts --since 2026-01-01
 *   bun claude-replay.ts --projects-dir /custom/path
 *   bun claude-replay.ts --dry-run
 *   bun claude-replay.ts --force
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import {
  CANONICAL_LOG,
  CLAUDE_CODE_MARKER,
  CLAUDE_CODE_PROJECTS_DIR,
  QUERY_LOG,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "@selftune/runtime/constants";
import {
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
} from "@selftune/runtime/localdb/direct-write";
import {
  appendCanonicalRecords,
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
  NORMALIZER_VERSION,
} from "@selftune/runtime/normalization";
import type {
  CanonicalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  TranscriptMetrics,
  TranscriptSkillInvocationEvent,
} from "@selftune/runtime/types";
import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
} from "@selftune/runtime/utils/jsonl";
import { isActionableQueryText } from "@selftune/runtime/utils/query-filter";
import {
  extractActionableUserQueries,
  findTranscriptFiles as findTranscriptFilesShared,
  parseTranscript,
} from "@selftune/runtime/utils/transcript";

export interface ParsedSession {
  transcript_path: string;
  session_id: string;
  timestamp: string;
  metrics: TranscriptMetrics;
  user_queries: Array<{ query: string; timestamp: string }>;
}

/**
 * Find all .jsonl transcript files under the Claude projects tree.
 *
 * Claude stores the main session transcript at:
 *   projects/<hash>/<session>.jsonl
 *
 * But newer sessions and agent-sidechains may also write nested transcripts such as:
 *   projects/<hash>/subagents/<agent>.jsonl
 *
 * We scan recursively so replay, repair, and canonical export see the full source-of-truth
 * transcript set instead of only top-level sessions.
 */
export function findTranscriptFiles(projectsDir: string, since?: Date): string[] {
  return findTranscriptFilesShared(projectsDir, since);
}

/**
 * Extract all user queries from a Claude Code transcript JSONL.
 *
 * Handles two transcript variants:
 *   Variant A: {"type": "user", "message": {"role": "user", "content": [...]}}
 *   Variant B: {"role": "user", "content": "..."}
 *
 * Filters out non-user/meta payloads and queries < 4 chars.
 */
export function extractAllUserQueries(
  transcriptPath: string,
): Array<{ query: string; timestamp: string }> {
  return extractActionableUserQueries(transcriptPath);
}

/**
 * Parse a Claude Code session transcript into a ParsedSession.
 * Returns null only when the file has neither an actionable prompt nor assistant execution.
 *
 * Claude subagent sidechains can contain tool results and assistant work without repeating
 * their parent prompt. They remain valid system-observability traces, but emit no prompt rows.
 */
export function parseSession(transcriptPath: string): ParsedSession | null {
  const metrics = parseTranscript(transcriptPath);
  const userQueries = extractAllUserQueries(transcriptPath);

  if (userQueries.length === 0 && metrics.assistant_turns === 0 && metrics.total_tool_calls === 0) {
    return null;
  }

  const sessionId = basename(transcriptPath, ".jsonl");

  // Prefer source timestamps, including for sidechains without an actionable prompt.
  let timestamp = userQueries[0]?.timestamp ?? metrics.started_at ?? "";
  if (!timestamp) {
    try {
      timestamp = statSync(transcriptPath).mtime.toISOString();
    } catch {
      timestamp = new Date().toISOString();
    }
  }

  return {
    transcript_path: transcriptPath,
    session_id: sessionId,
    timestamp,
    metrics,
    user_queries: userQueries,
  };
}

/**
 * Write parsed session data to shared JSONL logs.
 * Writes ONE QueryLogRecord per user query, ONE SessionTelemetryRecord per session,
 * and ONE SkillUsageRecord per triggered skill.
 */
export function writeSession(
  session: ParsedSession,
  dryRun = false,
  _queryLogPath: string = QUERY_LOG,
  _telemetryLogPath: string = TELEMETRY_LOG,
  _skillLogPath: string = SKILL_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  onDryRunMessage?: (message: string) => void,
): void {
  if (dryRun) {
    const message =
      `  [DRY RUN] Would ingest: session=${session.session_id.slice(0, 12)}... ` +
      `turns=${session.metrics.assistant_turns} queries=${session.user_queries.length} ` +
      `skills=${JSON.stringify(session.metrics.skills_triggered)}`;
    if (onDryRunMessage) onDryRunMessage(message);
    // oxlint-disable-next-line no-console -- standalone ingestor preserves legacy preview output
    else console.log(message);
    return;
  }

  // Write ONE query record per user query to SQLite
  for (const uq of session.user_queries) {
    const queryRecord: QueryLogRecord = {
      timestamp: uq.timestamp || session.timestamp,
      session_id: session.session_id,
      query: uq.query,
      source: "claude_code_replay",
    };
    try {
      writeQueryToDb(queryRecord);
    } catch {
      /* fail-open */
    }
  }

  // Write ONE telemetry record per session to SQLite
  const telemetry: SessionTelemetryRecord = {
    timestamp: session.timestamp,
    session_id: session.session_id,
    cwd: "",
    transcript_path: session.transcript_path,
    tool_calls: session.metrics.tool_calls,
    total_tool_calls: session.metrics.total_tool_calls,
    bash_commands: session.metrics.bash_commands,
    skills_triggered: session.metrics.skills_triggered,
    skills_invoked: session.metrics.skills_invoked ?? [],
    assistant_turns: session.metrics.assistant_turns,
    errors_encountered: session.metrics.errors_encountered,
    transcript_chars: session.metrics.transcript_chars,
    last_user_query: session.metrics.last_user_query,
    source: "claude_code_replay",
  };
  try {
    writeSessionTelemetryToDb(telemetry);
  } catch {
    /* fail-open */
  }

  const skillEvents = getReplaySkillEvents(session);
  for (let i = 0; i < skillEvents.length; i++) {
    const event = skillEvents[i];
    const skillName = event.skill_name;
    const skillQuery = resolveReplayEventQuery(session, event);
    if (!isActionableQueryText(skillQuery)) continue;

    const { invocation_mode, confidence } = deriveInvocationMode({
      has_skill_tool_call: event.tool_name === "Skill",
      has_skill_md_read: event.tool_name === "Read",
    });

    try {
      writeSkillCheckToDb({
        skill_invocation_id: deriveSkillInvocationId(
          session.session_id,
          skillName,
          event.source_event_index ?? i,
          event.tool_call_id,
        ),
        session_id: session.session_id,
        occurred_at: event.occurred_at || session.timestamp,
        skill_name: skillName,
        invocation_mode,
        triggered: event.triggered,
        confidence,
        platform: "claude_code",
        query: skillQuery,
        skill_path: event.skill_path ?? `(claude_code:${skillName})`,
        source: "claude_code_replay",
      });
    } catch {
      /* fail-open */
    }
  }

  // --- Canonical normalization records (additive) ---
  const canonicalRecords = buildCanonicalRecordsFromReplay(session);
  appendCanonicalRecords(canonicalRecords, canonicalLogPath);
}

/** Build canonical records from a parsed Claude Code replay session. */
export function buildCanonicalRecordsFromReplay(session: ParsedSession): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  const latestPromptIndex =
    session.user_queries.length > 0 ? session.user_queries.length - 1 : undefined;
  const latestPromptId =
    latestPromptIndex !== undefined
      ? derivePromptId(session.session_id, latestPromptIndex)
      : undefined;
  const baseInput: CanonicalBaseInput = {
    platform: "claude_code",
    capture_mode: "replay",
    source_session_kind: "replayed",
    session_id: session.session_id,
    raw_source_ref: {
      path: session.transcript_path,
      event_type: "claude_code_replay",
    },
  };

  records.push(
    buildCanonicalSession({
      ...baseInput,
      started_at: session.metrics.started_at ?? session.timestamp,
      ended_at: session.metrics.ended_at,
      model: session.metrics.model,
    }),
  );

  // One canonical prompt per user query
  for (let i = 0; i < session.user_queries.length; i++) {
    const uq = session.user_queries[i];
    records.push(
      buildCanonicalPrompt({
        ...baseInput,
        prompt_id: derivePromptId(session.session_id, i),
        occurred_at: uq.timestamp || session.timestamp,
        prompt_text: uq.query,
        prompt_index: i,
      }),
    );
  }

  const skillEvents = getReplaySkillEvents(session);
  for (let i = 0; i < skillEvents.length; i++) {
    const event = skillEvents[i];
    const skillName = event.skill_name;
    const { invocation_mode, confidence } = deriveInvocationMode({
      has_skill_tool_call: event.tool_name === "Skill",
      has_skill_md_read: event.tool_name === "Read",
    });
    records.push(
      buildCanonicalSkillInvocation({
        ...baseInput,
        skill_invocation_id: deriveSkillInvocationId(
          session.session_id,
          skillName,
          event.source_event_index ?? i,
          event.tool_call_id,
        ),
        occurred_at: event.occurred_at || session.timestamp,
        matched_prompt_id:
          event.prompt_index === undefined
            ? undefined
            : derivePromptId(session.session_id, event.prompt_index),
        skill_name: skillName,
        skill_path: event.skill_path ?? `(claude_code:${skillName})`,
        invocation_mode,
        triggered: event.triggered,
        confidence,
        tool_name: event.tool_name,
        tool_call_id: event.tool_call_id,
      }),
    );
  }

  records.push(
    buildCanonicalExecutionFact({
      ...baseInput,
      occurred_at: session.timestamp,
      prompt_id: latestPromptId,
      tool_calls_json: session.metrics.tool_calls,
      total_tool_calls: session.metrics.total_tool_calls,
      bash_commands_redacted: session.metrics.bash_commands,
      assistant_turns: session.metrics.assistant_turns,
      errors_encountered: session.metrics.errors_encountered,
      input_tokens: session.metrics.input_tokens,
      output_tokens: session.metrics.output_tokens,
      duration_ms: session.metrics.duration_ms,
    }),
  );

  return records;
}

function getReplaySkillEvents(session: ParsedSession): TranscriptSkillInvocationEvent[] {
  if (session.metrics.skill_invocation_events?.length) {
    return session.metrics.skill_invocation_events;
  }

  const latestPromptIndex = Math.max(session.user_queries.length - 1, 0);
  const invoked = session.metrics.skills_invoked ?? [];
  const skillSource = invoked.length > 0 ? invoked : session.metrics.skills_triggered;
  return skillSource.map((skillName) => ({
    skill_name: skillName,
    occurred_at: session.timestamp,
    prompt_index: latestPromptIndex,
    tool_name: invoked.length > 0 ? "Skill" : "Read",
    triggered: invoked.length > 0,
  }));
}

function resolveReplayEventQuery(
  session: ParsedSession,
  event: TranscriptSkillInvocationEvent,
): string {
  if (event.prompt_index === undefined) return "";
  return session.user_queries[event.prompt_index]?.query.trim() ?? "";
}

// --- CLI main ---
function parseReplayOptions() {
  try {
    return parseArgs({
      options: {
        "projects-dir": { type: "string", default: CLAUDE_CODE_PROJECTS_DIR },
        since: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", default: false },
      },
      strict: true,
    }).values;
  } catch (err) {
    throw new CLIError(
      err instanceof Error ? err.message : String(err),
      "INVALID_FLAG",
      "selftune ingest claude --since 2026-01-01",
    );
  }
}

export function cliMain(): void {
  const values = parseReplayOptions();
  const projectsDir = values["projects-dir"];
  let since: Date | undefined;
  const sinceValue = values.since;
  if (sinceValue) {
    since = new Date(sinceValue);
    if (Number.isNaN(since.getTime())) {
      throw new CLIError(
        `Invalid --since date: "${sinceValue}"`,
        "INVALID_FLAG",
        "selftune ingest claude --since 2026-01-01",
      );
    }
  }

  const transcriptFiles = findTranscriptFiles(projectsDir, since);
  if (transcriptFiles.length === 0) {
    console.log(`No transcript files found under ${projectsDir}/`);
    console.log("Make sure you've run some Claude Code sessions.");
    process.exit(0);
  }

  const marker = loadFileIngestionMarker(CLAUDE_CODE_MARKER);
  const candidates = transcriptFiles.map((path) => ({
    path,
    fingerprint: fingerprintIngestionFile(path, NORMALIZER_VERSION),
  }));
  const pending = values.force
    ? candidates
    : candidates.filter(
        ({ path, fingerprint }) => !isFileIngestionCurrent(marker, path, fingerprint),
      );
  console.log(
    `Found ${transcriptFiles.length} transcript files, ${pending.length} new or changed.`,
  );

  if (since) {
    console.log(`  Filtering to sessions from ${sinceValue} onward.`);
  }

  let ingestedCount = 0;
  let skippedCount = 0;

  const dryRun = values["dry-run"] === true;
  const verbose = values.verbose === true;

  let markerChanged = false;
  for (const { path: transcriptFile, fingerprint } of pending) {
    const session = parseSession(transcriptFile);
    if (session === null) {
      marker.set(transcriptFile, fingerprint);
      markerChanged = true;
      if (verbose) {
        console.log(`  SKIP (empty/no queries): ${basename(transcriptFile)}`);
      }
      skippedCount += 1;
      continue;
    }

    if (verbose || dryRun) {
      console.log(`  ${dryRun ? "[DRY] " : ""}Ingesting: ${basename(transcriptFile)}`);
    }

    writeSession(session, dryRun);
    marker.set(transcriptFile, fingerprint);
    markerChanged = true;
    ingestedCount += 1;
  }

  if (!dryRun && markerChanged) {
    saveFileIngestionMarker(CLAUDE_CODE_MARKER, marker);
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions, skipped ${skippedCount}.`);
  if (markerChanged && !values["dry-run"]) {
    console.log(`Marker updated: ${CLAUDE_CODE_MARKER}`);
  }
}

if (import.meta.main) {
  try {
    cliMain();
  } catch (err) {
    handleCLIError(err);
  }
}
