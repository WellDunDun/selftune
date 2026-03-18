/**
 * Alpha upload payload builder.
 *
 * Reads local SQLite rows (sessions, invocations, evolution audit) and
 * constructs AlphaUploadEnvelope payloads for the alpha remote pipeline.
 *
 * Each builder function supports cursor-based pagination via afterId
 * (SQLite rowid) and caps batch size at 100 records by default.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AlphaUploadEnvelope,
  AlphaSessionPayload,
  AlphaInvocationPayload,
  AlphaEvolutionPayload,
} from "../alpha-upload-contract.js";

// -- Helpers ------------------------------------------------------------------

/** SHA256 hex hash of a string (used for workspace path hashing). */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Parse a JSON array string, returning [] on failure. */
function safeParseJsonArray<T = string>(json: string | null): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Parse a JSON object string, returning null on failure. */
function safeParseJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Build an envelope shell with the given metadata. */
function makeEnvelope(
  userId: string,
  agentType: string,
  version: string,
  payloadType: AlphaUploadEnvelope["payload_type"],
  payload: AlphaUploadEnvelope["payload"],
): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: userId,
    agent_type: agentType,
    selftune_version: version,
    uploaded_at: new Date().toISOString(),
    payload_type: payloadType,
    payload,
  };
}

// -- Result type --------------------------------------------------------------

export interface BuildResult<T> {
  envelope: AlphaUploadEnvelope;
  lastId: number;
}

// -- Session payloads ---------------------------------------------------------

/**
 * Read sessions from SQLite and map to AlphaSessionPayload[].
 *
 * Joins sessions + session_telemetry to get the full picture.
 * Uses session_telemetry rowid for cursor pagination since sessions
 * table uses TEXT primary keys.
 *
 * Returns null when no new rows exist.
 */
export function buildSessionPayloads(
  db: Database,
  userId: string,
  agentType: string,
  selftuneVersion: string,
  afterId?: number,
  limit: number = 100,
): BuildResult<AlphaSessionPayload> | null {
  const whereClause = afterId !== undefined ? "WHERE st.rowid > ?" : "";
  const params = afterId !== undefined ? [afterId, limit] : [limit];

  const sql = `
    SELECT
      st.rowid as _rowid,
      s.session_id,
      s.platform,
      s.model,
      s.workspace_path,
      s.started_at,
      s.ended_at,
      s.completion_status,
      st.total_tool_calls,
      st.assistant_turns,
      st.errors_encountered,
      st.skills_triggered_json
    FROM session_telemetry st
    LEFT JOIN sessions s ON s.session_id = st.session_id
    ${whereClause}
    ORDER BY st.rowid ASC
    LIMIT ?
  `;

  const rows = db.query(sql).all(...params) as Array<{
    _rowid: number;
    session_id: string;
    platform: string | null;
    model: string | null;
    workspace_path: string | null;
    started_at: string | null;
    ended_at: string | null;
    completion_status: string | null;
    total_tool_calls: number;
    assistant_turns: number;
    errors_encountered: number;
    skills_triggered_json: string | null;
  }>;

  if (rows.length === 0) return null;

  const payloads: AlphaSessionPayload[] = rows.map((r) => ({
    session_id: r.session_id,
    platform: r.platform ?? null,
    model: r.model ?? null,
    workspace_hash: sha256(r.workspace_path ?? ""),
    started_at: r.started_at ?? null,
    ended_at: r.ended_at ?? null,
    total_tool_calls: r.total_tool_calls ?? 0,
    assistant_turns: r.assistant_turns ?? 0,
    errors_encountered: r.errors_encountered ?? 0,
    skills_triggered: safeParseJsonArray<string>(r.skills_triggered_json),
    completion_status: r.completion_status ?? null,
  }));

  const lastId = rows[rows.length - 1]._rowid;

  return {
    envelope: makeEnvelope(userId, agentType, selftuneVersion, "sessions", payloads),
    lastId,
  };
}

// -- Invocation payloads ------------------------------------------------------

/**
 * Read skill invocations from SQLite and map to AlphaInvocationPayload[].
 *
 * Uses rowid for cursor pagination. query_text passes through unchanged
 * (no hashing, no truncation) -- this is the friendly alpha cohort.
 *
 * Returns null when no new rows exist.
 */
export function buildInvocationPayloads(
  db: Database,
  userId: string,
  agentType: string,
  selftuneVersion: string,
  afterId?: number,
  limit: number = 100,
): BuildResult<AlphaInvocationPayload> | null {
  const whereClause = afterId !== undefined ? "WHERE rowid > ?" : "";
  const params = afterId !== undefined ? [afterId, limit] : [limit];

  const sql = `
    SELECT
      rowid as _rowid,
      session_id,
      occurred_at,
      skill_name,
      invocation_mode,
      triggered,
      confidence,
      query,
      skill_scope,
      source
    FROM skill_invocations
    ${whereClause}
    ORDER BY rowid ASC
    LIMIT ?
  `;

  const rows = db.query(sql).all(...params) as Array<{
    _rowid: number;
    session_id: string;
    occurred_at: string;
    skill_name: string;
    invocation_mode: string | null;
    triggered: number;
    confidence: number | null;
    query: string;
    skill_scope: string | null;
    source: string | null;
  }>;

  if (rows.length === 0) return null;

  const payloads: AlphaInvocationPayload[] = rows.map((r) => ({
    session_id: r.session_id,
    occurred_at: r.occurred_at,
    skill_name: r.skill_name,
    invocation_mode: r.invocation_mode ?? null,
    triggered: r.triggered === 1,
    confidence: r.confidence ?? null,
    query_text: r.query ?? "",
    skill_scope: r.skill_scope ?? null,
    source: r.source ?? null,
  }));

  const lastId = rows[rows.length - 1]._rowid;

  return {
    envelope: makeEnvelope(userId, agentType, selftuneVersion, "invocations", payloads),
    lastId,
  };
}

// -- Evolution payloads -------------------------------------------------------

/**
 * Read evolution audit entries from SQLite and map to AlphaEvolutionPayload[].
 *
 * Extracts pass rates from eval_snapshot_json when available.
 * Uses the auto-increment id for cursor pagination.
 *
 * Returns null when no new rows exist.
 */
export function buildEvolutionPayloads(
  db: Database,
  userId: string,
  agentType: string,
  selftuneVersion: string,
  afterId?: number,
  limit: number = 100,
): BuildResult<AlphaEvolutionPayload> | null {
  const whereClause = afterId !== undefined ? "WHERE id > ?" : "";
  const params = afterId !== undefined ? [afterId, limit] : [limit];

  const sql = `
    SELECT
      id,
      timestamp,
      proposal_id,
      skill_name,
      action,
      details,
      eval_snapshot_json
    FROM evolution_audit
    ${whereClause}
    ORDER BY id ASC
    LIMIT ?
  `;

  const rows = db.query(sql).all(...params) as Array<{
    id: number;
    timestamp: string;
    proposal_id: string;
    skill_name: string | null;
    action: string;
    details: string | null;
    eval_snapshot_json: string | null;
  }>;

  if (rows.length === 0) return null;

  const payloads: AlphaEvolutionPayload[] = rows.map((r) => {
    const snapshot = safeParseJson(r.eval_snapshot_json) as {
      pass_rate?: number;
      before_pass_rate?: number;
      after_pass_rate?: number;
      net_change?: number;
    } | null;

    // Try to extract before/after pass rates from snapshot
    const afterPassRate = snapshot?.after_pass_rate ?? snapshot?.pass_rate ?? null;
    const beforePassRate = snapshot?.before_pass_rate ?? null;
    const netChange =
      snapshot?.net_change ??
      (afterPassRate !== null && beforePassRate !== null
        ? afterPassRate - beforePassRate
        : null);

    return {
      proposal_id: r.proposal_id,
      skill_name: r.skill_name ?? "",
      action: r.action,
      before_pass_rate: beforePassRate,
      after_pass_rate: afterPassRate,
      net_change: netChange,
      deployed: r.action === "deployed",
      rolled_back: r.action === "rolled_back",
      timestamp: r.timestamp,
    };
  });

  const lastId = rows[rows.length - 1].id;

  return {
    envelope: makeEnvelope(userId, agentType, selftuneVersion, "evolution", payloads),
    lastId,
  };
}
