/**
 * Query helpers for the selftune local SQLite materialized view store.
 *
 * These return payload shapes that match what the dashboard and report
 * pages need, so the HTTP layer can serve them directly.
 */

import type { Database } from "bun:sqlite";
import type {
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

// -- Helpers ------------------------------------------------------------------

function safeParseJsonArray<T = string>(json: string | null): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeParseJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
