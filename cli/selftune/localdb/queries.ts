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
      `SELECT timestamp, session_id, skill_name, skill_path, query, triggered, source
       FROM skill_usage
       ORDER BY timestamp DESC
       LIMIT 2000`,
    )
    .all() as Array<{
    timestamp: string;
    session_id: string;
    skill_name: string;
    skill_path: string;
    query: string;
    triggered: number;
    source: string | null;
  }>;

  const skills = skillRows.map((row) => ({
    timestamp: row.timestamp,
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
      `SELECT timestamp, proposal_id, action, details
       FROM evolution_audit
       ORDER BY timestamp DESC
       LIMIT 500`,
    )
    .all() as Array<{
    timestamp: string;
    proposal_id: string;
    action: string;
    details: string;
  }>;

  // Counts (single query instead of 6 separate ones)
  const counts = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM session_telemetry) as telemetry,
         (SELECT COUNT(*) FROM skill_usage) as skills,
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

  // Unmatched queries: skill_usage entries where triggered = 0 and no other
  // record for the same query text triggered
  const unmatchedRows = db
    .query(
      `SELECT su.timestamp, su.session_id, su.query
       FROM skill_usage su
       WHERE su.triggered = 0
         AND NOT EXISTS (
           SELECT 1 FROM skill_usage su2
           WHERE su2.query = su.query AND su2.triggered = 1
         )
       ORDER BY su.timestamp DESC
       LIMIT 500`,
    )
    .all() as Array<{ timestamp: string; session_id: string; query: string }>;

  // Pending proposals: created/validated but no terminal action (deduped in SQL)
  const pending_proposals = getPendingProposals(db);

  return {
    telemetry,
    skills,
    evolution,
    counts,
    unmatched_queries: unmatchedRows,
    pending_proposals,
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
       FROM skill_usage
       WHERE skill_name = ?`,
    )
    .get(skillName) as { total_checks: number; triggered_count: number };

  const total = usageRow.total_checks;
  const triggered = usageRow.triggered_count;
  const passRate = total > 0 ? triggered / total : 0;

  // Recent invocations (last 100)
  const invocationRows = db
    .query(
      `SELECT timestamp, session_id, query, triggered, source
       FROM skill_usage
       WHERE skill_name = ?
       ORDER BY timestamp DESC
       LIMIT 100`,
    )
    .all(skillName) as Array<{
    timestamp: string;
    session_id: string;
    query: string;
    triggered: number;
    source: string | null;
  }>;

  const recent_invocations = invocationRows.map((row) => ({
    timestamp: row.timestamp,
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
    .query(`SELECT COUNT(DISTINCT session_id) as c FROM skill_usage WHERE skill_name = ?`)
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
         su.skill_name,
         (SELECT s2.skill_scope FROM skill_usage s2
          WHERE s2.skill_name = su.skill_name AND s2.skill_scope IS NOT NULL
          ORDER BY s2.timestamp DESC LIMIT 1) as skill_scope,
         COUNT(*) as total_checks,
         SUM(CASE WHEN su.triggered = 1 THEN 1 ELSE 0 END) as triggered_count,
         COUNT(DISTINCT su.session_id) as unique_sessions,
         MAX(su.timestamp) as last_seen
       FROM skill_usage su
       GROUP BY su.skill_name
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

// -- Generic read queries (Phase 3: replace readJsonl calls) ------------------

/**
 * Read all session telemetry records from SQLite.
 * Replaces: readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG)
 */
export function querySessionTelemetry(db: Database): Array<{
  timestamp: string; session_id: string; cwd: string; transcript_path: string;
  tool_calls: Record<string, number>; total_tool_calls: number;
  bash_commands: string[]; skills_triggered: string[]; skills_invoked?: string[];
  assistant_turns: number; errors_encountered: number;
  transcript_chars: number; last_user_query: string;
  source?: string; input_tokens?: number; output_tokens?: number;
}> {
  const rows = db.query(
    `SELECT * FROM session_telemetry ORDER BY timestamp DESC`
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    session_id: r.session_id as string,
    cwd: r.cwd as string,
    transcript_path: r.transcript_path as string,
    tool_calls: safeParseJson(r.tool_calls_json as string) as Record<string, number> ?? {},
    total_tool_calls: r.total_tool_calls as number,
    bash_commands: safeParseJsonArray<string>(r.bash_commands_json as string),
    skills_triggered: safeParseJsonArray<string>(r.skills_triggered_json as string),
    skills_invoked: r.skills_invoked_json ? safeParseJsonArray<string>(r.skills_invoked_json as string) : undefined,
    assistant_turns: r.assistant_turns as number,
    errors_encountered: r.errors_encountered as number,
    transcript_chars: r.transcript_chars as number ?? 0,
    last_user_query: r.last_user_query as string ?? "",
    source: r.source as string | undefined,
    input_tokens: r.input_tokens as number | undefined,
    output_tokens: r.output_tokens as number | undefined,
  }));
}

/**
 * Read all skill usage records from SQLite.
 * Replaces: readEffectiveSkillUsageRecords()
 */
export function querySkillUsageRecords(db: Database): Array<{
  timestamp: string; session_id: string; skill_name: string; skill_path: string;
  skill_scope?: string; query: string; triggered: boolean; source?: string;
}> {
  const rows = db.query(
    `SELECT timestamp, session_id, skill_name, skill_path, skill_scope, query, triggered, source
     FROM skill_usage ORDER BY timestamp DESC`
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    session_id: r.session_id as string,
    skill_name: r.skill_name as string,
    skill_path: r.skill_path as string,
    skill_scope: r.skill_scope as string | undefined,
    query: r.query as string,
    triggered: (r.triggered as number) === 1,
    source: r.source as string | undefined,
  }));
}

/**
 * Read all query log records from SQLite.
 * Replaces: readJsonl<QueryLogRecord>(QUERY_LOG)
 */
export function queryQueryLog(db: Database): Array<{
  timestamp: string; session_id: string; query: string; source?: string;
}> {
  return db.query(
    `SELECT timestamp, session_id, query, source FROM queries ORDER BY timestamp DESC`
  ).all() as Array<{ timestamp: string; session_id: string; query: string; source?: string }>;
}

/**
 * Read all evolution audit entries from SQLite.
 * Replaces: readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG)
 */
export function queryEvolutionAudit(db: Database, skillName?: string): Array<{
  timestamp: string; proposal_id: string; skill_name?: string;
  action: string; details: string; eval_snapshot?: Record<string, unknown>;
}> {
  const sql = skillName
    ? `SELECT * FROM evolution_audit WHERE skill_name = ? ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_audit ORDER BY timestamp DESC`;
  const rows = (skillName ? db.query(sql).all(skillName) : db.query(sql).all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    proposal_id: r.proposal_id as string,
    skill_name: r.skill_name as string | undefined,
    action: r.action as string,
    details: r.details as string,
    eval_snapshot: r.eval_snapshot_json ? safeParseJson(r.eval_snapshot_json as string) as Record<string, unknown> : undefined,
  }));
}

/**
 * Read all evolution evidence entries from SQLite.
 * Replaces: readEvidenceTrail() / readJsonl<EvolutionEvidenceEntry>(EVOLUTION_EVIDENCE_LOG)
 */
export function queryEvolutionEvidence(db: Database, skillName?: string): Array<{
  timestamp: string; proposal_id: string; skill_name: string; skill_path: string;
  target: string; stage: string; rationale?: string; confidence?: number;
  details?: string; original_text?: string; proposed_text?: string;
  eval_set?: Record<string, unknown>[]; validation?: Record<string, unknown>;
}> {
  const sql = skillName
    ? `SELECT * FROM evolution_evidence WHERE skill_name = ? ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_evidence ORDER BY timestamp DESC`;
  const rows = (skillName ? db.query(sql).all(skillName) : db.query(sql).all()) as Array<Record<string, unknown>>;
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
    eval_set: r.eval_set_json ? safeParseJsonArray<Record<string, unknown>>(r.eval_set_json as string) : undefined,
    validation: r.validation_json ? safeParseJson(r.validation_json as string) as Record<string, unknown> : undefined,
  }));
}

/**
 * Read improvement signals from SQLite.
 * Replaces: readJsonl<ImprovementSignalRecord>(SIGNAL_LOG)
 */
export function queryImprovementSignals(db: Database, consumedOnly?: boolean): Array<{
  timestamp: string; session_id: string; query: string;
  signal_type: string; mentioned_skill?: string;
  consumed: boolean; consumed_at?: string; consumed_by_run?: string;
}> {
  const where = consumedOnly === undefined ? "" : consumedOnly ? " WHERE consumed = 1" : " WHERE consumed = 0";
  const rows = db.query(
    `SELECT * FROM improvement_signals${where} ORDER BY timestamp DESC`
  ).all() as Array<Record<string, unknown>>;
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
