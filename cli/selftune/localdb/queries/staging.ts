import type { Database } from "bun:sqlite";

import { safeParseJson } from "./json.js";

export function getCreatorContributionStagingCounts(db: Database): Array<{
  skill_name: string;
  pending_count: number;
}> {
  return db
    .query(
      `SELECT skill_name, COUNT(*) AS pending_count
       FROM creator_contribution_staging
       WHERE status = 'pending'
       GROUP BY skill_name
       ORDER BY skill_name`,
    )
    .all() as Array<{
    skill_name: string;
    pending_count: number;
  }>;
}

export interface CreatorContributionRelayStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

export interface CreatorContributionStagingRow {
  id: number;
  dedupe_key: string;
  skill_name: string;
  creator_id: string;
  payload_json: string;
  status: string;
  staged_at: string;
  updated_at: string;
  last_error: string | null;
}

export function getCreatorContributionRelayStats(db: Database): CreatorContributionRelayStats {
  const row = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END), 0) AS sending,
         COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM creator_contribution_staging`,
    )
    .get() as CreatorContributionRelayStats | null;
  return row ?? { pending: 0, sending: 0, sent: 0, failed: 0 };
}

export function getPendingCreatorContributionRows(
  db: Database,
  limit = 50,
): CreatorContributionStagingRow[] {
  return db
    .query(
      `SELECT id, dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at, last_error
       FROM creator_contribution_staging
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(limit) as CreatorContributionStagingRow[];
}

export function queryCanonicalRecordsForStaging(db: Database): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  const sessions = db
    .query(
      `SELECT session_id, started_at, ended_at, platform, model, completion_status,
              source_session_kind, agent_cli, workspace_path, repo_remote, branch,
              schema_version, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM sessions ORDER BY normalized_at`,
    )
    .all() as Array<Record<string, unknown>>;
  const sessionById = new Map(sessions.map((session) => [session.session_id as string, session]));

  for (const session of sessions) {
    records.push({
      record_kind: "session",
      schema_version: session.schema_version ?? undefined,
      normalizer_version: session.normalizer_version ?? undefined,
      normalized_at: session.normalized_at ?? undefined,
      platform: session.platform ?? undefined,
      capture_mode: session.capture_mode ?? undefined,
      raw_source_ref: safeParseJson(session.raw_source_ref as string | null) ?? undefined,
      source_session_kind: session.source_session_kind ?? undefined,
      session_id: session.session_id,
      started_at: session.started_at ?? undefined,
      ended_at: session.ended_at ?? undefined,
      model: session.model ?? undefined,
      completion_status: session.completion_status ?? undefined,
      agent_cli: session.agent_cli ?? undefined,
      workspace_path: session.workspace_path ?? undefined,
      repo_remote: session.repo_remote ?? undefined,
      branch: session.branch ?? undefined,
    });
  }

  const prompts = db
    .query(
      `SELECT prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text,
              schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM prompts ORDER BY occurred_at`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const prompt of prompts) {
    const sessionEnvelope = sessionById.get(prompt.session_id as string);
    records.push({
      record_kind: "prompt",
      schema_version: prompt.schema_version ?? sessionEnvelope?.schema_version ?? undefined,
      normalizer_version:
        prompt.normalizer_version ?? sessionEnvelope?.normalizer_version ?? undefined,
      normalized_at: prompt.normalized_at ?? sessionEnvelope?.normalized_at ?? undefined,
      platform: prompt.platform ?? sessionEnvelope?.platform ?? undefined,
      capture_mode: prompt.capture_mode ?? sessionEnvelope?.capture_mode ?? undefined,
      raw_source_ref:
        safeParseJson(prompt.raw_source_ref as string | null) ??
        safeParseJson(sessionEnvelope?.raw_source_ref as string | null) ??
        undefined,
      source_session_kind: sessionEnvelope?.source_session_kind ?? undefined,
      session_id: prompt.session_id,
      prompt_id: prompt.prompt_id,
      occurred_at: prompt.occurred_at,
      prompt_text: prompt.prompt_text,
      prompt_kind: prompt.prompt_kind,
      is_actionable: (prompt.is_actionable as number) === 1,
      prompt_index: prompt.prompt_index ?? undefined,
    });
  }

  const invocations = db
    .query(
      `SELECT skill_invocation_id, session_id, occurred_at, skill_name, skill_path, skill_version_hash, invocation_mode,
              triggered, confidence, tool_name, matched_prompt_id, agent_type,
              schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM skill_invocations ORDER BY occurred_at`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const invocation of invocations) {
    const sessionEnvelope = sessionById.get(invocation.session_id as string);
    records.push({
      record_kind: "skill_invocation",
      schema_version: invocation.schema_version ?? sessionEnvelope?.schema_version ?? undefined,
      normalizer_version:
        invocation.normalizer_version ?? sessionEnvelope?.normalizer_version ?? undefined,
      normalized_at: invocation.normalized_at ?? sessionEnvelope?.normalized_at ?? undefined,
      platform: invocation.platform ?? sessionEnvelope?.platform ?? undefined,
      capture_mode: invocation.capture_mode ?? sessionEnvelope?.capture_mode ?? undefined,
      raw_source_ref:
        safeParseJson(invocation.raw_source_ref as string | null) ??
        safeParseJson(sessionEnvelope?.raw_source_ref as string | null) ??
        undefined,
      source_session_kind: sessionEnvelope?.source_session_kind ?? undefined,
      session_id: invocation.session_id,
      skill_invocation_id: invocation.skill_invocation_id,
      occurred_at: invocation.occurred_at,
      skill_name: invocation.skill_name,
      skill_path: invocation.skill_path ?? undefined,
      skill_version_hash: invocation.skill_version_hash ?? undefined,
      invocation_mode: invocation.invocation_mode,
      triggered: (invocation.triggered as number) === 1,
      confidence: invocation.confidence,
      tool_name: invocation.tool_name ?? undefined,
      matched_prompt_id: invocation.matched_prompt_id ?? undefined,
      agent_type: invocation.agent_type ?? undefined,
    });
  }

  const facts = db
    .query(
      `SELECT id AS execution_fact_id, session_id, occurred_at, prompt_id, tool_calls_json, total_tool_calls,
              assistant_turns, errors_encountered, input_tokens, output_tokens,
              duration_ms, completion_status,
              schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM execution_facts ORDER BY occurred_at`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const fact of facts) {
    const sessionEnvelope = sessionById.get(fact.session_id as string);
    records.push({
      record_kind: "execution_fact",
      schema_version: fact.schema_version ?? sessionEnvelope?.schema_version ?? undefined,
      normalizer_version:
        fact.normalizer_version ?? sessionEnvelope?.normalizer_version ?? undefined,
      normalized_at: fact.normalized_at ?? sessionEnvelope?.normalized_at ?? undefined,
      platform: fact.platform ?? sessionEnvelope?.platform ?? undefined,
      capture_mode: fact.capture_mode ?? sessionEnvelope?.capture_mode ?? undefined,
      raw_source_ref:
        safeParseJson(fact.raw_source_ref as string | null) ??
        safeParseJson(sessionEnvelope?.raw_source_ref as string | null) ??
        undefined,
      source_session_kind: sessionEnvelope?.source_session_kind ?? undefined,
      session_id: fact.session_id,
      execution_fact_id: String(fact.execution_fact_id),
      occurred_at: fact.occurred_at,
      prompt_id: fact.prompt_id ?? undefined,
      tool_calls_json: safeParseJson(fact.tool_calls_json as string | null) ?? {},
      total_tool_calls: fact.total_tool_calls,
      assistant_turns: fact.assistant_turns,
      errors_encountered: fact.errors_encountered,
      input_tokens: fact.input_tokens ?? undefined,
      output_tokens: fact.output_tokens ?? undefined,
      duration_ms: fact.duration_ms ?? undefined,
      completion_status: fact.completion_status ?? undefined,
    });
  }

  return records;
}

export function getLastUploadError(
  db: Database,
): { last_error: string | null; updated_at: string } | null {
  try {
    const row = db
      .query(
        `SELECT last_error, updated_at
         FROM upload_queue
         WHERE status = 'failed'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get() as { last_error: string | null; updated_at: string } | null;
    return row ?? null;
  } catch {
    return null;
  }
}

export function getLastUploadSuccess(db: Database): { updated_at: string } | null {
  try {
    const row = db
      .query(
        `SELECT updated_at
         FROM upload_queue
         WHERE status = 'sent'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get() as { updated_at: string } | null;
    return row ?? null;
  } catch {
    return null;
  }
}

export function getOldestPendingAge(db: Database): number | null {
  try {
    const row = db
      .query(
        `SELECT created_at
         FROM upload_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as { created_at: string } | null;
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    return Math.floor(ageMs / 1000);
  } catch {
    return null;
  }
}
