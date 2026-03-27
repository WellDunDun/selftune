/**
 * Query helpers for the selftune local SQLite materialized view store.
 *
 * These return payload shapes that match what the dashboard and report
 * pages need, so the HTTP layer can serve them directly.
 */

import type { Database } from "bun:sqlite";

import type {
  OrchestrateRunReport,
  OverviewPayload,
  PendingProposal,
  RecentActivityItem,
  SkillReportPayload,
  SkillSummary,
} from "../dashboard-contract.js";

/**
 * Build the overview payload from SQLite, suitable for the dashboard main page.
 */
export function getOverviewPayload(db: Database): OverviewPayload {
  // Telemetry summary (bounded to most recent 1000)
  const telemetryRows = db
    .query(
      `SELECT timestamp, session_id, skills_triggered_json, errors_encountered, total_tool_calls
       FROM session_telemetry
       ORDER BY timestamp DESC
       LIMIT 1000`,
    )
    .all() as Array<{
    timestamp: string;
    session_id: string;
    skills_triggered_json: string | null;
    errors_encountered: number;
    total_tool_calls: number;
  }>;

  const telemetry = telemetryRows.map((row) => ({
    timestamp: row.timestamp,
    session_id: row.session_id,
    skills_triggered: safeParseJsonArray<string>(row.skills_triggered_json),
    errors_encountered: row.errors_encountered,
    total_tool_calls: row.total_tool_calls,
  }));

  // Skill usage (bounded to most recent 2000)
  const skillRows = db
    .query(
      `SELECT occurred_at, session_id, skill_name, skill_path, query, triggered, source
       FROM skill_invocations
       ORDER BY occurred_at DESC
       LIMIT 2000`,
    )
    .all() as Array<{
    occurred_at: string;
    session_id: string;
    skill_name: string;
    skill_path: string;
    query: string;
    triggered: number;
    source: string | null;
  }>;

  const skills = skillRows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    skill_name: row.skill_name,
    skill_path: row.skill_path,
    query: row.query,
    triggered: row.triggered === 1,
    source: row.source,
  }));

  // Evolution audit (bounded to most recent 500)
  const evolution = db
    .query(
      `SELECT timestamp, proposal_id, skill_name, action, details
       FROM evolution_audit
       ORDER BY timestamp DESC
       LIMIT 500`,
    )
    .all() as Array<{
    timestamp: string;
    proposal_id: string;
    skill_name: string | null;
    action: string;
    details: string;
  }>;

  // Counts (single query instead of 6 separate ones)
  const counts = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM session_telemetry) as telemetry,
         (SELECT COUNT(*) FROM skill_invocations) as skills,
         (SELECT COUNT(*) FROM evolution_audit) as evolution,
         (SELECT COUNT(*) FROM evolution_evidence) as evidence,
         (SELECT COUNT(*) FROM sessions) as sessions,
         (SELECT COUNT(*) FROM prompts) as prompts`,
    )
    .get() as {
    telemetry: number;
    skills: number;
    evolution: number;
    evidence: number;
    sessions: number;
    prompts: number;
  };

  // Unmatched queries: skill_invocations entries where triggered = 0 and no other
  // record for the same query text triggered
  const unmatchedRows = db
    .query(
      `SELECT si.occurred_at AS timestamp, si.session_id, si.query
       FROM skill_invocations si
       WHERE si.triggered = 0
         AND NOT EXISTS (
           SELECT 1 FROM skill_invocations si2
           WHERE si2.query = si.query AND si2.triggered = 1
         )
       ORDER BY si.occurred_at DESC
       LIMIT 500`,
    )
    .all() as Array<{ timestamp: string; session_id: string; query: string }>;

  // Pending proposals: created/validated but no terminal action (deduped in SQL)
  const pending_proposals = getPendingProposals(db);

  // Active sessions and recent activity
  const active_sessions = getActiveSessionCount(db);
  const recent_activity = getRecentActivity(db);

  return {
    telemetry,
    skills,
    evolution,
    counts,
    unmatched_queries: unmatchedRows,
    pending_proposals,
    active_sessions,
    recent_activity,
  };
}

/**
 * Build the skill report payload for a specific skill.
 */
export function getSkillReportPayload(db: Database, skillName: string): SkillReportPayload {
  // Usage stats
  const usageRow = db
    .query(
      `SELECT
         COUNT(*) as total_checks,
         SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) as triggered_count
       FROM skill_invocations
       WHERE skill_name = ?`,
    )
    .get(skillName) as { total_checks: number; triggered_count: number };

  const total = usageRow.total_checks;
  const triggered = usageRow.triggered_count;
  const passRate = total > 0 ? triggered / total : 0;

  // Recent invocations (last 100)
  const invocationRows = db
    .query(
      `SELECT occurred_at, session_id, query, triggered, source
       FROM skill_invocations
       WHERE skill_name = ?
       ORDER BY occurred_at DESC
       LIMIT 100`,
    )
    .all(skillName) as Array<{
    occurred_at: string;
    session_id: string;
    query: string;
    triggered: number;
    source: string | null;
  }>;

  const recent_invocations = invocationRows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    query: row.query,
    triggered: row.triggered === 1,
    source: row.source,
  }));

  // Evolution evidence (bounded to most recent 200)
  const evidenceRows = db
    .query(
      `SELECT proposal_id, target, stage, timestamp, rationale, confidence,
              original_text, proposed_text, validation_json, details, eval_set_json
       FROM evolution_evidence
       WHERE skill_name = ?
       ORDER BY timestamp DESC
       LIMIT 200`,
    )
    .all(skillName) as Array<{
    proposal_id: string;
    target: string;
    stage: string;
    timestamp: string;
    rationale: string | null;
    confidence: number | null;
    original_text: string | null;
    proposed_text: string | null;
    validation_json: string | null;
    details: string | null;
    eval_set_json: string | null;
  }>;

  const evidence = evidenceRows.map((row) => ({
    proposal_id: row.proposal_id,
    target: row.target,
    stage: row.stage,
    timestamp: row.timestamp,
    rationale: row.rationale,
    confidence: row.confidence,
    original_text: row.original_text,
    proposed_text: row.proposed_text,
    validation: safeParseJson(row.validation_json),
    details: row.details,
    eval_set: safeParseJsonArray<Record<string, unknown>>(row.eval_set_json),
  }));

  // Unique sessions count
  const sessionsRow = db
    .query(`SELECT COUNT(DISTINCT session_id) as c FROM skill_invocations WHERE skill_name = ?`)
    .get(skillName) as { c: number };

  return {
    skill_name: skillName,
    usage: {
      total_checks: total,
      triggered_count: triggered,
      pass_rate: passRate,
    },
    recent_invocations,
    evidence,
    sessions_with_skill: sessionsRow.c,
  };
}

/**
 * Get a summary list of all skills with aggregated stats.
 */
export function getSkillsList(db: Database): SkillSummary[] {
  const rows = db
    .query(
      `SELECT
         si.skill_name,
         COALESCE(
           (SELECT s2.skill_scope FROM skill_invocations s2
            WHERE s2.skill_name = si.skill_name AND s2.skill_scope IS NOT NULL
            ORDER BY s2.occurred_at DESC LIMIT 1),
           (SELECT su.skill_scope FROM skill_usage su
            WHERE su.skill_name = si.skill_name AND su.skill_scope IS NOT NULL
            ORDER BY su.timestamp DESC LIMIT 1)
         ) as skill_scope,
         COUNT(*) as total_checks,
         SUM(CASE WHEN si.triggered = 1 THEN 1 ELSE 0 END) as triggered_count,
         COUNT(DISTINCT si.session_id) as unique_sessions,
         MAX(si.occurred_at) as last_seen
       FROM skill_invocations si
       GROUP BY si.skill_name
       ORDER BY total_checks DESC`,
    )
    .all() as Array<{
    skill_name: string;
    skill_scope: string | null;
    total_checks: number;
    triggered_count: number;
    unique_sessions: number;
    last_seen: string | null;
  }>;

  // Get set of skill names with evidence
  const evidenceSkills = new Set(
    (
      db.query(`SELECT DISTINCT skill_name FROM evolution_evidence`).all() as Array<{
        skill_name: string;
      }>
    ).map((r) => r.skill_name),
  );

  return rows.map((row) => ({
    skill_name: row.skill_name,
    skill_scope: row.skill_scope,
    total_checks: row.total_checks,
    triggered_count: row.triggered_count,
    pass_rate: row.total_checks > 0 ? row.triggered_count / row.total_checks : 0,
    unique_sessions: row.unique_sessions,
    last_seen: row.last_seen,
    has_evidence: evidenceSkills.has(row.skill_name),
  }));
}

/**
 * Get pending proposals (created/validated with no terminal action).
 * Optionally filtered by skill_name.
 */
export function getPendingProposals(db: Database, skillName?: string): PendingProposal[] {
  const whereClause = skillName ? "WHERE ea.skill_name = ? AND" : "WHERE";
  const params = skillName ? [skillName] : [];
  return db
    .query(
      `WITH latest AS (
         SELECT ea.proposal_id, ea.action, ea.timestamp, ea.details, ea.skill_name,
                ROW_NUMBER() OVER (PARTITION BY ea.proposal_id ORDER BY ea.timestamp DESC, ea.id DESC) AS rn
         FROM evolution_audit ea
         LEFT JOIN evolution_audit ea2
           ON ea2.proposal_id = ea.proposal_id
           AND ea2.action IN ('deployed', 'rejected', 'rolled_back')
         ${whereClause} ea.action IN ('created', 'validated')
           AND ea2.id IS NULL
       )
       SELECT proposal_id, action, timestamp, details, skill_name
       FROM latest
       WHERE rn = 1
       ORDER BY timestamp DESC`,
    )
    .all(...params) as PendingProposal[];
}

/**
 * Get recent orchestrate run reports (most recent first).
 */
export function getOrchestrateRuns(db: Database, limit = 20): OrchestrateRunReport[] {
  const rows = db
    .query(
      `SELECT run_id, timestamp, elapsed_ms, dry_run, approval_mode,
              total_skills, evaluated, evolved, deployed, watched, skipped,
              skill_actions_json
       FROM orchestrate_runs
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    run_id: string;
    timestamp: string;
    elapsed_ms: number;
    dry_run: number;
    approval_mode: string;
    total_skills: number;
    evaluated: number;
    evolved: number;
    deployed: number;
    watched: number;
    skipped: number;
    skill_actions_json: string;
  }>;

  return rows.map((r) => ({
    run_id: r.run_id,
    timestamp: r.timestamp,
    elapsed_ms: r.elapsed_ms,
    dry_run: r.dry_run === 1,
    approval_mode: r.approval_mode as "auto" | "review",
    total_skills: r.total_skills,
    evaluated: r.evaluated,
    evolved: r.evolved,
    deployed: r.deployed,
    watched: r.watched,
    skipped: r.skipped,
    skill_actions: safeParseJsonArray(r.skill_actions_json),
  }));
}

/**
 * Count sessions that have queries recorded but no session_telemetry yet
 * (i.e., the session is still in progress).
 */
export function getActiveSessionCount(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT q.session_id) as count
       FROM queries q
       WHERE NOT EXISTS (
         SELECT 1 FROM session_telemetry st WHERE st.session_id = q.session_id
       )`,
    )
    .get() as { count: number };
  return row.count;
}

/**
 * Get the most recent skill invocations with a flag indicating whether the
 * session is still in progress (no session_telemetry row yet).
 */
export function getRecentActivity(db: Database, limit = 20): RecentActivityItem[] {
  const rows = db
    .query(
      `SELECT si.occurred_at, si.session_id, si.skill_name, si.query, si.triggered,
              CASE WHEN st.session_id IS NULL THEN 1 ELSE 0 END as is_live
       FROM skill_invocations si
       LEFT JOIN session_telemetry st ON si.session_id = st.session_id
       ORDER BY si.occurred_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    occurred_at: string;
    session_id: string;
    skill_name: string;
    query: string;
    triggered: number;
    is_live: number;
  }>;

  return rows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    skill_name: row.skill_name,
    query: row.query ?? "",
    triggered: row.triggered === 1,
    is_live: row.is_live === 1,
  }));
}

// -- Generic read queries (Phase 3: replace readJsonl calls) ------------------

/**
 * Read all session telemetry records from SQLite.
 * Replaces: readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG)
 */
export function querySessionTelemetry(db: Database): Array<{
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
  const rows = db.query(`SELECT * FROM session_telemetry ORDER BY timestamp DESC`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    session_id: r.session_id as string,
    cwd: r.cwd as string,
    transcript_path: r.transcript_path as string,
    tool_calls: (safeParseJson(r.tool_calls_json as string) as Record<string, number>) ?? {},
    total_tool_calls: r.total_tool_calls as number,
    bash_commands: safeParseJsonArray<string>(r.bash_commands_json as string),
    skills_triggered: safeParseJsonArray<string>(r.skills_triggered_json as string),
    skills_invoked: r.skills_invoked_json
      ? safeParseJsonArray<string>(r.skills_invoked_json as string)
      : undefined,
    assistant_turns: r.assistant_turns as number,
    errors_encountered: r.errors_encountered as number,
    transcript_chars: (r.transcript_chars as number) ?? 0,
    last_user_query: (r.last_user_query as string) ?? "",
    source: r.source as string | undefined,
    input_tokens: r.input_tokens as number | undefined,
    output_tokens: r.output_tokens as number | undefined,
  }));
}

/**
 * Read all skill invocation records from SQLite.
 * Replaces: readEffectiveSkillUsageRecords()
 */
export function querySkillRecords(db: Database): Array<{
  timestamp: string;
  session_id: string;
  skill_name: string;
  skill_path: string;
  skill_scope?: string;
  query: string;
  triggered: boolean;
  source?: string;
}> {
  const rows = db
    .query(
      `SELECT occurred_at, session_id, skill_name, skill_path, skill_scope, query, triggered, source
     FROM skill_invocations ORDER BY occurred_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    timestamp: r.occurred_at as string,
    session_id: r.session_id as string,
    skill_name: r.skill_name as string,
    skill_path: r.skill_path as string,
    skill_scope: r.skill_scope as string | undefined,
    query: r.query as string,
    triggered: (r.triggered as number) === 1,
    source: r.source as string | undefined,
  }));
}

/** @deprecated Use querySkillRecords instead. Kept for backward compatibility. */
export const querySkillUsageRecords = querySkillRecords;

/**
 * Read all query log records from SQLite.
 * Replaces: readJsonl<QueryLogRecord>(QUERY_LOG)
 */
export function queryQueryLog(db: Database): Array<{
  timestamp: string;
  session_id: string;
  query: string;
  source?: string;
}> {
  return db
    .query(`SELECT timestamp, session_id, query, source FROM queries ORDER BY timestamp DESC`)
    .all() as Array<{ timestamp: string; session_id: string; query: string; source?: string }>;
}

/**
 * Read all evolution audit entries from SQLite.
 * Replaces: readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG)
 */
export function queryEvolutionAudit(
  db: Database,
  skillName?: string,
): Array<{
  timestamp: string;
  proposal_id: string;
  skill_name?: string;
  action: string;
  details: string;
  eval_snapshot?: Record<string, unknown>;
}> {
  const sql = skillName
    ? `SELECT * FROM evolution_audit
       WHERE skill_name = ?
          OR (skill_name IS NULL AND proposal_id LIKE 'evo-' || ? || '-%')
       ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_audit ORDER BY timestamp DESC`;
  const rows = (skillName ? db.query(sql).all(skillName, skillName) : db.query(sql).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    proposal_id: r.proposal_id as string,
    skill_name: r.skill_name as string | undefined,
    action: r.action as string,
    details: r.details as string,
    eval_snapshot: r.eval_snapshot_json
      ? (safeParseJson(r.eval_snapshot_json as string) as Record<string, unknown>)
      : undefined,
  }));
}

/**
 * Read all evolution evidence entries from SQLite.
 * Replaces: readEvidenceTrail() / readJsonl<EvolutionEvidenceEntry>(EVOLUTION_EVIDENCE_LOG)
 */
export function queryEvolutionEvidence(
  db: Database,
  skillName?: string,
): Array<{
  timestamp: string;
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  target: string;
  stage: string;
  rationale?: string;
  confidence?: number;
  details?: string;
  original_text?: string;
  proposed_text?: string;
  eval_set?: Record<string, unknown>[];
  validation?: Record<string, unknown>;
}> {
  const sql = skillName
    ? `SELECT * FROM evolution_evidence WHERE skill_name = ? ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_evidence ORDER BY timestamp DESC`;
  const rows = (skillName ? db.query(sql).all(skillName) : db.query(sql).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    proposal_id: r.proposal_id as string,
    skill_name: r.skill_name as string,
    skill_path: r.skill_path as string,
    target: r.target as string,
    stage: r.stage as string,
    rationale: r.rationale as string | undefined,
    confidence: r.confidence as number | undefined,
    details: r.details as string | undefined,
    original_text: r.original_text as string | undefined,
    proposed_text: r.proposed_text as string | undefined,
    eval_set: r.eval_set_json
      ? safeParseJsonArray<Record<string, unknown>>(r.eval_set_json as string)
      : undefined,
    validation: r.validation_json
      ? (safeParseJson(r.validation_json as string) as Record<string, unknown>)
      : undefined,
  }));
}

/**
 * Read improvement signals from SQLite.
 * Replaces: readJsonl<ImprovementSignalRecord>(SIGNAL_LOG)
 */
export function queryImprovementSignals(
  db: Database,
  consumedOnly?: boolean,
): Array<{
  timestamp: string;
  session_id: string;
  query: string;
  signal_type: string;
  mentioned_skill?: string;
  consumed: boolean;
  consumed_at?: string;
  consumed_by_run?: string;
}> {
  const where =
    consumedOnly === undefined ? "" : consumedOnly ? " WHERE consumed = 1" : " WHERE consumed = 0";
  const rows = db
    .query(`SELECT * FROM improvement_signals${where} ORDER BY timestamp DESC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    session_id: r.session_id as string,
    query: r.query as string,
    signal_type: r.signal_type as string,
    mentioned_skill: r.mentioned_skill as string | undefined,
    consumed: (r.consumed as number) === 1,
    consumed_at: r.consumed_at as string | undefined,
    consumed_by_run: r.consumed_by_run as string | undefined,
  }));
}

// -- Grading results query ----------------------------------------------------

/**
 * Read grading results from SQLite for upload staging.
 */
export function queryGradingResults(db: Database): Array<{
  grading_id: string;
  session_id: string;
  skill_name: string;
  transcript_path: string | null;
  graded_at: string;
  pass_rate: number | null;
  mean_score: number | null;
  score_std_dev: number | null;
  passed_count: number | null;
  failed_count: number | null;
  total_count: number | null;
  expectations_json: string | null;
  claims_json: string | null;
  eval_feedback_json: string | null;
  failure_feedback_json: string | null;
  execution_metrics_json: string | null;
}> {
  return db
    .query(
      `SELECT grading_id, session_id, skill_name, transcript_path, graded_at,
              pass_rate, mean_score, score_std_dev, passed_count, failed_count, total_count,
              expectations_json, claims_json, eval_feedback_json, failure_feedback_json,
              execution_metrics_json
       FROM grading_results
       ORDER BY graded_at DESC`,
    )
    .all() as Array<{
    grading_id: string;
    session_id: string;
    skill_name: string;
    transcript_path: string | null;
    graded_at: string;
    pass_rate: number | null;
    mean_score: number | null;
    score_std_dev: number | null;
    passed_count: number | null;
    failed_count: number | null;
    total_count: number | null;
    expectations_json: string | null;
    claims_json: string | null;
    eval_feedback_json: string | null;
    failure_feedback_json: string | null;
    execution_metrics_json: string | null;
  }>;
}

// -- Canonical record staging query -------------------------------------------

/**
 * Query canonical records from SQLite tables for upload staging.
 *
 * Reads from sessions, prompts, skill_invocations, and execution_facts tables,
 * shaping each row into a CanonicalRecord-compatible object with record_kind.
 *
 * Returns all records; dedup is handled by INSERT OR IGNORE in the staging table.
 */
export function queryCanonicalRecordsForStaging(db: Database): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  // Sessions
  const sessions = db
    .query(
      `SELECT session_id, started_at, ended_at, platform, model, completion_status,
              source_session_kind, agent_cli, workspace_path, repo_remote, branch,
              schema_version, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM sessions ORDER BY normalized_at`,
    )
    .all() as Array<Record<string, unknown>>;
  const sessionById = new Map(sessions.map((s) => [s.session_id as string, s]));
  for (const s of sessions) {
    records.push({
      record_kind: "session",
      schema_version: s.schema_version ?? undefined,
      normalizer_version: s.normalizer_version ?? undefined,
      normalized_at: s.normalized_at ?? undefined,
      platform: s.platform ?? undefined,
      capture_mode: s.capture_mode ?? undefined,
      raw_source_ref: safeParseJson(s.raw_source_ref as string | null) ?? undefined,
      source_session_kind: s.source_session_kind ?? undefined,
      session_id: s.session_id,
      started_at: s.started_at ?? undefined,
      ended_at: s.ended_at ?? undefined,
      model: s.model ?? undefined,
      completion_status: s.completion_status ?? undefined,
      agent_cli: s.agent_cli ?? undefined,
      workspace_path: s.workspace_path ?? undefined,
      repo_remote: s.repo_remote ?? undefined,
      branch: s.branch ?? undefined,
    });
  }

  // Prompts
  const prompts = db
    .query(
      `SELECT prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text,
              schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM prompts ORDER BY occurred_at`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const p of prompts) {
    // Fall back to session-level envelope fields if prompt doesn't have its own
    const sessionEnvelope = sessionById.get(p.session_id as string);
    records.push({
      record_kind: "prompt",
      schema_version: p.schema_version ?? sessionEnvelope?.schema_version ?? undefined,
      normalizer_version: p.normalizer_version ?? sessionEnvelope?.normalizer_version ?? undefined,
      normalized_at: p.normalized_at ?? sessionEnvelope?.normalized_at ?? undefined,
      platform: p.platform ?? sessionEnvelope?.platform ?? undefined,
      capture_mode: p.capture_mode ?? sessionEnvelope?.capture_mode ?? undefined,
      raw_source_ref:
        safeParseJson(p.raw_source_ref as string | null) ??
        safeParseJson(sessionEnvelope?.raw_source_ref as string | null) ??
        undefined,
      source_session_kind: sessionEnvelope?.source_session_kind ?? undefined,
      session_id: p.session_id,
      prompt_id: p.prompt_id,
      occurred_at: p.occurred_at,
      prompt_text: p.prompt_text,
      prompt_kind: p.prompt_kind,
      is_actionable: (p.is_actionable as number) === 1,
      prompt_index: p.prompt_index ?? undefined,
    });
  }

  // Skill invocations
  const invocations = db
    .query(
      `SELECT skill_invocation_id, session_id, occurred_at, skill_name, skill_path, invocation_mode,
              triggered, confidence, tool_name, matched_prompt_id, agent_type,
              schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM skill_invocations ORDER BY occurred_at`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const si of invocations) {
    const sessionEnvelope = sessionById.get(si.session_id as string);
    records.push({
      record_kind: "skill_invocation",
      schema_version: si.schema_version ?? sessionEnvelope?.schema_version ?? undefined,
      normalizer_version: si.normalizer_version ?? sessionEnvelope?.normalizer_version ?? undefined,
      normalized_at: si.normalized_at ?? sessionEnvelope?.normalized_at ?? undefined,
      platform: si.platform ?? sessionEnvelope?.platform ?? undefined,
      capture_mode: si.capture_mode ?? sessionEnvelope?.capture_mode ?? undefined,
      raw_source_ref:
        safeParseJson(si.raw_source_ref as string | null) ??
        safeParseJson(sessionEnvelope?.raw_source_ref as string | null) ??
        undefined,
      source_session_kind: sessionEnvelope?.source_session_kind ?? undefined,
      session_id: si.session_id,
      skill_invocation_id: si.skill_invocation_id,
      occurred_at: si.occurred_at,
      skill_name: si.skill_name,
      skill_path: si.skill_path ?? undefined,
      invocation_mode: si.invocation_mode,
      triggered: (si.triggered as number) === 1,
      confidence: si.confidence,
      tool_name: si.tool_name ?? undefined,
      matched_prompt_id: si.matched_prompt_id ?? undefined,
      agent_type: si.agent_type ?? undefined,
    });
  }

  // Execution facts
  const facts = db
    .query(
      `SELECT id AS execution_fact_id, session_id, occurred_at, prompt_id, tool_calls_json, total_tool_calls,
              assistant_turns, errors_encountered, input_tokens, output_tokens,
              duration_ms, completion_status,
              schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref
       FROM execution_facts ORDER BY occurred_at`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const ef of facts) {
    const sessionEnvelope = sessionById.get(ef.session_id as string);
    records.push({
      record_kind: "execution_fact",
      schema_version: ef.schema_version ?? sessionEnvelope?.schema_version ?? undefined,
      normalizer_version: ef.normalizer_version ?? sessionEnvelope?.normalizer_version ?? undefined,
      normalized_at: ef.normalized_at ?? sessionEnvelope?.normalized_at ?? undefined,
      platform: ef.platform ?? sessionEnvelope?.platform ?? undefined,
      capture_mode: ef.capture_mode ?? sessionEnvelope?.capture_mode ?? undefined,
      raw_source_ref:
        safeParseJson(ef.raw_source_ref as string | null) ??
        safeParseJson(sessionEnvelope?.raw_source_ref as string | null) ??
        undefined,
      source_session_kind: sessionEnvelope?.source_session_kind ?? undefined,
      session_id: ef.session_id,
      execution_fact_id: String(ef.execution_fact_id),
      occurred_at: ef.occurred_at,
      prompt_id: ef.prompt_id ?? undefined,
      tool_calls_json: safeParseJson(ef.tool_calls_json as string | null) ?? {},
      total_tool_calls: ef.total_tool_calls,
      assistant_turns: ef.assistant_turns,
      errors_encountered: ef.errors_encountered,
      input_tokens: ef.input_tokens ?? undefined,
      output_tokens: ef.output_tokens ?? undefined,
      duration_ms: ef.duration_ms ?? undefined,
      completion_status: ef.completion_status ?? undefined,
    });
  }

  return records;
}

// -- Alpha upload query helpers -----------------------------------------------

/**
 * Get the most recent failed queue item's error and timestamp.
 * Returns null if no failed items exist.
 */
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

/**
 * Get the most recent sent queue item's timestamp.
 * Returns null if no sent items exist.
 */
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

/**
 * Get the age in seconds of the oldest pending queue item.
 * Returns null if no pending items exist.
 */
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

// -- Helpers ------------------------------------------------------------------

export function safeParseJsonArray<T = string>(json: string | null): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function safeParseJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
