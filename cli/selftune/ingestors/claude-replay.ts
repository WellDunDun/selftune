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
} from "../constants.js";
import {
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
} from "../localdb/direct-write.js";
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
} from "../normalization.js";
import type {
  CanonicalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  TranscriptMetrics,
} from "../types.js";
import { loadMarker, saveMarker } from "../utils/jsonl.js";
import { isActionableQueryText } from "../utils/query-filter.js";
import {
  extractActionableUserQueries,
  findTranscriptFiles as findTranscriptFilesShared,
  parseTranscript,
} from "../utils/transcript.js";

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
 * Returns null if no user queries are found after filtering.
 */
export function parseSession(transcriptPath: string): ParsedSession | null {
  const metrics = parseTranscript(transcriptPath);
  const userQueries = extractAllUserQueries(transcriptPath);

  if (userQueries.length === 0) return null;

  const sessionId = basename(transcriptPath, ".jsonl");

  // Determine timestamp: use first query's timestamp, or file mtime as fallback
  let timestamp = userQueries[0].timestamp;
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
  queryLogPath: string = QUERY_LOG,
  telemetryLogPath: string = TELEMETRY_LOG,
  skillLogPath: string = SKILL_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
): void {
  if (dryRun) {
    console.log(
      `  [DRY RUN] Would ingest: session=${session.session_id.slice(0, 12)}... ` +
        `turns=${session.metrics.assistant_turns} queries=${session.user_queries.length} ` +
        `skills=${JSON.stringify(session.metrics.skills_triggered)}`,
    );
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

  // Write ONE skill record per invoked/triggered skill.
  // Prefer skills_invoked (actual Skill tool calls) for high-confidence records.
  // Fall back to skills_triggered (SKILL.md reads) if no invocations detected.
  const invoked = session.metrics.skills_invoked ?? [];
  const skillSource = invoked.length > 0 ? invoked : session.metrics.skills_triggered;
  const latestActionableQuery =
    session.user_queries[session.user_queries.length - 1]?.query.trim() ??
    session.metrics.last_user_query.trim();

  for (let i = 0; i < skillSource.length; i++) {
    const skillName = skillSource[i];
    const skillQuery = latestActionableQuery;
    if (!isActionableQueryText(skillQuery)) continue;

    const { invocation_mode, confidence } = deriveInvocationMode({
      has_skill_tool_call: invoked.length > 0,
      has_skill_md_read: invoked.length === 0,
    });

    try {
      writeSkillCheckToDb({
        skill_invocation_id: deriveSkillInvocationId(session.session_id, skillName, i),
        session_id: session.session_id,
        occurred_at: session.timestamp,
        skill_name: skillName,
        invocation_mode,
        triggered: true,
        confidence,
        platform: "claude_code",
        query: skillQuery,
        skill_path: `(claude_code:${skillName})`,
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

  // Skill invocation records — prefer invoked over triggered
  const invoked = session.metrics.skills_invoked ?? [];
  const skillSource = invoked.length > 0 ? invoked : session.metrics.skills_triggered;
  const wasInvoked = invoked.length > 0;

  for (let i = 0; i < skillSource.length; i++) {
    const skillName = skillSource[i];
    const { invocation_mode, confidence } = deriveInvocationMode({
      has_skill_tool_call: wasInvoked,
      has_skill_md_read: !wasInvoked,
    });
    records.push(
      buildCanonicalSkillInvocation({
        ...baseInput,
        skill_invocation_id: deriveSkillInvocationId(session.session_id, skillName, i),
        occurred_at: session.timestamp,
        matched_prompt_id: latestPromptId ?? derivePromptId(session.session_id, 0),
        skill_name: skillName,
        skill_path: `(claude_code:${skillName})`,
        invocation_mode,
        triggered: true,
        confidence,
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

// --- CLI main ---
export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      "projects-dir": { type: "string", default: CLAUDE_CODE_PROJECTS_DIR },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

  const projectsDir = values["projects-dir"] ?? CLAUDE_CODE_PROJECTS_DIR;
  let since: Date | undefined;
  if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      console.error(
        `Error: Invalid --since date: "${values.since}". Use a valid date format (e.g., 2026-01-01).`,
      );
      process.exit(1);
    }
  }

  const transcriptFiles = findTranscriptFiles(projectsDir, since);
  if (transcriptFiles.length === 0) {
    console.log(`No transcript files found under ${projectsDir}/`);
    console.log("Make sure you've run some Claude Code sessions.");
    process.exit(0);
  }

  const alreadyIngested = values.force ? new Set<string>() : loadMarker(CLAUDE_CODE_MARKER);
  const newIngested = new Set<string>();

  const pending = transcriptFiles.filter((f) => !alreadyIngested.has(f));
  console.log(
    `Found ${transcriptFiles.length} transcript files, ${pending.length} not yet ingested.`,
  );

  if (since) {
    console.log(`  Filtering to sessions from ${values.since} onward.`);
  }

  let ingestedCount = 0;
  let skippedCount = 0;

  for (const transcriptFile of pending) {
    const session = parseSession(transcriptFile);
    if (session === null) {
      if (values.verbose) {
        console.log(`  SKIP (empty/no queries): ${basename(transcriptFile)}`);
      }
      skippedCount += 1;
      continue;
    }

    if (values.verbose || values["dry-run"]) {
      console.log(`  ${values["dry-run"] ? "[DRY] " : ""}Ingesting: ${basename(transcriptFile)}`);
    }

    writeSession(session, values["dry-run"]);
    newIngested.add(transcriptFile);
    ingestedCount += 1;
  }

  if (!values["dry-run"]) {
    saveMarker(CLAUDE_CODE_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions, skipped ${skippedCount}.`);
  if (newIngested.size > 0 && !values["dry-run"]) {
    console.log(`Marker updated: ${CLAUDE_CODE_MARKER}`);
  }
}

if (import.meta.main) {
  cliMain();
}
