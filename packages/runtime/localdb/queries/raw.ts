import type { Database } from "bun:sqlite";

import type { SkillUsageRecord } from "../../types.js";
import { safeParseJson, safeParseJsonArray } from "./json.js";

export function querySessionTelemetry(
  db: Database,
  limit?: number,
): Array<{
  timestamp: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skills_invoked?: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
  source?: string;
  input_tokens?: number;
  output_tokens?: number;
}> {
  const sql =
    limit != null
      ? `SELECT * FROM session_telemetry ORDER BY timestamp DESC LIMIT ${limit}`
      : `SELECT * FROM session_telemetry ORDER BY timestamp DESC`;
  const rows = db.query(sql).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    timestamp: row.timestamp as string,
    session_id: row.session_id as string,
    cwd: row.cwd as string,
    transcript_path: row.transcript_path as string,
    tool_calls: (safeParseJson(row.tool_calls_json as string) as Record<string, number>) ?? {},
    total_tool_calls: row.total_tool_calls as number,
    bash_commands: safeParseJsonArray<string>(row.bash_commands_json as string),
    skills_triggered: safeParseJsonArray<string>(row.skills_triggered_json as string),
    skills_invoked: row.skills_invoked_json
      ? safeParseJsonArray<string>(row.skills_invoked_json as string)
      : undefined,
    assistant_turns: row.assistant_turns as number,
    errors_encountered: row.errors_encountered as number,
    transcript_chars: (row.transcript_chars as number) ?? 0,
    last_user_query: (row.last_user_query as string) ?? "",
    source: row.source as string | undefined,
    input_tokens: row.input_tokens as number | undefined,
    output_tokens: row.output_tokens as number | undefined,
  }));
}

export function querySkillRecords(db: Database, limit?: number): SkillUsageRecord[] {
  const sql =
    limit != null
      ? `SELECT occurred_at, session_id, skill_name, skill_path, skill_scope, query, triggered, source
     FROM skill_invocations ORDER BY occurred_at DESC LIMIT ${limit}`
      : `SELECT occurred_at, session_id, skill_name, skill_path, skill_scope, query, triggered, source
     FROM skill_invocations ORDER BY occurred_at DESC`;
  const rows = db.query(sql).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    timestamp: row.occurred_at as string,
    session_id: row.session_id as string,
    skill_name: row.skill_name as string,
    skill_path: row.skill_path as string,
    skill_scope: row.skill_scope as SkillUsageRecord["skill_scope"],
    query: row.query as string,
    triggered: (row.triggered as number) === 1,
    source: row.source as string | undefined,
  }));
}

export const querySkillUsageRecords = querySkillRecords;

export function queryQueryLog(
  db: Database,
  limit?: number,
): Array<{
  timestamp: string;
  session_id: string;
  query: string;
  source?: string;
}> {
  const sql =
    limit != null
      ? `SELECT timestamp, session_id, query, source FROM queries ORDER BY timestamp DESC LIMIT ${limit}`
      : `SELECT timestamp, session_id, query, source FROM queries ORDER BY timestamp DESC`;
  return db.query(sql).all() as Array<{
    timestamp: string;
    session_id: string;
    query: string;
    source?: string;
  }>;
}
