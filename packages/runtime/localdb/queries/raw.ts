import type { Database } from "bun:sqlite";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SkillUsageRecord } from "../../types.js";
import type { queries, session_telemetry, skill_invocations } from "../drizzle-schema.js";
import { safeParseJsonArray, safeParseToolCounts } from "./json.js";

const decodeSkillScope = Schema.decodeUnknownOption(
  Schema.Literals(["project", "global", "admin", "system", "unknown"]),
);

export interface ReportSessionTelemetryRow {
  timestamp: string;
  session_id: string;
  cwd: string;
  errors_encountered: number;
  last_user_query: string;
}

export function querySessionTelemetry(db: Database, limit?: number) {
  const rows = db
    .query<typeof session_telemetry.$inferSelect, [number]>(
      `SELECT * FROM session_telemetry ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(limit ?? -1);
  return rows.map((row) => ({
    timestamp: row.timestamp,
    session_id: row.session_id,
    cwd: row.cwd ?? "",
    transcript_path: row.transcript_path ?? "",
    tool_calls: safeParseToolCounts(row.tool_calls_json),
    total_tool_calls: row.total_tool_calls ?? 0,
    bash_commands: safeParseJsonArray(row.bash_commands_json),
    skills_triggered: safeParseJsonArray(row.skills_triggered_json),
    skills_invoked: row.skills_invoked_json
      ? safeParseJsonArray(row.skills_invoked_json)
      : undefined,
    assistant_turns: row.assistant_turns ?? 0,
    errors_encountered: row.errors_encountered ?? 0,
    transcript_chars: row.transcript_chars ?? 0,
    last_user_query: row.last_user_query ?? "",
    source: row.source ?? undefined,
    input_tokens: row.input_tokens ?? undefined,
    output_tokens: row.output_tokens ?? undefined,
  }));
}

/** Load only the session columns consumed by the skill-intelligence report. */
export function querySessionTelemetryForReports(
  db: Database,
  recentQueryLimit?: number,
): ReportSessionTelemetryRow[] {
  const rows = db
    .query<
      {
        timestamp: string;
        session_id: string;
        cwd: string | null;
        errors_encountered: number | null;
      },
      []
    >(
      `SELECT timestamp, session_id, cwd, errors_encountered
       FROM session_telemetry
       ORDER BY timestamp DESC`,
    )
    .all();
  const queryLimit =
    recentQueryLimit === undefined ? -1 : Math.max(0, Math.trunc(recentQueryLimit));
  const recentQueries = db
    .query<{ session_id: string; last_user_query: string | null }, [number]>(
      `SELECT session_id, last_user_query
       FROM session_telemetry
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(queryLimit);
  const queryBySessionId = new Map(
    recentQueries.map((row) => [row.session_id, row.last_user_query ?? ""]),
  );
  return rows.map((row) => ({
    timestamp: row.timestamp,
    session_id: row.session_id,
    cwd: row.cwd ?? "",
    errors_encountered: row.errors_encountered ?? 0,
    last_user_query: queryBySessionId.get(row.session_id) ?? "",
  }));
}

/** Return project roots observed by legacy telemetry or canonical sessions. */
export function queryKnownWorkspacePaths(db: Database): string[] {
  return db
    .query<{ workspace_path: string }, []>(
      `SELECT cwd AS workspace_path
       FROM session_telemetry
       WHERE cwd IS NOT NULL AND trim(cwd) <> ''
       UNION
       SELECT workspace_path
       FROM sessions
       WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
       ORDER BY workspace_path`,
    )
    .all()
    .map((row) => row.workspace_path);
}

export function querySkillRecords(db: Database, limit?: number): SkillUsageRecord[] {
  const rows = db
    .query<
      Pick<
        typeof skill_invocations.$inferSelect,
        | "occurred_at"
        | "session_id"
        | "skill_name"
        | "skill_path"
        | "skill_scope"
        | "query"
        | "triggered"
        | "source"
      >,
      [number]
    >(`SELECT occurred_at, session_id, skill_name, skill_path, skill_scope, query, triggered, source
     FROM skill_invocations ORDER BY occurred_at DESC LIMIT ?`)
    .all(limit ?? -1);
  return rows.map((row) => ({
    timestamp: row.occurred_at ?? "",
    session_id: row.session_id,
    skill_name: row.skill_name,
    skill_path: row.skill_path ?? "",
    skill_scope: Option.getOrUndefined(decodeSkillScope(row.skill_scope)),
    query: row.query ?? "",
    triggered: row.triggered === 1,
    source: row.source ?? undefined,
  }));
}

export const querySkillUsageRecords = querySkillRecords;

export function queryQueryLog(db: Database, limit?: number) {
  return db
    .query<
      Pick<typeof queries.$inferSelect, "timestamp" | "session_id" | "query" | "source">,
      [number]
    >(`SELECT timestamp, session_id, query, source FROM queries ORDER BY timestamp DESC LIMIT ?`)
    .all(limit ?? -1)
    .map((row) => ({ ...row, source: row.source ?? undefined }));
}
