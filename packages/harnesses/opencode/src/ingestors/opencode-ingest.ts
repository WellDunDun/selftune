/**
 * OpenCode session parser and canonical-record projector.
 *
 * User-facing imports run through the harness source adapter so canonical
 * SQLite writes and analytical DuckDB writes share one retry boundary.
 *
 * OpenCode stores sessions in:
 *   ~/.local/share/opencode/opencode.db  (current, SQLite, from ~Feb 2026)
 *
 * Older installations may still have JSON files at:
 *   ~/.local/share/opencode/storage/session/*.json
 *
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import * as Option from "effect/Option";

import { CANONICAL_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import {
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillUsageToDb,
} from "@selftune/runtime/localdb/direct-write";
import { appendCanonicalRecords } from "@selftune/runtime/normalization";
import type {
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";

import { buildCanonicalRecordsFromOpenCode } from "./opencode-canonical.js";
import {
  decodeMessageContent,
  decodeOpenCodeSession,
  parseOpenCodeMessage,
  sourceCount,
  sourceNumber,
  sourceProvider,
  sourceText,
  type OpenCodeContentBlock,
  type OpenCodeMessage,
  type OpenCodeSourceCell,
  type OpenCodeSourceRow,
} from "./opencode-contract.js";
export { buildCanonicalRecordsFromOpenCode } from "./opencode-canonical.js";

const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPENCODE_SESSION_CHUNK_SIZE = 32;

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeSkillMention(text: string, skillName: string): boolean {
  const trimmedSkillName = skillName.trim();
  if (!text || !trimmedSkillName) return false;

  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegExp(trimmedSkillName)}([^A-Za-z0-9_]|$)`,
    "i",
  );
  return pattern.test(text);
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
  /** Source-provided session end time, when OpenCode exposed one. */
  source_ended_at?: string;
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
  /** Source-reported provider/model and token totals, when available. */
  model_provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  /** True when local session JSON is metadata-only (no embedded messages). */
  is_metadata_only?: boolean;
}

function sourceTimestamp(value: OpenCodeSourceCell): string | undefined {
  const raw = sourceNumber(value);
  if (raw === undefined || raw <= 0) return undefined;
  const normalized = normalizeTimestampMs(raw);
  if (normalized === undefined) return undefined;
  const timestamp = new Date(normalized);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

/** Return a human-readable schema summary for --show-schema. */
export function getDbSchema(dbPath: string): string {
  using db = new Database(dbPath, { readonly: true });
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();

  const lines: string[] = [];
  for (const { name } of tables) {
    const safeName = assertSafeIdentifier(name);
    const cols = db
      .query<{ name: string; type: string }, []>(`PRAGMA table_info(${safeName})`)
      .all();
    lines.push(`\nTable: ${name}`);
    for (const col of cols) {
      lines.push(`  ${col.name.padEnd(30)} ${col.type}`);
    }
  }
  return lines.join("\n");
}

function normalizeTimestampMs(value: OpenCodeSourceCell): number | undefined {
  const rawValue = sourceNumber(value);
  if (rawValue === undefined) {
    return undefined;
  }
  const milliseconds = rawValue > 1e12 ? rawValue : rawValue > 1e9 ? rawValue * 1000 : rawValue;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
}

function getTableColumns(db: Database, tableName: string): Set<string> {
  const safeTableName = assertSafeIdentifier(tableName);
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${safeTableName})`).all();
  return new Set(rows.map((row) => row.name));
}

function pickColumn(columns: Set<string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (columns.has(candidate)) return candidate;
  }
  return null;
}

function extractMessageRole(row: OpenCodeSourceRow, payload: OpenCodeMessage | null): string {
  return sourceText(row.role, payload?.role) ?? "";
}

function extractMessageBlocks(
  row: OpenCodeSourceRow,
  payload: OpenCodeMessage | null,
): OpenCodeContentBlock[] {
  const directBlocks = decodeMessageContent(row.content);
  if (directBlocks.length > 0) return directBlocks;

  const payloadBlocks = decodeMessageContent(payload?.content);
  if (payloadBlocks.length > 0) return payloadBlocks;

  const projectedSummary = sourceText(row.summary_title);
  if (projectedSummary) {
    return [{ type: "text", text: projectedSummary.trim() }];
  }

  const summary = payload?.summary;
  if (summary) {
    const title = summary.title;
    if (title?.trim()) {
      return [{ type: "text", text: title.trim() }];
    }
  }

  return [];
}

function projectPartBlock(row: OpenCodeSourceRow): OpenCodeContentBlock {
  const partType = sourceText(row.part_type) ?? "";
  if (partType === "text") {
    return { type: "text", text: sourceText(row.text) ?? "" };
  }
  if (partType === "tool") {
    const command = sourceText(row.command);
    const filePath = sourceText(row.file_path);
    return {
      type: "tool_use",
      name: sourceText(row.tool_name) ?? "unknown",
      input: {
        command,
        file_path: filePath,
      },
      error: row.tool_status === "error" || row.has_error === 1,
    };
  }
  return { type: partType };
}

/**
 * Read OpenCode sessions from SQLite database.
 */
export function readSessionsFromSqlite(
  dbPath: string,
  sinceTs: number | null,
  skillNames: Set<string>,
  onDiagnostic?: (message: string) => void,
): ParsedSession[] {
  using db = new Database(dbPath, { readonly: true });
  // oxlint-disable-next-line no-console -- standalone ingestor preserves legacy diagnostics
  const writeDiagnostic = onDiagnostic ?? ((message: string) => console.warn(message));

  // Detect available tables
  const tableRows = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  const tables = new Set(tableRows.map((r) => r.name));

  const sessionsTable =
    (tables.has("session") ? "session" : undefined) ??
    [...tables].find((table) => table.toLowerCase().includes("session"));
  const messagesTable =
    (tables.has("message") ? "message" : undefined) ??
    [...tables].find((table) => table.toLowerCase().includes("message"));

  if (!sessionsTable || !messagesTable) {
    writeDiagnostic(`[WARN] Could not find session/message tables in ${dbPath}`);
    writeDiagnostic(`       Available tables: ${[...tables].toSorted().join(", ")}`);
    return [];
  }

  const safeSessionsTable = assertSafeIdentifier(sessionsTable);
  const safeMessagesTable = assertSafeIdentifier(messagesTable);
  const sessionColumns = getTableColumns(db, safeSessionsTable);
  const messageColumns = getTableColumns(db, safeMessagesTable);
  const sessionTimeColumn = pickColumn(sessionColumns, [
    "created",
    "time_created",
    "createdAt",
    "timeCreated",
    "updated",
    "time_updated",
  ]);
  const messageTimeColumn = pickColumn(messageColumns, [
    "created",
    "time_created",
    "createdAt",
    "timeCreated",
    "updated",
    "time_updated",
  ]);
  const usesCurrentPartSchema = messageColumns.has("data") && tables.has("part");
  const safePartsTable = usesCurrentPartSchema ? assertSafeIdentifier("part") : null;

  // Get sessions
  let whereClause = "";
  const queryParams: number[] = [];
  if (sinceTs && sessionTimeColumn) {
    whereClause = `WHERE ${assertSafeIdentifier(sessionTimeColumn)} > ?`;
    queryParams.push(Math.floor(sinceTs * 1000));
  }
  const orderBySessionColumn = sessionTimeColumn ? assertSafeIdentifier(sessionTimeColumn) : "id";

  let sessionRows: OpenCodeSourceRow[];
  try {
    sessionRows = db
      .query<OpenCodeSourceRow, number[]>(
        `SELECT * FROM ${safeSessionsTable} ${whereClause} ORDER BY ${orderBySessionColumn} ASC`,
      )
      .all(...queryParams);
  } catch (e) {
    writeDiagnostic(`[WARN] Could not query sessions: ${e}`);
    return [];
  }

  const orderByMessageColumn = messageTimeColumn
    ? ` ORDER BY ${assertSafeIdentifier(messageTimeColumn)} ASC`
    : "";
  const parsedSessions: ParsedSession[] = [];

  for (let offset = 0; offset < sessionRows.length; offset += OPENCODE_SESSION_CHUNK_SIZE) {
    const sessionChunk = sessionRows.slice(offset, offset + OPENCODE_SESSION_CHUNK_SIZE);
    const sessionIds = sessionChunk.map((session) => String(session.id));
    const messageRowsBySession = new Map<string, OpenCodeSourceRow[]>();
    const partBlocksByMessage = new Map<string, OpenCodeContentBlock[]>();
    try {
      const placeholders = sessionIds.map(() => "?").join(", ");
      const messageSelection = usesCurrentPartSchema
        ? `id,
           session_id,
           time_created,
           time_updated,
           json_extract(data, '$.role') AS role,
           json_extract(data, '$.summary.title') AS summary_title,
           json_extract(data, '$.providerID') AS provider_id,
           json_extract(data, '$.modelID') AS model_id,
           json_extract(data, '$.path.cwd') AS cwd,
           json_extract(data, '$.tokens.input') AS input_tokens,
           json_extract(data, '$.tokens.output') AS output_tokens,
           CASE
             WHEN COALESCE(json_type(data, '$.error'), 'null') = 'null' THEN 0
             ELSE 1
           END AS payload_error,
           COALESCE(
             json_extract(data, '$.time.completed'),
             json_extract(data, '$.time.updated'),
             time_updated,
             time_created
           ) AS source_ended_at`
        : "*";
      const rows = db
        .query<OpenCodeSourceRow, string[]>(
          `SELECT ${messageSelection}
             FROM ${safeMessagesTable}
            WHERE session_id IN (${placeholders})${orderByMessageColumn}`,
        )
        .all(...sessionIds);
      for (const row of rows) {
        const sessionId = String(row.session_id);
        const existing = messageRowsBySession.get(sessionId);
        if (existing) existing.push(row);
        else messageRowsBySession.set(sessionId, [row]);
      }
      if (safePartsTable !== null) {
        const partRows = db
          .query<OpenCodeSourceRow, string[]>(
            `SELECT message_id,
                    json_extract(data, '$.type') AS part_type,
                    CASE
                      WHEN json_extract(data, '$.type') = 'text'
                      THEN substr(json_extract(data, '$.text'), 1, 65536)
                    END AS text,
                    json_extract(data, '$.tool') AS tool_name,
                    json_extract(data, '$.state.status') AS tool_status,
                    substr(json_extract(data, '$.state.input.command'), 1, 65536) AS command,
                    COALESCE(
                      json_extract(data, '$.state.input.filePath'),
                      json_extract(data, '$.state.input.file_path'),
                      json_extract(data, '$.state.input.path')
                    ) AS file_path,
                    CASE
                      WHEN COALESCE(json_type(data, '$.state.error'), 'null') = 'null' THEN 0
                      ELSE 1
                    END AS has_error
               FROM ${safePartsTable}
              WHERE session_id IN (${placeholders})
              ORDER BY time_created ASC`,
          )
          .all(...sessionIds);
        for (const row of partRows) {
          const messageId = String(row.message_id);
          const block = projectPartBlock(row);
          const existing = partBlocksByMessage.get(messageId);
          if (existing) existing.push(block);
          else partBlocksByMessage.set(messageId, [block]);
        }
      }
    } catch (e) {
      writeDiagnostic(`[WARN] Could not query session messages: ${e}`);
      return [];
    }

    for (const sessionRow of sessionChunk) {
      const sessionId = String(sessionRow.id);
      const createdMs =
        normalizeTimestampMs(sessionTimeColumn ? sessionRow[sessionTimeColumn] : Date.now()) ??
        Date.now();
      const timestamp = new Date(createdMs).toISOString();

      const msgRows = messageRowsBySession.get(sessionId) ?? [];

      let firstUserQuery = "";
      const toolCounts = new Map<string, number>();
      const bashCommands: string[] = [];
      const skillDetections = new Map<string, TriggeredSkillDetection>();
      let errors = 0;
      let assistantTurns = 0;
      let cwd = sourceText(sessionRow.directory) ?? "";
      let lastMessageTimestamp: string | undefined;
      let modelProvider: string | undefined;
      let model: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let hasInputTokens = false;
      let hasOutputTokens = false;

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
        const payload = parseOpenCodeMessage(msg.data);
        const role = extractMessageRole(msg, payload);
        const blocks =
          partBlocksByMessage.get(String(msg.id)) ?? extractMessageBlocks(msg, payload);
        const payloadTime = payload?.time;
        const messageTimestamp = sourceTimestamp(
          msg.source_ended_at ??
            (messageTimeColumn
              ? msg[messageTimeColumn]
              : (payloadTime?.updated ??
                payloadTime?.updatedAt ??
                payloadTime?.created ??
                payloadTime?.createdAt)),
        );
        if (
          messageTimestamp &&
          (!lastMessageTimestamp || messageTimestamp > lastMessageTimestamp)
        ) {
          lastMessageTimestamp = messageTimestamp;
        }
        const usage = payload?.usage ?? payload?.tokens;
        const provider = sourceProvider(payload?.provider);
        modelProvider ??= sourceText(
          payload?.provider,
          payload?.providerID,
          payload?.provider_id,
          provider?.id,
          provider?.name,
          msg.provider_id,
        );
        model ??= sourceText(payload?.model, payload?.modelID, payload?.model_id, msg.model_id);
        const messageInputTokens = sourceCount(
          usage?.input_tokens,
          usage?.input,
          usage?.prompt_tokens,
          msg.input_tokens,
        );
        const messageOutputTokens = sourceCount(
          usage?.output_tokens,
          usage?.output,
          usage?.completion_tokens,
          msg.output_tokens,
        );
        if (messageInputTokens !== undefined) {
          inputTokens += messageInputTokens;
          hasInputTokens = true;
        }
        if (messageOutputTokens !== undefined) {
          outputTokens += messageOutputTokens;
          hasOutputTokens = true;
        }
        const payloadPath = payload?.path;
        if (!cwd) {
          cwd = sourceText(payloadPath?.cwd, msg.cwd) ?? "";
        }

        if (role === "user") {
          if (!firstUserQuery) {
            for (const block of blocks) {
              if (block.type === "text") {
                const text = (block.text ?? "").trim();
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
                .map((b) => (b.text ?? "").trim())
                .filter((t) => t.length > 0);
              firstUserQuery = texts.join(" ").trim();
            }
          }
        } else if (role === "assistant") {
          assistantTurns += 1;
          if (payload?.error || msg.payload_error === 1) {
            errors += 1;
          }
          for (const block of blocks) {
            const blockType = block.type ?? "";

            // Anthropic tool use format
            if (blockType === "tool_use") {
              const toolName = block.name ?? "unknown";
              toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
              const inp = block.input;

              if (["Bash", "bash", "execute_bash"].includes(toolName)) {
                const cmd = (inp?.command ?? inp?.cmd ?? "").trim();
                if (cmd) bashCommands.push(cmd);
              }

              // Skill detection: file reads of SKILL.md
              if (["Read", "read", "read_file"].includes(toolName)) {
                const filePath = inp?.file_path ?? inp?.path ?? "";
                if (basename(filePath).toUpperCase() === "SKILL.MD") {
                  const skillName = basename(join(filePath, ".."));
                  noteSkillDetection(skillName, true);
                }
              }
              if (block.error) errors += 1;
            }

            // OpenAI tool calls format
            if (blockType === "tool_calls") {
              const tcs = block.tool_calls ?? [];
              for (const tc of tcs) {
                if (tc === null) continue;
                const toolName = tc.function?.name ?? "unknown";
                toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
              }
            }

            // Check text content for skill name mentions
            const textContent = block.text ?? "";
            for (const skillName of skillNames) {
              if (containsWholeSkillMention(textContent, skillName)) {
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

      const toolCalls = Object.fromEntries(toolCounts);
      const session: ParsedSession = {
        timestamp,
        session_id: sessionId,
        source: "opencode",
        transcript_path: dbPath,
        cwd,
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
      };
      if (lastMessageTimestamp && lastMessageTimestamp > timestamp)
        session.source_ended_at = lastMessageTimestamp;
      if (modelProvider) session.model_provider = modelProvider;
      if (model) session.model = model;
      if (hasInputTokens) session.input_tokens = inputTokens;
      if (hasOutputTokens) session.output_tokens = outputTokens;
      parsedSessions.push(session);
    }
    const processed = Math.min(offset + OPENCODE_SESSION_CHUNK_SIZE, sessionRows.length);
    if (
      onDiagnostic !== undefined &&
      (processed % (OPENCODE_SESSION_CHUNK_SIZE * 4) === 0 || processed === sessionRows.length)
    ) {
      onDiagnostic(`processed ${processed}/${sessionRows.length} OpenCode sessions`);
    }
  }

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
    .toSorted();

  for (const file of jsonFiles) {
    const filePath = join(sessionDir, file);
    let serialized: string;
    try {
      serialized = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const decoded = decodeOpenCodeSession(serialized);
    if (Option.isNone(decoded)) continue;
    const data = decoded.value;
    const sessionId = data.id ?? basename(file, ".json");
    let created = data.created ?? data.createdAt ?? 0;

    // Convert timestamp (may be seconds or milliseconds)
    if (created > 1e10) {
      created = created / 1000;
    }
    if (sinceTs && created < sinceTs) continue;

    const createdDate = new Date(created * 1000);
    if (!Number.isFinite(createdDate.getTime())) continue;
    const timestamp = createdDate.toISOString();
    const sessionTime = data.time;
    const sessionEndedAt = sourceTimestamp(
      data.updated ??
        data.updatedAt ??
        data.ended_at ??
        data.endedAt ??
        sessionTime?.updated ??
        sessionTime?.updatedAt,
    );
    const messages = (data.messages ?? []).filter((message) => message !== null);

    // Detect metadata-only session files (no message bodies)
    const isMetadataOnly = messages.length === 0;

    let firstUserQuery = "";
    const toolCounts = new Map<string, number>();
    const bashCommands: string[] = [];
    const skillDetections = new Map<string, TriggeredSkillDetection>();
    let errors = 0;
    let turns = 0;
    let lastMessageTimestamp: string | undefined;
    const sessionUsage = data.usage ?? data.tokens;
    let modelProvider = sourceText(data.provider, data.providerID, data.provider_id);
    let model = sourceText(data.model, data.modelID, data.model_id);
    const sessionInputTokens = sourceCount(
      sessionUsage?.input_tokens,
      sessionUsage?.input,
      sessionUsage?.prompt_tokens,
    );
    const sessionOutputTokens = sourceCount(
      sessionUsage?.output_tokens,
      sessionUsage?.output,
      sessionUsage?.completion_tokens,
    );
    let inputTokens = sessionInputTokens ?? 0;
    let outputTokens = sessionOutputTokens ?? 0;
    const hasSessionInputTokens = sessionInputTokens !== undefined;
    const hasSessionOutputTokens = sessionOutputTokens !== undefined;
    let hasInputTokens = hasSessionInputTokens;
    let hasOutputTokens = hasSessionOutputTokens;

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
      const role = msg.role ?? "";
      const blocks = decodeMessageContent(msg.content);
      const messageTime = msg.time;
      const messageTimestamp = sourceTimestamp(
        msg.updated ??
          msg.updatedAt ??
          msg.created ??
          msg.createdAt ??
          messageTime?.updated ??
          messageTime?.updatedAt ??
          messageTime?.created ??
          messageTime?.createdAt,
      );
      if (messageTimestamp && (!lastMessageTimestamp || messageTimestamp > lastMessageTimestamp)) {
        lastMessageTimestamp = messageTimestamp;
      }
      const messageUsage = msg.usage ?? msg.tokens;
      const provider = sourceProvider(msg.provider);
      modelProvider ??= sourceText(
        msg.provider,
        msg.providerID,
        msg.provider_id,
        provider?.id,
        provider?.name,
      );
      model ??= sourceText(msg.model, msg.modelID, msg.model_id);
      if (!hasSessionInputTokens) {
        const messageInputTokens = sourceCount(
          messageUsage?.input_tokens,
          messageUsage?.input,
          messageUsage?.prompt_tokens,
        );
        if (messageInputTokens !== undefined) {
          inputTokens = (inputTokens ?? 0) + messageInputTokens;
          hasInputTokens = true;
        }
      }
      if (!hasSessionOutputTokens) {
        const messageOutputTokens = sourceCount(
          messageUsage?.output_tokens,
          messageUsage?.output,
          messageUsage?.completion_tokens,
        );
        if (messageOutputTokens !== undefined) {
          outputTokens = (outputTokens ?? 0) + messageOutputTokens;
          hasOutputTokens = true;
        }
      }

      if (role === "user" && !firstUserQuery) {
        for (const block of blocks) {
          if (block.type === "text") {
            const text = (block.text ?? "").trim();
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
            const toolName = block.name ?? "unknown";
            toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
            const inp = block.input;
            if (["Bash", "bash"].includes(toolName)) {
              const cmd = (inp?.command ?? "").trim();
              if (cmd) bashCommands.push(cmd);
            }
            if (["Read", "read_file"].includes(toolName)) {
              const fp = inp?.file_path ?? "";
              if (basename(fp).toUpperCase() === "SKILL.MD") {
                const sn = basename(join(fp, ".."));
                noteSkillDetection(sn, true);
              }
            }
          }

          const text = block.text ?? "";
          for (const skillName of skillNames) {
            if (containsWholeSkillMention(text, skillName)) {
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

    const toolCalls = Object.fromEntries(toolCounts);
    const session: ParsedSession = {
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
    };
    if (sessionEndedAt && sessionEndedAt > timestamp) session.source_ended_at = sessionEndedAt;
    else if (lastMessageTimestamp && lastMessageTimestamp > timestamp)
      session.source_ended_at = lastMessageTimestamp;
    if (modelProvider) session.model_provider = modelProvider;
    if (model) session.model = model;
    if (hasInputTokens) session.input_tokens = inputTokens;
    if (hasOutputTokens) session.output_tokens = outputTokens;
    sessions.push(session);
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

  const telemetry: SessionTelemetryRecord = {
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
  };
  writeSessionTelemetryToDb(telemetry);

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
    writeSkillUsageToDb(skillRecord);
  }

  // --- Canonical normalization records (additive) ---
  const canonicalRecords = buildCanonicalRecordsFromOpenCode(session);
  appendCanonicalRecords(canonicalRecords, canonicalLogPath);
}
