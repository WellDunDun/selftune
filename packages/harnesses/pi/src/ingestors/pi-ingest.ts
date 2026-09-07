#!/usr/bin/env bun
/**
 * Pi session ingestor: pi-ingest.ts
 *
 * Ingests Pi coding agent session history from JSONL files into
 * selftune's shared telemetry schema.
 *
 * Pi stores sessions as tree-structured JSONL at:
 *   ~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
 *
 * Each JSONL file has:
 *   Line 1 (session header): {"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"<path>"}
 *   Line 2+ (entries): {"type":"message|model_change|...","id":"<hex>","parentId":"<hex>","timestamp":"<iso>"}
 *
 * The entries form an append-only tree (id/parentId). This ingestor
 * linearizes by following the child with the latest timestamp at each
 * branch point (greedy main-thread extraction).
 *
 * Usage:
 *   bun pi-ingest.ts
 *   bun pi-ingest.ts --since 2026-01-01
 *   bun pi-ingest.ts --sessions-dir /custom/path
 *   bun pi-ingest.ts --dry-run
 *   bun pi-ingest.ts --force
 *   bun pi-ingest.ts --verbose
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import * as Option from "effect/Option";

import { PI_INGEST_MARKER, PI_SESSIONS_DIR, PI_SKILLS_DIR } from "@selftune/runtime/constants";
import {
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillUsageToDb,
} from "@selftune/runtime/localdb/direct-write";
import {
  appendCanonicalRecords,
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  type BuildSessionInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
} from "@selftune/runtime/normalization";
import type { CanonicalRecord, QueryLogRecord, SkillUsageRecord } from "@selftune/runtime/types";
import { loadMarker, saveMarker } from "@selftune/runtime/utils/jsonl";
import {
  decodePiEntry,
  decodePiHeader,
  normalizeContentBlocks,
  type PiEntry,
} from "./pi-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionFile {
  sessionId: string;
  filePath: string;
  timestamp: number; // epoch ms from header or file stat
}

const PI_SESSION_HEADER_MAX_BYTES = 64 * 1024;

interface PiSessionHeader {
  readonly sessionId: string;
  readonly timestamp?: string;
}

interface TriggeredSkillDetection {
  skill_name: string;
  has_skill_md_read: boolean;
}

export interface ParsedSession {
  timestamp: string;
  /** Final source timestamp from a complete, ordered linearized entry sequence. */
  ended_at?: string;
  session_id: string;
  source: string;
  transcript_path: string;
  cwd: string;
  last_user_query: string;
  query: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skill_detections?: TriggeredSkillDetection[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  completion_status?: BuildSessionInput["completion_status"];
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/** Read only the bounded first JSONL line; session bodies are parsed only when pending. */
export function readPiSessionHeader(
  filePath: string,
  fallbackSessionId: string,
): PiSessionHeader | null {
  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(PI_SESSION_HEADER_MAX_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newlineOffset = buffer.subarray(0, bytesRead).indexOf(10);
    if (newlineOffset < 0) return null;
    const line = buffer.subarray(0, newlineOffset).toString("utf8").trim();
    if (!line) return null;
    const result = decodePiHeader(line);
    if (Option.isNone(result)) return null;
    const decoded = result.value;
    return {
      sessionId: decoded.id || fallbackSessionId,
      timestamp: decoded.timestamp,
    };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Recursively find Pi session JSONL files under the sessions directory.
 * Pi stores sessions in subdirectories named --<path>--.
 */
export function findPiSessions(sessionsDir: string, sinceTs: number | null): SessionFile[] {
  if (!existsSync(sessionsDir)) return [];

  const results: SessionFile[] = [];

  function walkDir(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.endsWith(".jsonl")) {
          const header = readPiSessionHeader(fullPath, basename(entry, ".jsonl"));
          if (!header) continue;
          const headerTs = header.timestamp ? new Date(header.timestamp).getTime() : 0;
          const fileTs = headerTs || stat.mtimeMs;

          if (sinceTs !== null && fileTs < sinceTs) continue;

          results.push({ sessionId: header.sessionId, filePath: fullPath, timestamp: fileTs });
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }

  walkDir(sessionsDir);
  return results;
}

// ---------------------------------------------------------------------------
// Tree linearization
// ---------------------------------------------------------------------------

/**
 * Linearize a Pi session tree by following the child with the latest
 * timestamp at each branch point. Returns entries in chronological order
 * from root to leaf.
 */
function linearizeTree(entries: PiEntry[]) {
  if (entries.length === 0) return { entries: [], acyclic: true };

  // Build parent -> children adjacency.
  const children = new Map<string, PiEntry[]>();
  let root: PiEntry | undefined;

  for (const entry of entries) {
    if (!entry.id) continue;

    const parentId = entry.parentId ?? null;
    if (parentId === null) {
      root = entry;
    } else {
      const siblings = children.get(parentId) ?? [];
      siblings.push(entry);
      children.set(parentId, siblings);
    }
  }

  // If no root found, use first entry
  if (!root) root = entries[0];

  // Walk greedily: at each node, follow child with latest timestamp
  const result: PiEntry[] = [root];
  let current = root;
  const visited = new Set<PiEntry>([root]);

  while (current.id) {
    const kids = children.get(current.id);
    if (!kids || kids.length === 0) break;

    // Pick the child with the latest timestamp
    let latest = kids[0];
    let latestTs = latest.timestamp ? new Date(latest.timestamp).getTime() : 0;

    for (let i = 1; i < kids.length; i++) {
      const childTimestamp = kids[i].timestamp;
      const ts = childTimestamp ? new Date(childTimestamp).getTime() : 0;
      if (ts > latestTs) {
        latest = kids[i];
        latestTs = ts;
      }
    }

    if (visited.has(latest)) return { entries: result, acyclic: false };
    visited.add(latest);
    result.push(latest);
    current = latest;
  }

  return { entries: result, acyclic: true };
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

/** Map Pi stopReason to canonical completion status. */
function mapStopReason(stopReason: string | undefined): BuildSessionInput["completion_status"] {
  if (!stopReason) return undefined;
  switch (stopReason) {
    case "stop":
    case "end_turn":
      return "completed";
    case "error":
      return "failed";
    case "aborted":
      return "cancelled";
    case "length":
    case "max_tokens":
      return "interrupted";
    default:
      return "unknown";
  }
}

/**
 * Parse a Pi session JSONL file into a ParsedSession.
 */
export function parsePiSession(filePath: string, skillNames: Set<string>): ParsedSession {
  const empty: ParsedSession = {
    timestamp: "",
    session_id: "",
    source: "pi",
    transcript_path: filePath,
    cwd: "",
    last_user_query: "",
    query: "",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    skill_detections: [],
    assistant_turns: 0,
    errors_encountered: 0,
    transcript_chars: 0,
  };

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return empty;
  }

  empty.transcript_chars = content.length;
  const lines = content.split("\n").filter((l) => l.trim());

  if (lines.length === 0) return empty;

  // Parse session header (line 1)
  const decodedHeader = decodePiHeader(lines[0]);
  if (Option.isNone(decodedHeader)) return empty;
  const header = decodedHeader.value;
  const sessionId = header.id ?? "";
  const timestamp = header.timestamp ?? "";
  const cwd = header.cwd ?? "";

  // Parse all entries (lines 2+)
  const entries: PiEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const entry = decodePiEntry(lines[i]);
    if (Option.isSome(entry)) entries.push(entry.value);
  }

  // Linearize the tree to get main conversation thread
  const linearized = linearizeTree(entries);
  const linearEntries = linearized.entries;

  const toolCalls = new Map<string, number>();
  const bashCommands: string[] = [];
  const skillDetections = new Map<string, TriggeredSkillDetection>();
  let firstUserQuery = "";
  let lastUserQuery = "";
  let assistantTurns = 0;
  let errors = 0;
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastStopReason: string | undefined;
  let endedAt: string | undefined;
  let previousEntryEpoch: number | undefined;
  let timestampsOrdered = linearized.acyclic && linearEntries.length > 0;

  const noteSkillDetection = (skillName: string, hasSkillMdRead: boolean): void => {
    const normalizedSkillName = skillName.trim();
    if (!normalizedSkillName) return;
    const existing = skillDetections.get(normalizedSkillName);
    if (existing) {
      existing.has_skill_md_read = existing.has_skill_md_read || hasSkillMdRead;
      return;
    }
    skillDetections.set(normalizedSkillName, {
      skill_name: normalizedSkillName,
      has_skill_md_read: hasSkillMdRead,
    });
  };

  for (const entry of linearEntries) {
    const entryEpoch = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (
      !Number.isFinite(entryEpoch) ||
      (previousEntryEpoch !== undefined && entryEpoch < previousEntryEpoch)
    ) {
      timestampsOrdered = false;
    } else {
      previousEntryEpoch = entryEpoch;
      endedAt = entry.timestamp;
    }
    // Track model changes
    if (entry.type === "model_change") {
      if (entry.provider) lastProvider = entry.provider;
      if (entry.modelId) lastModel = entry.modelId;
      continue;
    }

    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role ?? "";
    const contentBlocks = normalizeContentBlocks(msg.content);

    if (role === "user") {
      for (const block of contentBlocks) {
        if (block.type === "text") {
          const text = (block.text ?? "").trim();
          if (text) {
            if (!firstUserQuery) firstUserQuery = text;
            lastUserQuery = text;
            break;
          }
        }
      }
    } else if (role === "assistant") {
      assistantTurns += 1;

      // Extract metadata from assistant messages
      if (msg.provider) lastProvider = msg.provider;
      if (msg.model) lastModel = msg.model;
      if (msg.stopReason) lastStopReason = msg.stopReason;
      if (msg.usage) {
        if (msg.usage.input) totalInputTokens += msg.usage.input;
        if (msg.usage.output) totalOutputTokens += msg.usage.output;
      }

      for (const block of contentBlocks) {
        const blockType = block.type ?? "";

        // Handle toolCall blocks
        if (blockType === "toolCall" || blockType === "toolUse") {
          const toolName = block.name ?? "unknown";
          toolCalls.set(toolName, (toolCalls.get(toolName) ?? 0) + 1);
          const inp = block.arguments ?? block.input ?? {};

          // Extract bash commands
          if (["Bash", "bash", "execute_bash"].includes(toolName)) {
            const cmd = (inp.command ?? inp.cmd ?? "").trim();
            if (cmd) bashCommands.push(cmd);
          }

          // Skill detection: file reads of SKILL.md
          if (["Read", "read", "read_file"].includes(toolName)) {
            const fp = inp.file_path ?? inp.filePath ?? inp.path ?? "";
            if (basename(fp).toUpperCase() === "SKILL.MD") {
              const skillName = basename(join(fp, ".."));
              noteSkillDetection(skillName, true);
            }
          }
        }

        // Check text content for skill name mentions
        const textContent = block.text ?? "";
        for (const skillName of skillNames) {
          if (textContent.includes(skillName)) {
            noteSkillDetection(skillName, false);
          }
        }
      }
    } else if (role === "toolResult") {
      const blockHasError = contentBlocks.some(
        (block) => block.isError === true || block.is_error === true,
      );
      if (msg.isError === true || blockHasError) {
        errors += 1;
      }
    }
  }

  return {
    timestamp,
    ended_at: timestampsOrdered ? endedAt : undefined,
    session_id: sessionId,
    source: "pi",
    transcript_path: filePath,
    cwd,
    last_user_query: lastUserQuery || firstUserQuery,
    query: firstUserQuery,
    tool_calls: Object.fromEntries(toolCalls),
    total_tool_calls: [...toolCalls.values()].reduce((a, b) => a + b, 0),
    bash_commands: bashCommands,
    skills_triggered: [...skillDetections.values()].map((entry) => entry.skill_name),
    skill_detections: [...skillDetections.values()],
    assistant_turns: assistantTurns,
    errors_encountered: errors,
    transcript_chars: content.length,
    provider: lastProvider,
    model: lastModel,
    input_tokens: totalInputTokens || undefined,
    output_tokens: totalOutputTokens || undefined,
    completion_status: mapStopReason(lastStopReason),
  };
}

// ---------------------------------------------------------------------------
// Write session to shared logs
// ---------------------------------------------------------------------------

/** Write a parsed session to selftune's shared logs. */
export function writeSession(
  session: ParsedSession,
  dryRun = false,
  onDryRunMessage?: (message: string) => void,
): void {
  const { query: prompt, session_id: sessionId, skills_triggered: skills } = session;

  if (dryRun) {
    // oxlint-disable-next-line no-console -- standalone ingestor preserves legacy preview output
    const writeMessage = onDryRunMessage ?? ((message: string) => console.log(message));
    writeMessage(
      `  [DRY] session=${sessionId.slice(0, 12)}... turns=${session.assistant_turns} skills=${JSON.stringify(skills)}`,
    );
    if (prompt) writeMessage(`        query: ${prompt.slice(0, 80)}`);
    return;
  }

  if (prompt && prompt.length >= 4) {
    const queryRecord: QueryLogRecord = {
      timestamp: session.timestamp,
      session_id: sessionId,
      query: prompt,
      source: session.source,
    };
    writeQueryToDb(queryRecord);
  }

  writeSessionTelemetryToDb({
    timestamp: session.timestamp,
    session_id: session.session_id,
    cwd: session.cwd,
    transcript_path: session.transcript_path,
    tool_calls: session.tool_calls,
    total_tool_calls: session.total_tool_calls,
    bash_commands: session.bash_commands,
    skills_triggered: session.skills_triggered,
    assistant_turns: session.assistant_turns,
    errors_encountered: session.errors_encountered,
    transcript_chars: session.transcript_chars,
    last_user_query: session.last_user_query,
    source: session.source,
  });

  for (const skillName of skills) {
    const skillRecord: SkillUsageRecord = {
      timestamp: session.timestamp,
      session_id: sessionId,
      skill_name: skillName,
      skill_path: `(pi:${skillName})`,
      query: prompt,
      triggered: true,
      source: session.source,
    };
    writeSkillUsageToDb(skillRecord);
  }

  // --- Canonical normalization records (additive) ---
  const canonicalRecords = buildCanonicalRecordsFromPi(session);
  appendCanonicalRecords(canonicalRecords);
}

/** Build canonical records from a parsed Pi session. */
export function buildCanonicalRecordsFromPi(session: ParsedSession): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  const baseInput: CanonicalBaseInput = {
    platform: "pi",
    capture_mode: "batch_ingest",
    source_session_kind: "replayed",
    session_id: session.session_id,
    raw_source_ref: {
      path: session.transcript_path,
      event_type: "pi",
    },
  };

  records.push(
    buildCanonicalSession({
      ...baseInput,
      started_at: session.timestamp,
      ended_at: session.ended_at,
      workspace_path: session.cwd || undefined,
      provider: session.provider,
      model: session.model,
      completion_status: session.completion_status,
    }),
  );

  const promptEmitted = Boolean(session.query && session.query.length >= 4);
  const promptId = promptEmitted ? derivePromptId(session.session_id, 0) : undefined;

  if (promptId) {
    records.push(
      buildCanonicalPrompt({
        ...baseInput,
        prompt_id: promptId,
        occurred_at: session.timestamp,
        prompt_text: session.query,
        prompt_index: 0,
      }),
    );
  }

  const skillDetections =
    session.skill_detections ??
    session.skills_triggered.map((skillName) => ({
      skill_name: skillName,
      has_skill_md_read: false,
    }));

  for (let i = 0; i < skillDetections.length; i++) {
    const detection = skillDetections[i];
    const skillName = detection.skill_name;
    const { invocation_mode, confidence } = deriveInvocationMode({
      has_skill_md_read: detection.has_skill_md_read,
      is_text_mention_only: !detection.has_skill_md_read,
    });
    records.push(
      buildCanonicalSkillInvocation({
        ...baseInput,
        skill_invocation_id: deriveSkillInvocationId(session.session_id, skillName, i),
        occurred_at: session.timestamp,
        matched_prompt_id: promptId,
        skill_name: skillName,
        skill_path: `(pi:${skillName})`,
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
      prompt_id: promptId,
      tool_calls_json: session.tool_calls,
      total_tool_calls: session.total_tool_calls,
      bash_commands_redacted: session.bash_commands,
      assistant_turns: session.assistant_turns,
      errors_encountered: session.errors_encountered,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
    }),
  );

  return records;
}

// ---------------------------------------------------------------------------
// Skill name discovery
// ---------------------------------------------------------------------------

/** Find skill names from Pi's global registry and compatible project-local directories. */
export function findPiSkillNames(
  skillDirs: readonly string[] = [
    PI_SKILLS_DIR,
    join(process.cwd(), ".agents", "skills"),
    join(process.cwd(), "skills"),
  ],
): Set<string> {
  const names = new Set<string>();

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        const skillDir = join(dir, entry);
        try {
          if (statSync(skillDir).isDirectory() && existsSync(join(skillDir, "SKILL.md"))) {
            names.add(entry);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      "sessions-dir": { type: "string", default: PI_SESSIONS_DIR },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

  const sessionsDir = values["sessions-dir"] ?? PI_SESSIONS_DIR;

  if (!existsSync(sessionsDir)) {
    console.log(`Pi sessions directory not found: ${sessionsDir}`);
    console.log("Is Pi installed? Try --sessions-dir to specify a custom location.");
    process.exit(1);
  }

  let sinceTs: number | null = null;
  if (values.since) {
    const parsed = new Date(`${values.since}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      console.error(`[ERROR] Invalid --since date: "${values.since}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    sinceTs = parsed.getTime();
  }

  const skillNames = findPiSkillNames();
  const alreadyIngested = values.force ? new Set<string>() : loadMarker(PI_INGEST_MARKER);
  const allSessions = findPiSessions(sessionsDir, sinceTs);

  console.log(`Found ${allSessions.length} total sessions.`);

  const pending = allSessions.filter((s) => !alreadyIngested.has(s.sessionId));
  console.log(`${pending.length} not yet ingested.`);

  const newIngested = new Set<string>();
  let ingestedCount = 0;

  for (const sf of pending) {
    const session = parsePiSession(sf.filePath, skillNames);

    if (!session.session_id || !session.timestamp) {
      console.log(
        `  [WARN] Skipping session ${sf.sessionId.slice(0, 12)}...: missing session_id or timestamp after parsing`,
      );
      continue;
    }

    if (values.verbose || values["dry-run"]) {
      console.log(
        `  ${values["dry-run"] ? "[DRY] " : ""}Ingesting: ${sf.sessionId.slice(0, 12)}...`,
      );
    }

    writeSession(session, values["dry-run"]);
    newIngested.add(sf.sessionId);
    ingestedCount += 1;
  }

  if (!values["dry-run"]) {
    saveMarker(PI_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions.`);
}

if (import.meta.main) {
  cliMain();
}
