#!/usr/bin/env bun
/**
 * OpenCode session ingestor: opencode-ingest.ts
 *
 * Ingests OpenCode session history from its SQLite database into our shared
 * skill eval log format.
 *
 * OpenCode stores sessions in:
 *   ~/.local/share/opencode/opencode.db  (current, SQLite, from ~Feb 2026)
 *
 * Older installations may still have JSON files at:
 *   ~/.local/share/opencode/storage/session/*.json
 *
 * Usage:
 *   bun opencode-ingest.ts
 *   bun opencode-ingest.ts --since 2026-01-01
 *   bun opencode-ingest.ts --data-dir /custom/path
 *   bun opencode-ingest.ts --dry-run
 *   bun opencode-ingest.ts --force
 *   bun opencode-ingest.ts --show-schema
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { CANONICAL_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
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
import type { CanonicalRecord, QueryLogRecord, SkillUsageRecord } from "../types.js";
import { appendJsonl, loadMarker, saveMarker } from "../utils/jsonl.js";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const DEFAULT_DATA_DIR = join(XDG_DATA_HOME, "opencode");
const MARKER_FILE = join(homedir(), ".claude", "opencode_ingested_sessions.json");

const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate that a string is a safe SQL identifier. Throws on invalid input. */
function assertSafeIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier rejected: ${JSON.stringify(name)}`);
  }
  return name;
}

const OPENCODE_SKILLS_DIRS = [
  join(process.cwd(), ".opencode", "skills"),
  join(homedir(), ".config", "opencode", "skills"),
];

interface TriggeredSkillDetection {
  skill_name: string;
  has_skill_md_read: boolean;
}

/** Return skill names from OpenCode skill directories. */
export function findSkillNames(dirs: string[] = OPENCODE_SKILLS_DIRS): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      try {
        if (statSync(skillDir).isDirectory() && existsSync(join(skillDir, "SKILL.md"))) {
          names.add(entry);
        }
      } catch {
        // skip entries that can't be stat'd (broken symlinks, permission errors, etc.)
      }
    }
  }
  return names;
}

export interface ParsedSession {
  timestamp: string;
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
  /** True when local session JSON is metadata-only (no embedded messages). */
  is_metadata_only?: boolean;
}

/** Return a human-readable schema summary for --show-schema. */
export function getDbSchema(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{
    name: string;
  }>;

  const lines: string[] = [];
  for (const { name } of tables) {
    const safeName = assertSafeIdentifier(name);
    const cols = db.query(`PRAGMA table_info(${safeName})`).all() as Array<{
      name: string;
      type: string;
    }>;
    lines.push(`\nTable: ${name}`);
    for (const col of cols) {
      lines.push(`  ${col.name.padEnd(30)} ${col.type}`);
    }
  }
  db.close();
  return lines.join("\n");
}

/** Normalize raw message content into an array of content blocks. */
function normalizeContent(rawContent: unknown): Array<Record<string, unknown>> {
  let content: unknown;
  if (typeof rawContent === "string") {
    try {
      content = JSON.parse(rawContent);
    } catch {
      content = [{ type: "text", text: rawContent }];
    }
  } else {
    content = rawContent;
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
  }
  if (typeof content === "object" && content !== null) {
    return [content as Record<string, unknown>];
  }
  return [];
}

/**
 * Read OpenCode sessions from SQLite database.
 */
export function readSessionsFromSqlite(
  dbPath: string,
  sinceTs: number | null,
  skillNames: Set<string>,
): ParsedSession[] {
  const db = new Database(dbPath, { readonly: true });

  // Detect available tables
  const tableRows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string;
  }>;
  const tables = new Set(tableRows.map((r) => r.name));

  const sessionsTable = [...tables].find((t) => t.toLowerCase().includes("session"));
  const messagesTable = [...tables].find((t) => t.toLowerCase().includes("message"));

  if (!sessionsTable || !messagesTable) {
    console.warn(`[WARN] Could not find session/message tables in ${dbPath}`);
    console.warn(`       Available tables: ${[...tables].sort().join(", ")}`);
    db.close();
    return [];
  }

  const safeSessionsTable = assertSafeIdentifier(sessionsTable);
  const safeMessagesTable = assertSafeIdentifier(messagesTable);

  // Get sessions
  let whereClause = "";
  const queryParams: unknown[] = [];
  if (sinceTs) {
    whereClause = "WHERE created > ?";
    queryParams.push(Math.floor(sinceTs * 1000));
  }

  let sessionRows: Array<Record<string, unknown>>;
  try {
    sessionRows = db
      .query(`SELECT * FROM ${safeSessionsTable} ${whereClause} ORDER BY created ASC`)
      .all(...queryParams) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn(`[WARN] Could not query sessions: ${e}`);
    db.close();
    return [];
  }

  const parsedSessions: ParsedSession[] = [];

  for (const sessionRow of sessionRows) {
    const sessionId = String(sessionRow.id);
    const createdMs = sessionRow.created as number;
    const timestamp = new Date(createdMs).toISOString();

    // Get messages for this session
    let msgRows: Array<Record<string, unknown>>;
    try {
      msgRows = db
        .query(`SELECT * FROM ${safeMessagesTable} WHERE session_id = ? ORDER BY created ASC`)
        .all(sessionRow.id) as Array<Record<string, unknown>>;
    } catch {
      continue;
    }

    let firstUserQuery = "";
    const toolCalls: Record<string, number> = {};
    const bashCommands: string[] = [];
    const skillDetections = new Map<string, TriggeredSkillDetection>();
    let errors = 0;
    let assistantTurns = 0;

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

    for (const msg of msgRows) {
      const role = (msg.role as string) ?? "";
      const blocks = normalizeContent(msg.content ?? "[]");

      if (role === "user") {
        if (!firstUserQuery) {
          for (const block of blocks) {
            if (block.type === "text") {
              const text = ((block.text as string) ?? "").trim();
              if (text && text.length >= 4) {
                firstUserQuery = text;
                break;
              }
            }
          }
          // Fallback: join all text blocks
          if (!firstUserQuery) {
            const texts = blocks
              .filter((b) => b.type === "text")
              .map((b) => ((b.text as string) ?? "").trim())
              .filter((t) => t.length > 0);
            firstUserQuery = texts.join(" ").trim();
          }
        }
      } else if (role === "assistant") {
        assistantTurns += 1;
        for (const block of blocks) {
          const blockType = (block.type as string) ?? "";

          // Anthropic tool use format
          if (blockType === "tool_use") {
            const toolName = (block.name as string) ?? "unknown";
            toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
            const inp = (block.input as Record<string, unknown>) ?? {};

            if (["Bash", "bash", "execute_bash"].includes(toolName)) {
              const cmd = ((inp.command as string) ?? (inp.cmd as string) ?? "").trim();
              if (cmd) bashCommands.push(cmd);
            }

            // Skill detection: file reads of SKILL.md
            if (["Read", "read_file"].includes(toolName)) {
              const filePath = (inp.file_path as string) ?? (inp.path as string) ?? "";
              if (basename(filePath).toUpperCase() === "SKILL.MD") {
                const skillName = basename(join(filePath, ".."));
                noteSkillDetection(skillName, true);
              }
            }
          }

          // OpenAI tool calls format
          if (blockType === "tool_calls") {
            const tcs = (block.tool_calls as Array<Record<string, unknown>>) ?? [];
            for (const tc of tcs) {
              const fn = (tc.function as Record<string, unknown>) ?? {};
              const toolName = (fn.name as string) ?? "unknown";
              toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
            }
          }

          // Check text content for skill name mentions
          const textContent = (block.text as string) ?? "";
          for (const skillName of skillNames) {
            if (textContent.includes(skillName)) {
              noteSkillDetection(skillName, false);
            }
          }
        }
      }

      // Count errors from tool_result blocks
      for (const block of blocks) {
        if (block.type === "tool_result") {
          if (block.is_error || block.error) {
            errors += 1;
          }
        }
      }
    }

    parsedSessions.push({
      timestamp,
      session_id: sessionId,
      source: "opencode",
      transcript_path: dbPath,
      cwd: "",
      last_user_query: firstUserQuery,
      query: firstUserQuery,
      tool_calls: toolCalls,
      total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
      bash_commands: bashCommands,
      skills_triggered: [...skillDetections.values()].map((entry) => entry.skill_name),
      skill_detections: [...skillDetections.values()],
      assistant_turns: assistantTurns,
      errors_encountered: errors,
      transcript_chars: 0,
    });
  }

  db.close();
  return parsedSessions;
}

/**
 * Read OpenCode sessions from legacy JSON files at:
 *   <storage_dir>/session/*.json
 */
export function readSessionsFromJsonFiles(
  storageDir: string,
  sinceTs: number | null,
  skillNames: Set<string>,
): ParsedSession[] {
  const sessionDir = join(storageDir, "session");
  if (!existsSync(sessionDir)) return [];

  const sessions: ParsedSession[] = [];

  const jsonFiles = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  for (const file of jsonFiles) {
    const filePath = join(sessionDir, file);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      continue;
    }

    const sessionId = (data.id as string) ?? basename(file, ".json");
    let created = (data.created as number) ?? (data.createdAt as number) ?? 0;

    // Convert timestamp (may be seconds or milliseconds)
    if (typeof created === "number" && created > 1e10) {
      created = created / 1000;
    }
    if (sinceTs && created < sinceTs) continue;

    const timestamp = new Date(created * 1000).toISOString();
    const messages = (data.messages as Array<Record<string, unknown>>) ?? [];

    // Detect metadata-only session files (no message bodies)
    const isMetadataOnly = messages.length === 0;

    let firstUserQuery = "";
    const toolCalls: Record<string, number> = {};
    const bashCommands: string[] = [];
    const skillDetections = new Map<string, TriggeredSkillDetection>();
    let errors = 0;
    let turns = 0;

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

    for (const msg of messages) {
      const role = (msg.role as string) ?? "";
      const blocks = normalizeContent(msg.content ?? []);

      if (role === "user" && !firstUserQuery) {
        for (const block of blocks) {
          if (block.type === "text") {
            const text = ((block.text as string) ?? "").trim();
            if (text && text.length >= 4 && !text.startsWith("tool_result")) {
              firstUserQuery = text;
              break;
            }
          }
        }
      } else if (role === "assistant") {
        turns += 1;
        for (const block of blocks) {
          if (block.type === "tool_use") {
            const toolName = (block.name as string) ?? "unknown";
            toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
            const inp = (block.input as Record<string, unknown>) ?? {};
            if (["Bash", "bash"].includes(toolName)) {
              const cmd = ((inp.command as string) ?? "").trim();
              if (cmd) bashCommands.push(cmd);
            }
            if (["Read", "read_file"].includes(toolName)) {
              const fp = (inp.file_path as string) ?? "";
              if (basename(fp).toUpperCase() === "SKILL.MD") {
                const sn = basename(join(fp, ".."));
                noteSkillDetection(sn, true);
              }
            }
          }

          const text = (block.text as string) ?? "";
          for (const skillName of skillNames) {
            if (text.includes(skillName)) {
              noteSkillDetection(skillName, false);
            }
          }
        }
      }

      // Count errors from tool_result blocks (same as SQLite path)
      for (const block of blocks) {
        if (block.type === "tool_result") {
          if (block.is_error || block.error) {
            errors += 1;
          }
        }
      }
    }

    sessions.push({
      timestamp,
      session_id: sessionId,
      source: "opencode_json",
      transcript_path: filePath,
      cwd: "",
      last_user_query: firstUserQuery,
      query: firstUserQuery,
      tool_calls: toolCalls,
      total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
      bash_commands: bashCommands,
      skills_triggered: [...skillDetections.values()].map((entry) => entry.skill_name),
      skill_detections: [...skillDetections.values()],
      assistant_turns: turns,
      errors_encountered: errors,
      transcript_chars: statSync(filePath).size,
      is_metadata_only: isMetadataOnly,
    });
  }

  return sessions;
}

/** Write a parsed session to our shared logs. */
export function writeSession(
  session: ParsedSession,
  dryRun = false,
  queryLogPath: string = QUERY_LOG,
  telemetryLogPath: string = TELEMETRY_LOG,
  skillLogPath: string = SKILL_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
): void {
  const { query: prompt, session_id: sessionId, skills_triggered: skills } = session;

  if (dryRun) {
    console.log(
      `  [DRY] session=${sessionId.slice(0, 12)}... turns=${session.assistant_turns} skills=${JSON.stringify(skills)}`,
    );
    if (prompt) console.log(`        query: ${prompt.slice(0, 80)}`);
    return;
  }

  if (prompt && prompt.length >= 4) {
    const queryRecord: QueryLogRecord = {
      timestamp: session.timestamp,
      session_id: sessionId,
      query: prompt,
      source: session.source,
    };
    appendJsonl(queryLogPath, queryRecord, "all_queries");
  }

  const { query: _q, ...telemetry } = session;
  appendJsonl(telemetryLogPath, telemetry, "session_telemetry");

  for (const skillName of skills) {
    const skillRecord: SkillUsageRecord = {
      timestamp: session.timestamp,
      session_id: sessionId,
      skill_name: skillName,
      skill_path: `(opencode:${skillName})`,
      query: prompt,
      triggered: true,
      source: session.source,
    };
    appendJsonl(skillLogPath, skillRecord, "skill_usage");
  }

  // --- Canonical normalization records (additive) ---
  const canonicalRecords = buildCanonicalRecordsFromOpenCode(session);
  appendCanonicalRecords(canonicalRecords, canonicalLogPath);
}

/** Build canonical records from a parsed OpenCode session. */
export function buildCanonicalRecordsFromOpenCode(session: ParsedSession): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  const sourceKind = session.is_metadata_only ? ("replayed" as const) : ("replayed" as const);
  const baseInput: CanonicalBaseInput = {
    platform: "opencode",
    capture_mode: "batch_ingest",
    source_session_kind: sourceKind,
    session_id: session.session_id,
    raw_source_ref: {
      path: session.transcript_path,
      event_type: session.source,
      metadata: session.is_metadata_only ? { metadata_only: true } : undefined,
    },
  };

  records.push(
    buildCanonicalSession({
      ...baseInput,
      started_at: session.timestamp,
      workspace_path: session.cwd || undefined,
    }),
  );

  const promptEmitted = Boolean(
    session.query && session.query.length >= 4 && !session.is_metadata_only,
  );
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
        skill_path: `(opencode:${skillName})`,
        invocation_mode,
        triggered: true,
        confidence,
      }),
    );
  }

  if (!session.is_metadata_only) {
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
      }),
    );
  }

  return records;
}

// --- CLI main ---
export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "show-schema": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

  const dataDir = values["data-dir"] ?? DEFAULT_DATA_DIR;
  const dbPath = join(dataDir, "opencode.db");
  const storageDir = join(dataDir, "storage");

  if (values["show-schema"]) {
    if (existsSync(dbPath)) {
      console.log(getDbSchema(dbPath));
    } else {
      console.log(`No database found at ${dbPath}`);
    }
    process.exit(0);
  }

  if (!existsSync(dataDir)) {
    console.log(`OpenCode data directory not found: ${dataDir}`);
    console.log("Is OpenCode installed? Try --data-dir to specify a custom location.");
    process.exit(1);
  }

  let sinceTs: number | null = null;
  if (values.since) {
    const parsed = new Date(`${values.since}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      console.error(`[ERROR] Invalid --since date: "${values.since}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    sinceTs = parsed.getTime() / 1000;
  }

  const skillNames = findSkillNames();
  const alreadyIngested = values.force ? new Set<string>() : loadMarker(MARKER_FILE);
  let allSessions: ParsedSession[] = [];

  if (existsSync(dbPath)) {
    console.log(`Reading SQLite database: ${dbPath}`);
    allSessions = readSessionsFromSqlite(dbPath, sinceTs, skillNames);
  } else if (existsSync(storageDir)) {
    console.log(`Reading legacy JSON files: ${storageDir}/session/`);
    allSessions = readSessionsFromJsonFiles(storageDir, sinceTs, skillNames);
  } else {
    console.log(`No OpenCode data found in ${dataDir}`);
    console.log("Expected either opencode.db or storage/session/*.json");
    process.exit(1);
  }

  const pending = allSessions.filter((s) => !alreadyIngested.has(s.session_id));
  console.log(`Found ${allSessions.length} total sessions, ${pending.length} not yet ingested.`);

  const newIngested = new Set<string>();
  let ingestedCount = 0;

  for (const session of pending) {
    if (values.verbose || values["dry-run"]) {
      console.log(
        `  ${values["dry-run"] ? "[DRY] " : ""}Ingesting: ${session.session_id.slice(0, 12)}...`,
      );
    }
    writeSession(session, values["dry-run"]);
    newIngested.add(session.session_id);
    ingestedCount += 1;
  }

  if (!values["dry-run"]) {
    saveMarker(MARKER_FILE, new Set([...alreadyIngested, ...newIngested]));
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions.`);
}

if (import.meta.main) {
  cliMain();
}
