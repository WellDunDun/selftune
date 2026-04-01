/**
 * Query helpers for the selftune local SQLite materialized view store.
 *
 * These return payload shapes that match what the dashboard and report
 * pages need, so the HTTP layer can serve them directly.
 */

import type { Database } from "bun:sqlite";

import type {
  AnalyticsResponse,
  AttentionItem,
  AutonomousDecision,
  CommitRecord,
  CommitSummary,
  DecisionKind,
  ExecutionMetrics,
  OrchestrateRunReport,
  OverviewPaginatedPayload,
  OverviewPayload,
  PaginatedResult,
  PaginationCursor,
  PendingProposal,
  RecentActivityItem,
  SkillReportPaginatedPayload,
  SkillReportPayload,
  SkillSummary,
  SkillUsageRecord,
  TelemetryRecord,
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

// -- Cursor-based paginated queries -------------------------------------------

export interface OverviewPaginationOptions {
  telemetry_cursor?: PaginationCursor | null;
  telemetry_limit?: number;
  skills_cursor?: PaginationCursor | null;
  skills_limit?: number;
}

export interface SkillReportPaginationOptions {
  invocations_cursor?: PaginationCursor | null;
  invocations_limit?: number;
}

/**
 * Build a paginated overview payload from SQLite.
 *
 * Uses (timestamp, session_id) composite cursors for stable backward pagination.
 * When no cursor is provided, returns the first page starting from most recent.
 */
export function getOverviewPayloadPaginated(
  db: Database,
  opts: OverviewPaginationOptions = {},
): OverviewPaginatedPayload {
  const telemetryLimit = opts.telemetry_limit ?? 1000;
  const skillsLimit = opts.skills_limit ?? 2000;

  // Paginated telemetry
  const telemetry_page = paginateTelemetry(db, telemetryLimit, opts.telemetry_cursor ?? null);

  // Paginated skill invocations
  const skills_page = paginateSkillInvocations(db, skillsLimit, opts.skills_cursor ?? null);

  // Non-paginated parts reuse existing logic
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

  const pending_proposals = getPendingProposals(db);
  const active_sessions = getActiveSessionCount(db);
  const recent_activity = getRecentActivity(db);

  return {
    telemetry_page,
    skills_page,
    evolution,
    counts,
    unmatched_queries: unmatchedRows,
    pending_proposals,
    active_sessions,
    recent_activity,
  };
}

/**
 * Build a paginated skill report payload for a specific skill.
 *
 * Uses (occurred_at, skill_invocation_id) composite cursor for the recent
 * invocations sub-query. Non-paginated fields (usage stats, evidence, sessions)
 * are returned in full.
 */
export function getSkillReportPayloadPaginated(
  db: Database,
  skillName: string,
  opts: SkillReportPaginationOptions = {},
): SkillReportPaginatedPayload {
  const invocationsLimit = opts.invocations_limit ?? 100;

  // Usage stats (unchanged)
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

  // Paginated invocations
  const invocations_page = paginateSkillReportInvocations(
    db,
    skillName,
    invocationsLimit,
    opts.invocations_cursor ?? null,
  );

  // Evidence (unchanged)
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
    invocations_page,
    evidence,
    sessions_with_skill: sessionsRow.c,
  };
}

// -- Internal pagination helpers ------------------------------------------------

function paginateTelemetry(
  db: Database,
  limit: number,
  cursor: PaginationCursor | null,
): PaginatedResult<TelemetryRecord> {
  // Fetch one extra to detect has_more
  const fetchLimit = limit + 1;

  let rows: Array<{
    timestamp: string;
    session_id: string;
    skills_triggered_json: string | null;
    errors_encountered: number;
    total_tool_calls: number;
  }>;

  if (cursor) {
    rows = db
      .query(
        `SELECT timestamp, session_id, skills_triggered_json, errors_encountered, total_tool_calls
         FROM session_telemetry
         WHERE (timestamp < ? OR (timestamp = ? AND session_id < ?))
         ORDER BY timestamp DESC, session_id DESC
         LIMIT ?`,
      )
      .all(cursor.timestamp, cursor.timestamp, String(cursor.id), fetchLimit) as typeof rows;
  } else {
    rows = db
      .query(
        `SELECT timestamp, session_id, skills_triggered_json, errors_encountered, total_tool_calls
         FROM session_telemetry
         ORDER BY timestamp DESC, session_id DESC
         LIMIT ?`,
      )
      .all(fetchLimit) as typeof rows;
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: TelemetryRecord[] = pageRows.map((row) => ({
    timestamp: row.timestamp,
    session_id: row.session_id,
    skills_triggered: safeParseJsonArray<string>(row.skills_triggered_json),
    errors_encountered: row.errors_encountered,
    total_tool_calls: row.total_tool_calls,
  }));

  const lastItem = pageRows[pageRows.length - 1];
  const next_cursor: PaginationCursor | null =
    hasMore && lastItem ? { timestamp: lastItem.timestamp, id: lastItem.session_id } : null;

  return { items, next_cursor, has_more: hasMore };
}

function paginateSkillInvocations(
  db: Database,
  limit: number,
  cursor: PaginationCursor | null,
): PaginatedResult<SkillUsageRecord> {
  const fetchLimit = limit + 1;

  let rows: Array<{
    occurred_at: string;
    session_id: string;
    skill_name: string;
    skill_path: string;
    query: string;
    triggered: number;
    source: string | null;
    skill_invocation_id: string;
  }>;

  if (cursor) {
    rows = db
      .query(
        `SELECT occurred_at, session_id, skill_name, skill_path, query, triggered, source, skill_invocation_id
         FROM skill_invocations
         WHERE (occurred_at < ? OR (occurred_at = ? AND skill_invocation_id < ?))
         ORDER BY occurred_at DESC, skill_invocation_id DESC
         LIMIT ?`,
      )
      .all(cursor.timestamp, cursor.timestamp, String(cursor.id), fetchLimit) as typeof rows;
  } else {
    rows = db
      .query(
        `SELECT occurred_at, session_id, skill_name, skill_path, query, triggered, source, skill_invocation_id
         FROM skill_invocations
         ORDER BY occurred_at DESC, skill_invocation_id DESC
         LIMIT ?`,
      )
      .all(fetchLimit) as typeof rows;
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: SkillUsageRecord[] = pageRows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    skill_name: row.skill_name,
    skill_path: row.skill_path,
    query: row.query,
    triggered: row.triggered === 1,
    source: row.source,
  }));

  const lastRow = pageRows[pageRows.length - 1];
  const next_cursor: PaginationCursor | null =
    hasMore && lastRow ? { timestamp: lastRow.occurred_at, id: lastRow.skill_invocation_id } : null;

  return { items, next_cursor, has_more: hasMore };
}

function paginateSkillReportInvocations(
  db: Database,
  skillName: string,
  limit: number,
  cursor: PaginationCursor | null,
): PaginatedResult<{
  timestamp: string;
  session_id: string;
  query: string;
  triggered: boolean;
  source: string | null;
}> {
  const fetchLimit = limit + 1;

  let rows: Array<{
    occurred_at: string;
    session_id: string;
    query: string;
    triggered: number;
    source: string | null;
    skill_invocation_id: string;
  }>;

  if (cursor) {
    rows = db
      .query(
        `SELECT si.occurred_at, si.session_id, COALESCE(si.query, p.prompt_text) as query,
                si.triggered, si.source, si.skill_invocation_id
         FROM skill_invocations si
         LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id
         WHERE si.skill_name = ?
           AND (si.occurred_at < ? OR (si.occurred_at = ? AND si.skill_invocation_id < ?))
         ORDER BY si.occurred_at DESC, si.skill_invocation_id DESC
         LIMIT ?`,
      )
      .all(
        skillName,
        cursor.timestamp,
        cursor.timestamp,
        String(cursor.id),
        fetchLimit,
      ) as typeof rows;
  } else {
    rows = db
      .query(
        `SELECT si.occurred_at, si.session_id, COALESCE(si.query, p.prompt_text) as query,
                si.triggered, si.source, si.skill_invocation_id
         FROM skill_invocations si
         LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id
         WHERE si.skill_name = ?
         ORDER BY si.occurred_at DESC, si.skill_invocation_id DESC
         LIMIT ?`,
      )
      .all(skillName, fetchLimit) as typeof rows;
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items = pageRows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    query: row.query ?? "",
    triggered: row.triggered === 1,
    source: row.source,
  }));

  const lastRow = pageRows[pageRows.length - 1];
  const next_cursor: PaginationCursor | null =
    hasMore && lastRow ? { timestamp: lastRow.occurred_at, id: lastRow.skill_invocation_id } : null;

  return { items, next_cursor, has_more: hasMore };
}

/**
 * Get a summary list of all skills with aggregated stats.
 */
export function getSkillsList(db: Database): SkillSummary[] {
  const trustedRows = getTrustedSkillObservationRows(db);
  const bySkill = new Map<
    string,
    Array<{
      skill_name: string;
      session_id: string;
      occurred_at: string | null;
      triggered: number;
      matched_prompt_id: string | null;
      confidence: number | null;
    }>
  >();

  for (const row of trustedRows) {
    const arr = bySkill.get(row.skill_name);
    const base = {
      skill_name: row.skill_name,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      triggered: row.triggered,
      matched_prompt_id: row.matched_prompt_id,
      confidence: row.confidence,
    };
    if (arr) arr.push(base);
    else bySkill.set(row.skill_name, [base]);
  }

  // Get set of skill names with evidence
  const evidenceSkills = new Set(
    (
      db.query(`SELECT DISTINCT skill_name FROM evolution_evidence`).all() as Array<{
        skill_name: string;
      }>
    ).map((r) => r.skill_name),
  );

  const skillScopeRows = db
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
         ) as skill_scope
       FROM skill_invocations si
       GROUP BY si.skill_name`,
    )
    .all() as Array<{ skill_name: string; skill_scope: string | null }>;
  const scopeBySkill = new Map(skillScopeRows.map((row) => [row.skill_name, row.skill_scope]));

  return [...bySkill.entries()]
    .map(([skillName, rows]) => {
      const totalChecks = rows.length;
      const triggeredCount = rows.filter((row) => row.triggered === 1).length;
      const uniqueSessions = new Set(rows.map((row) => row.session_id)).size;
      const lastSeen =
        rows
          .map((row) => row.occurred_at)
          .filter((value): value is string => value != null)
          .sort((a, b) => b.localeCompare(a))[0] ?? null;
      const withConfidence = rows.filter((row) => row.confidence != null);
      const routingConfidence =
        withConfidence.length > 0
          ? withConfidence.reduce((sum, row) => sum + (row.confidence ?? 0), 0) /
            withConfidence.length
          : null;

      return {
        skill_name: skillName,
        skill_scope: scopeBySkill.get(skillName) ?? null,
        total_checks: totalChecks,
        triggered_count: triggeredCount,
        pass_rate: totalChecks > 0 ? triggeredCount / totalChecks : 0,
        unique_sessions: uniqueSessions,
        last_seen: lastSeen,
        has_evidence: evidenceSkills.has(skillName),
        routing_confidence: routingConfidence,
        confidence_coverage: totalChecks > 0 ? withConfidence.length / totalChecks : 0,
      };
    })
    .sort((a, b) => b.total_checks - a.total_checks);
}

/**
 * Build the performance analytics payload from SQLite.
 * Powers the GET /api/v2/analytics endpoint.
 */
export function getAnalyticsPayload(db: Database): AnalyticsResponse {
  // 1. Pass rate trend — last 90 days, bucketed by day
  const passRateTrendRows = db
    .query(
      `SELECT date(occurred_at) as date,
              CASE WHEN SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) = 0 THEN 0.0
                   ELSE CAST(SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
              END as pass_rate,
              COUNT(*) as total_checks
       FROM skill_invocations
       WHERE occurred_at >= date('now', '-90 days')
       GROUP BY date(occurred_at)
       ORDER BY date ASC`,
    )
    .all() as Array<{ date: string; pass_rate: number; total_checks: number }>;

  const pass_rate_trend = passRateTrendRows.map((row) => ({
    date: row.date,
    pass_rate: row.pass_rate,
    total_checks: row.total_checks,
  }));

  // 2. Skill rankings — all skills with at least 1 check, ordered by pass rate
  const skillRankingRows = db
    .query(
      `SELECT skill_name,
              CASE WHEN COUNT(*) = 0 THEN 0.0
                   ELSE CAST(SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
              END as pass_rate,
              COUNT(*) as total_checks,
              SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) as triggered_count
       FROM skill_invocations
       GROUP BY skill_name
       HAVING total_checks >= 1
       ORDER BY pass_rate DESC`,
    )
    .all() as Array<{
    skill_name: string;
    pass_rate: number;
    total_checks: number;
    triggered_count: number;
  }>;

  const skill_rankings = skillRankingRows.map((row) => ({
    skill_name: row.skill_name,
    pass_rate: row.pass_rate,
    total_checks: row.total_checks,
    triggered_count: row.triggered_count,
  }));

  // 3. Daily activity — last 84 days (12 weeks) for heatmap
  const dailyActivityRows = db
    .query(
      `SELECT date(occurred_at) as date, COUNT(*) as checks
       FROM skill_invocations
       WHERE occurred_at >= date('now', '-84 days')
       GROUP BY date(occurred_at)
       ORDER BY date ASC`,
    )
    .all() as Array<{ date: string; checks: number }>;

  const daily_activity = dailyActivityRows.map((row) => ({
    date: row.date,
    checks: row.checks,
  }));

  // 4. Evolution impact — before/after pass rates for deployed evolutions
  const deployedRows = db
    .query(
      `SELECT ea.skill_name, ea.proposal_id, ea.timestamp as deployed_at
       FROM evolution_audit ea
       WHERE ea.action = 'deployed' AND ea.skill_name IS NOT NULL
       ORDER BY ea.timestamp DESC`,
    )
    .all() as Array<{ skill_name: string; proposal_id: string; deployed_at: string }>;

  const evolution_impact: AnalyticsResponse["evolution_impact"] = [];
  for (const deploy of deployedRows) {
    const beforeRow = db
      .query(
        `SELECT CASE WHEN COUNT(*) = 0 THEN 0.0
                     ELSE CAST(SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
                END as pass_rate
         FROM skill_invocations
         WHERE skill_name = ? AND occurred_at < ?`,
      )
      .get(deploy.skill_name, deploy.deployed_at) as { pass_rate: number } | null;

    const afterRow = db
      .query(
        `SELECT CASE WHEN COUNT(*) = 0 THEN 0.0
                     ELSE CAST(SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
                END as pass_rate
         FROM skill_invocations
         WHERE skill_name = ? AND occurred_at >= ?`,
      )
      .get(deploy.skill_name, deploy.deployed_at) as { pass_rate: number } | null;

    evolution_impact.push({
      skill_name: deploy.skill_name,
      proposal_id: deploy.proposal_id,
      deployed_at: deploy.deployed_at,
      pass_rate_before: beforeRow?.pass_rate ?? 0,
      pass_rate_after: afterRow?.pass_rate ?? 0,
    });
  }

  // 5. Summary aggregates
  const totalEvolutionsRow = db
    .query(`SELECT COUNT(*) as c FROM evolution_audit WHERE action = 'deployed'`)
    .get() as { c: number } | null;

  const checks30dRow = db
    .query(
      `SELECT COUNT(*) as c FROM skill_invocations WHERE occurred_at >= date('now', '-30 days')`,
    )
    .get() as { c: number } | null;

  const activeSkillsRow = db
    .query(
      `SELECT COUNT(DISTINCT skill_name) as c
       FROM skill_invocations
       WHERE occurred_at >= date('now', '-30 days')`,
    )
    .get() as { c: number } | null;

  // Average improvement across all deployed evolutions
  let avgImprovement = 0;
  if (evolution_impact.length > 0) {
    const totalImprovement = evolution_impact.reduce(
      (sum, e) => sum + (e.pass_rate_after - e.pass_rate_before),
      0,
    );
    avgImprovement = totalImprovement / evolution_impact.length;
  }

  const summary: AnalyticsResponse["summary"] = {
    total_evolutions: totalEvolutionsRow?.c ?? 0,
    avg_improvement: avgImprovement,
    total_checks_30d: checks30dRow?.c ?? 0,
    active_skills: activeSkillsRow?.c ?? 0,
  };

  return {
    pass_rate_trend,
    skill_rankings,
    daily_activity,
    evolution_impact,
    summary,
  };
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
  // Step 1: Fetch recent invocations without JOIN (avoids materializing full JOIN before LIMIT)
  const rows = db
    .query(
      `SELECT occurred_at, session_id, skill_name, query, triggered
       FROM skill_invocations
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    occurred_at: string;
    session_id: string;
    skill_name: string;
    query: string;
    triggered: number;
  }>;

  if (rows.length === 0) return [];

  // Step 2: Batch lookup which sessions have completed (have a telemetry row)
  const uniqueSessionIds = [...new Set(rows.map((r) => r.session_id))];
  const placeholders = uniqueSessionIds.map(() => "?").join(",");
  const completedRows = db
    .query(
      `SELECT DISTINCT session_id FROM session_telemetry WHERE session_id IN (${placeholders})`,
    )
    .all(...uniqueSessionIds) as Array<{ session_id: string }>;
  const completedSessions = new Set(completedRows.map((r) => r.session_id));

  return rows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    skill_name: row.skill_name,
    query: row.query ?? "",
    triggered: row.triggered === 1,
    is_live: !completedSessions.has(row.session_id),
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

// -- Execution metrics & commit tracking queries ------------------------------

/**
 * Aggregate execution_facts enrichment columns for a set of session IDs.
 *
 * Returns file change stats, cost totals, token breakdowns, artifact counts,
 * and session_type distribution across the provided sessions.
 */
export function getExecutionMetrics(db: Database, sessionIds: string[]): ExecutionMetrics {
  const empty: ExecutionMetrics = {
    avg_files_changed: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    total_cost_usd: 0,
    avg_cost_usd: 0,
    cached_input_tokens_total: 0,
    reasoning_output_tokens_total: 0,
    artifact_count: 0,
    session_type_distribution: {},
  };
  if (sessionIds.length === 0) return empty;

  const placeholders = sessionIds.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT
         COALESCE(AVG(files_changed), 0) AS avg_files_changed,
         COALESCE(SUM(lines_added), 0) AS total_lines_added,
         COALESCE(SUM(lines_removed), 0) AS total_lines_removed,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         COALESCE(AVG(cost_usd), 0) AS avg_cost_usd,
         COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens_total,
         COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens_total,
         COALESCE(SUM(artifact_count), 0) AS artifact_count
       FROM execution_facts
       WHERE session_id IN (${placeholders})`,
    )
    .get(...sessionIds) as {
    avg_files_changed: number;
    total_lines_added: number;
    total_lines_removed: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    cached_input_tokens_total: number;
    reasoning_output_tokens_total: number;
    artifact_count: number;
  } | null;

  // Session type distribution
  const typeRows = db
    .query(
      `SELECT session_type, COUNT(*) AS count
       FROM execution_facts
       WHERE session_id IN (${placeholders}) AND session_type IS NOT NULL
       GROUP BY session_type`,
    )
    .all(...sessionIds) as Array<{ session_type: string; count: number }>;

  const session_type_distribution: Record<string, number> = {};
  for (const tr of typeRows) {
    session_type_distribution[tr.session_type] = tr.count;
  }

  return {
    avg_files_changed: row?.avg_files_changed ?? 0,
    total_lines_added: row?.total_lines_added ?? 0,
    total_lines_removed: row?.total_lines_removed ?? 0,
    total_cost_usd: row?.total_cost_usd ?? 0,
    avg_cost_usd: row?.avg_cost_usd ?? 0,
    cached_input_tokens_total: row?.cached_input_tokens_total ?? 0,
    reasoning_output_tokens_total: row?.reasoning_output_tokens_total ?? 0,
    artifact_count: row?.artifact_count ?? 0,
    session_type_distribution,
  };
}

/**
 * Get all commits tracked for a given session.
 */
export function getSessionCommits(db: Database, sessionId: string): CommitRecord[] {
  return db
    .query(
      `SELECT commit_sha, commit_title, branch, repo_remote, timestamp
       FROM commit_tracking
       WHERE session_id = ?
       ORDER BY timestamp DESC`,
    )
    .all(sessionId) as CommitRecord[];
}

/**
 * Aggregate commit stats for a skill by joining commit_tracking to skill_invocations
 * via shared session_id.
 */
export function getSkillCommitSummary(db: Database, skillName: string): CommitSummary {
  const empty: CommitSummary = {
    total_commits: 0,
    unique_branches: 0,
    recent_commits: [],
  };

  const statsRow = db
    .query(
      `WITH skill_sessions AS (
         SELECT DISTINCT session_id FROM skill_invocations WHERE skill_name = ?
       )
       SELECT
         COUNT(*) AS total_commits,
         COUNT(DISTINCT ct.branch) AS unique_branches
       FROM commit_tracking ct
       WHERE ct.session_id IN (SELECT session_id FROM skill_sessions)`,
    )
    .get(skillName) as { total_commits: number; unique_branches: number } | null;

  if (!statsRow || statsRow.total_commits === 0) return empty;

  const recentRows = db
    .query(
      `WITH skill_sessions AS (
         SELECT DISTINCT session_id FROM skill_invocations WHERE skill_name = ?
       )
       SELECT ct.commit_sha, ct.commit_title, ct.branch, ct.timestamp
       FROM commit_tracking ct
       WHERE ct.session_id IN (SELECT session_id FROM skill_sessions)
       ORDER BY ct.timestamp DESC
       LIMIT 20`,
    )
    .all(skillName) as Array<{
    commit_sha: string;
    commit_title: string | null;
    branch: string | null;
    timestamp: string;
  }>;

  return {
    total_commits: statsRow.total_commits,
    unique_branches: statsRow.unique_branches,
    recent_commits: recentRows.map((r) => ({
      sha: r.commit_sha,
      title: r.commit_title ?? "",
      branch: r.branch ?? "",
      timestamp: r.timestamp,
    })),
  };
}

// -- Helpers ------------------------------------------------------------------

// -- Autonomy-first dashboard queries -----------------------------------------

export interface SkillTrustSummary {
  skill_name: string;
  total_checks: number;
  triggered_count: number;
  miss_rate: number;
  system_like_count: number;
  system_like_rate: number;
  prompt_link_rate: number;
  latest_action: string | null;
  pass_rate: number;
  last_seen: string | null;
}

export interface TrustedSkillObservationRow {
  skill_name: string;
  session_id: string;
  occurred_at: string | null;
  triggered: number;
  matched_prompt_id: string | null;
  confidence: number | null;
  invocation_mode: string | null;
  query_text: string;
}

export function queryTrustedSkillObservationRows(db: Database): TrustedSkillObservationRow[] {
  const SYSTEM_LIKE_PREFIXES = ["<system_instruction>", "<system-instruction>", "<command-name>"];
  const INTERNAL_EVAL_MARKERS = [
    "you are an evaluation assistant",
    "you are a skill description optimizer",
    "would each query trigger this skill",
    "propose an improved description",
    "failure patterns:",
    "output only valid json",
  ];
  const isSystemLike = (text: string | null | undefined): boolean => {
    if (!text) return false;
    const trimmed = text.trimStart();
    return SYSTEM_LIKE_PREFIXES.some((p) => trimmed.startsWith(p));
  };
  const isInternalSelftunePrompt = (
    text: string | null | undefined,
    promptKind: string | null | undefined,
  ): boolean => {
    if (!text) return false;
    const lowered = text.toLowerCase();
    return (
      promptKind === "meta" && INTERNAL_EVAL_MARKERS.some((marker) => lowered.includes(marker))
    );
  };
  const isPollutingPrompt = (
    text: string | null | undefined,
    promptKind: string | null | undefined,
  ): boolean => isSystemLike(text) || isInternalSelftunePrompt(text, promptKind);
  const classifyObservationKind = (
    skillInvocationId: string,
    captureMode: string | null,
    triggered: number,
    rawSourceRefJson: string | null,
  ): "canonical" | "repaired_trigger" | "repaired_contextual_miss" | "legacy_materialized" => {
    if (skillInvocationId.includes(":su:")) return "legacy_materialized";
    if (captureMode === "repair") {
      const rawSourceRef = safeParseJson(rawSourceRefJson) as {
        metadata?: { miss_type?: string };
      } | null;
      if (triggered === 0 && rawSourceRef?.metadata?.miss_type === "contextual_read") {
        return "repaired_contextual_miss";
      }
      return "repaired_trigger";
    }
    return "canonical";
  };
  const normalizeQueryForGrouping = (query: string) =>
    query.replace(/\s+/g, " ").trim().toLowerCase();

  const rows = db
    .query(
      `SELECT
         si.skill_name,
         si.session_id,
         si.occurred_at,
         si.triggered,
         si.matched_prompt_id,
         si.confidence,
         si.invocation_mode,
         si.skill_invocation_id,
         si.capture_mode,
         si.raw_source_ref,
         si.query,
         p.prompt_text,
         p.prompt_kind
       FROM skill_invocations si
       LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id`,
    )
    .all() as Array<{
    skill_name: string;
    session_id: string;
    occurred_at: string | null;
    triggered: number;
    matched_prompt_id: string | null;
    confidence: number | null;
    invocation_mode: string | null;
    skill_invocation_id: string;
    capture_mode: string | null;
    raw_source_ref: string | null;
    query: string | null;
    prompt_text: string | null;
    prompt_kind: string | null;
  }>;

  const bySkill = new Map<
    string,
    Array<{
      skill_name: string;
      session_id: string;
      occurred_at: string | null;
      triggered: number;
      matched_prompt_id: string | null;
      confidence: number | null;
      invocation_mode: string | null;
      queryText: string;
      isPolluting: boolean;
      observation_kind:
        | "canonical"
        | "repaired_trigger"
        | "repaired_contextual_miss"
        | "legacy_materialized";
      groupKey: string;
    }>
  >();
  const trustedRows: Array<{
    skill_name: string;
    session_id: string;
    occurred_at: string | null;
    triggered: number;
    matched_prompt_id: string | null;
    confidence: number | null;
    invocation_mode: string | null;
    query_text: string;
  }> = [];

  for (const row of rows) {
    const queryText = row.query || row.prompt_text || "";
    const observation_kind = classifyObservationKind(
      row.skill_invocation_id,
      row.capture_mode,
      row.triggered,
      row.raw_source_ref,
    );
    if (isPollutingPrompt(queryText, row.prompt_kind)) continue;
    if (observation_kind === "legacy_materialized") continue;

    const normalizedQuery = normalizeQueryForGrouping(queryText);
    const groupKey =
      normalizedQuery.length > 0
        ? `${row.session_id}::${normalizedQuery}`
        : `${row.skill_invocation_id}`;
    const arr = bySkill.get(row.skill_name);
    const enriched = {
      skill_name: row.skill_name,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      triggered: row.triggered,
      matched_prompt_id: row.matched_prompt_id,
      confidence: row.confidence,
      invocation_mode: row.invocation_mode,
      queryText,
      isPolluting: false,
      observation_kind,
      groupKey,
    };
    if (arr) arr.push(enriched);
    else bySkill.set(row.skill_name, [enriched]);
  }

  for (const [, skillRows] of bySkill.entries()) {
    const grouped = new Map<string, typeof skillRows>();
    for (const row of skillRows) {
      const arr = grouped.get(row.groupKey);
      if (arr) arr.push(row);
      else grouped.set(row.groupKey, [row]);
    }

    const deduped = [...grouped.values()].map((group) => {
      const sorted = [...group].sort((a, b) => {
        const aScore =
          (a.triggered === 1 ? 100 : 0) +
          (a.observation_kind === "canonical" ? 20 : 0) +
          (a.observation_kind === "repaired_trigger" ? 15 : 0);
        const bScore =
          (b.triggered === 1 ? 100 : 0) +
          (b.observation_kind === "canonical" ? 20 : 0) +
          (b.observation_kind === "repaired_trigger" ? 15 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return (b.occurred_at ?? "").localeCompare(a.occurred_at ?? "");
      });
      return sorted[0]!;
    });

    trustedRows.push(
      ...deduped.map((row) => ({
        skill_name: row.skill_name,
        session_id: row.session_id,
        occurred_at: row.occurred_at,
        triggered: row.triggered,
        matched_prompt_id: row.matched_prompt_id,
        confidence: row.confidence,
        invocation_mode: row.invocation_mode,
        query_text: row.queryText,
      })),
    );
  }

  return trustedRows;
}

export function getSkillTrustSummaries(db: Database): SkillTrustSummary[] {
  const rows = queryTrustedSkillObservationRows(db);

  // Build latest_action map from evolution_audit
  const auditRows = db
    .query(
      `SELECT skill_name, action, timestamp
       FROM evolution_audit
       WHERE skill_name IS NOT NULL
       ORDER BY timestamp DESC`,
    )
    .all() as Array<{
    skill_name: string | null;
    action: string;
    timestamp: string;
  }>;

  const latestActions = new Map<string, string>();
  for (const row of auditRows) {
    if (row.skill_name && !latestActions.has(row.skill_name)) {
      latestActions.set(row.skill_name, row.action);
    }
  }

  const rowsBySkill = new Map<string, typeof rows>();
  for (const row of rows) {
    const arr = rowsBySkill.get(row.skill_name);
    if (arr) arr.push(row);
    else rowsBySkill.set(row.skill_name, [row]);
  }

  const summaries: SkillTrustSummary[] = [];
  for (const [skillName, skillRows] of rowsBySkill.entries()) {
    const total = skillRows.length;
    const triggered = skillRows.filter((row) => row.triggered === 1).length;
    const promptLinked = skillRows.filter((row) => row.matched_prompt_id != null).length;
    const lastSeen =
      skillRows
        .map((row) => row.occurred_at)
        .filter((value): value is string => value != null)
        .sort((a, b) => b.localeCompare(a))[0] ?? null;

    summaries.push({
      skill_name: skillName,
      total_checks: total,
      triggered_count: triggered,
      miss_rate: total > 0 ? (total - triggered) / total : 0,
      system_like_count: 0,
      system_like_rate: 0,
      prompt_link_rate: total > 0 ? promptLinked / total : 0,
      latest_action: latestActions.get(skillName) ?? null,
      pass_rate: total > 0 ? triggered / total : 0,
      last_seen: lastSeen,
    });
  }

  return summaries;
}

export function getAttentionQueue(db: Database): AttentionItem[] {
  const summaries = getSkillTrustSummaries(db);
  const pending = getPendingProposals(db);
  const pendingSkills = new Set(pending.map((p) => p.skill_name).filter(Boolean));

  const items: AttentionItem[] = [];

  for (const s of summaries) {
    if (s.total_checks < 5) continue;

    if (s.latest_action === "rolled_back") {
      items.push({
        skill_name: s.skill_name,
        category: "needs_review",
        severity: "critical",
        reason: "Rolled back after deployment",
        recommended_action: "Review rollback evidence and decide whether to re-evolve",
        timestamp: s.last_seen ?? "",
      });
      continue;
    }

    if (s.miss_rate > 0.1) {
      items.push({
        skill_name: s.skill_name,
        category: "regression",
        severity: "warning",
        reason: `High miss rate (${Math.round(s.miss_rate * 100)}%)`,
        recommended_action: "Review missed invocations and consider evolving the skill description",
        timestamp: s.last_seen ?? "",
      });
      continue;
    }

    if (s.system_like_rate > 0.1) {
      items.push({
        skill_name: s.skill_name,
        category: "polluted",
        severity: "warning",
        reason: `Possible telemetry pollution (${Math.round(s.system_like_rate * 100)}% system-like)`,
        recommended_action: "Inspect prompts for system-injected noise",
        timestamp: s.last_seen ?? "",
      });
      continue;
    }

    if (pendingSkills.has(s.skill_name)) {
      items.push({
        skill_name: s.skill_name,
        category: "needs_review",
        severity: "info",
        reason: "Proposal awaiting review",
        recommended_action: "Review and approve or reject the pending proposal",
        timestamp: s.last_seen ?? "",
      });
    }
  }

  return items;
}

export function getRecentDecisions(db: Database, limit = 20): AutonomousDecision[] {
  const rows = db
    .query(
      `SELECT timestamp, proposal_id, skill_name, action, details, eval_snapshot_json
       FROM evolution_audit
       WHERE timestamp >= datetime('now', '-7 days')
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    timestamp: string;
    proposal_id: string;
    skill_name: string | null;
    action: string;
    details: string;
    eval_snapshot_json: string | null;
  }>;

  return rows
    .filter((row) => row.skill_name != null)
    .map((row) => {
      const evalSnapshot = safeParseJson(row.eval_snapshot_json) as {
        regressions?: unknown[];
      } | null;

      let kind: DecisionKind;
      switch (row.action) {
        case "proposed":
        case "created":
          kind = "proposal_created";
          break;
        case "validated":
          kind =
            evalSnapshot?.regressions && evalSnapshot.regressions.length > 0
              ? "validation_failed"
              : "proposal_created"; // validated without regressions is still a creation step
          break;
        case "deployed":
          kind = "proposal_deployed";
          break;
        case "rolled_back":
          kind = "rollback_triggered";
          break;
        default:
          kind = "proposal_created";
          break;
      }

      return {
        timestamp: row.timestamp,
        kind,
        skill_name: row.skill_name!,
        proposal_id: row.proposal_id,
        summary: row.details ?? "",
      };
    });
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
