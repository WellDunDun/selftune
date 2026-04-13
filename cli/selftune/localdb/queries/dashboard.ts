import type { Database } from "bun:sqlite";

import type {
  AnalyticsResponse,
  OverviewPaginatedPayload,
  OverviewPayload,
  PaginatedResult,
  PaginationCursor,
  RecentActivityItem,
  SkillReportPaginatedPayload,
  SkillReportPayload,
  SkillTestingReadiness,
  SkillSummary,
  SkillUsageRecord,
  TelemetryRecord,
} from "../../dashboard-contract.js";
import { queryEvolutionEvidence, getPendingProposals } from "./evolution.js";
import { safeParseJsonArray } from "./json.js";
import { queryTrustedSkillObservationRows } from "./trust.js";
import { listSkillTestingReadiness } from "../../testing-readiness.js";
import { classifySkillPath } from "../../utils/skill-discovery.js";

function mapOverviewEvolutionEntry(row: {
  timestamp: string;
  proposal_id: string;
  skill_name: string | null;
  action: string;
  details: string;
}): OverviewPayload["evolution"][number] {
  return {
    timestamp: row.timestamp,
    proposal_id: row.proposal_id,
    skill_name: row.skill_name ?? undefined,
    action: row.action,
    details: row.details,
  };
}

function mapEvidenceEntry(
  row: ReturnType<typeof queryEvolutionEvidence>[number],
): SkillReportPayload["evidence"][number] {
  return {
    proposal_id: row.proposal_id,
    target: row.target,
    stage: row.stage,
    timestamp: row.timestamp,
    rationale: row.rationale ?? null,
    confidence: row.confidence ?? null,
    original_text: row.original_text ?? null,
    proposed_text: row.proposed_text ?? null,
    validation: row.validation ?? null,
    details: row.details ?? null,
    eval_set: row.eval_set ?? [],
  };
}

export function getOverviewPayload(db: Database): OverviewPayload {
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

  const evolutionRows = db
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
  const evolution = evolutionRows.map(mapOverviewEvolutionEntry);

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

  return {
    telemetry,
    skills,
    evolution,
    counts,
    unmatched_queries: unmatchedRows,
    pending_proposals: getPendingProposals(db),
    active_sessions: getActiveSessionCount(db),
    recent_activity: getRecentActivity(db),
  };
}

export function getSkillReportPayload(db: Database, skillName: string): SkillReportPayload {
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

  const evidence = queryEvolutionEvidence(db, skillName).map(mapEvidenceEntry);

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

export function getOverviewPayloadPaginated(
  db: Database,
  opts: OverviewPaginationOptions = {},
): OverviewPaginatedPayload {
  const telemetryLimit = opts.telemetry_limit ?? 1000;
  const skillsLimit = opts.skills_limit ?? 2000;

  const telemetry_page = paginateTelemetry(db, telemetryLimit, opts.telemetry_cursor ?? null);
  const skills_page = paginateSkillInvocations(db, skillsLimit, opts.skills_cursor ?? null);

  const evolutionRows = db
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
  const evolution = evolutionRows.map(mapOverviewEvolutionEntry);

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

  return {
    telemetry_page,
    skills_page,
    evolution,
    counts,
    unmatched_queries: unmatchedRows,
    pending_proposals: getPendingProposals(db),
    active_sessions: getActiveSessionCount(db),
    recent_activity: getRecentActivity(db),
  };
}

export function getSkillReportPayloadPaginated(
  db: Database,
  skillName: string,
  opts: SkillReportPaginationOptions = {},
): SkillReportPaginatedPayload {
  const invocationsLimit = opts.invocations_limit ?? 100;
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

  const invocations_page = paginateSkillReportInvocations(
    db,
    skillName,
    invocationsLimit,
    opts.invocations_cursor ?? null,
  );
  const evidence = queryEvolutionEvidence(db, skillName).map(mapEvidenceEntry);

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

function paginateTelemetry(
  db: Database,
  limit: number,
  cursor: PaginationCursor | null,
): PaginatedResult<TelemetryRecord> {
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

export function getSkillsList(
  db: Database,
  testingReadinessRows?: SkillTestingReadiness[],
): SkillSummary[] {
  const trustedRows = queryTrustedSkillObservationRows(db);
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
    const base = {
      skill_name: row.skill_name,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      triggered: row.triggered,
      matched_prompt_id: row.matched_prompt_id,
      confidence: row.confidence,
    };
    const existing = bySkill.get(row.skill_name);
    if (existing) existing.push(base);
    else bySkill.set(row.skill_name, [base]);
  }

  const evidenceSkills = new Set(
    (
      db.query(`SELECT DISTINCT skill_name FROM evolution_evidence`).all() as Array<{
        skill_name: string;
      }>
    ).map((row) => row.skill_name),
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
  const testingReadiness = testingReadinessRows ?? listSkillTestingReadiness(db);
  const testingReadinessBySkill = new Map(
    testingReadiness.map((row) => [row.skill_name, row] as const),
  );
  const knownSkills = new Set<string>(bySkill.keys());

  return [...knownSkills]
    .map((skillName) => {
      const rows = bySkill.get(skillName) ?? [];
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
      const readiness = testingReadinessBySkill.get(skillName);
      const fallbackScope =
        readiness?.skill_path != null ? classifySkillPath(readiness.skill_path).skill_scope : null;

      return {
        skill_name: skillName,
        skill_scope:
          scopeBySkill.get(skillName) ??
          (fallbackScope && fallbackScope !== "unknown" ? fallbackScope : null),
        total_checks: totalChecks,
        triggered_count: triggeredCount,
        pass_rate: totalChecks > 0 ? triggeredCount / totalChecks : 0,
        unique_sessions: uniqueSessions,
        last_seen: lastSeen,
        has_evidence: evidenceSkills.has(skillName),
        routing_confidence: routingConfidence,
        confidence_coverage: totalChecks > 0 ? withConfidence.length / totalChecks : 0,
        testing_readiness: readiness,
      };
    })
    .sort(
      (a, b) =>
        b.total_checks - a.total_checks ||
        (b.last_seen ?? "").localeCompare(a.last_seen ?? "") ||
        a.skill_name.localeCompare(b.skill_name),
    );
}

export function getAnalyticsPayload(db: Database): AnalyticsResponse {
  const trustedRows = queryTrustedSkillObservationRows(db);
  const today = new Date();
  const dateKey = (value: string | null): string | null => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  };
  const cutoffDate = (days: number): string => {
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    return cutoff.toISOString().slice(0, 10);
  };

  const passRateTrendByDate = new Map<string, { triggered: number; total: number }>();
  for (const row of trustedRows) {
    const occurredDate = dateKey(row.occurred_at);
    if (!occurredDate || occurredDate < cutoffDate(90)) continue;
    const counts = passRateTrendByDate.get(occurredDate) ?? { triggered: 0, total: 0 };
    counts.total += 1;
    if (row.triggered === 1) counts.triggered += 1;
    passRateTrendByDate.set(occurredDate, counts);
  }
  const passRateTrendRows = [...passRateTrendByDate.entries()]
    .map(([date, counts]) => ({
      date,
      pass_rate: counts.total > 0 ? counts.triggered / counts.total : 0,
      total_checks: counts.total,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const skillRankingMap = new Map<string, { triggered_count: number; total_checks: number }>();
  for (const row of trustedRows) {
    const counts = skillRankingMap.get(row.skill_name) ?? { triggered_count: 0, total_checks: 0 };
    counts.total_checks += 1;
    if (row.triggered === 1) counts.triggered_count += 1;
    skillRankingMap.set(row.skill_name, counts);
  }
  const skillRankingRows = [...skillRankingMap.entries()]
    .map(([skill_name, counts]) => ({
      skill_name,
      pass_rate: counts.total_checks > 0 ? counts.triggered_count / counts.total_checks : 0,
      total_checks: counts.total_checks,
      triggered_count: counts.triggered_count,
    }))
    .sort(
      (a, b) =>
        b.pass_rate - a.pass_rate ||
        b.total_checks - a.total_checks ||
        a.skill_name.localeCompare(b.skill_name),
    );

  const dailyActivityByDate = new Map<string, number>();
  for (const row of trustedRows) {
    const occurredDate = dateKey(row.occurred_at);
    if (!occurredDate || occurredDate < cutoffDate(84)) continue;
    dailyActivityByDate.set(occurredDate, (dailyActivityByDate.get(occurredDate) ?? 0) + 1);
  }
  const dailyActivityRows = [...dailyActivityByDate.entries()]
    .map(([date, checks]) => ({ date, checks }))
    .sort((a, b) => a.date.localeCompare(b.date));

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
    const beforeRows = trustedRows.filter(
      (row) => row.skill_name === deploy.skill_name && (row.occurred_at ?? "") < deploy.deployed_at,
    );
    const afterRows = trustedRows.filter(
      (row) =>
        row.skill_name === deploy.skill_name && (row.occurred_at ?? "") >= deploy.deployed_at,
    );

    evolution_impact.push({
      skill_name: deploy.skill_name,
      proposal_id: deploy.proposal_id,
      deployed_at: deploy.deployed_at,
      pass_rate_before:
        beforeRows.length > 0
          ? beforeRows.filter((row) => row.triggered === 1).length / beforeRows.length
          : 0,
      pass_rate_after:
        afterRows.length > 0
          ? afterRows.filter((row) => row.triggered === 1).length / afterRows.length
          : 0,
    });
  }

  const totalEvolutionsRow = db
    .query(`SELECT COUNT(*) as c FROM evolution_audit WHERE action = 'deployed'`)
    .get() as { c: number } | null;
  const checks30dRows = trustedRows.filter((row) => {
    const occurredDate = dateKey(row.occurred_at);
    return occurredDate != null && occurredDate >= cutoffDate(30);
  });
  const activeSkills30d = new Set(checks30dRows.map((row) => row.skill_name));

  let avgImprovement = 0;
  if (evolution_impact.length > 0) {
    const totalImprovement = evolution_impact.reduce(
      (sum, impact) => sum + (impact.pass_rate_after - impact.pass_rate_before),
      0,
    );
    avgImprovement = totalImprovement / evolution_impact.length;
  }

  return {
    pass_rate_trend: passRateTrendRows.map((row) => ({
      date: row.date,
      pass_rate: row.pass_rate,
      total_checks: row.total_checks,
    })),
    skill_rankings: skillRankingRows.map((row) => ({
      skill_name: row.skill_name,
      pass_rate: row.pass_rate,
      total_checks: row.total_checks,
      triggered_count: row.triggered_count,
    })),
    daily_activity: dailyActivityRows.map((row) => ({
      date: row.date,
      checks: row.checks,
    })),
    evolution_impact,
    summary: {
      total_evolutions: totalEvolutionsRow?.c ?? 0,
      avg_improvement: avgImprovement,
      total_checks_30d: checks30dRows.length,
      active_skills: activeSkills30d.size,
    },
  };
}

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

export function getRecentActivity(db: Database, limit = 20): RecentActivityItem[] {
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

  const uniqueSessionIds = [...new Set(rows.map((row) => row.session_id))];
  const placeholders = uniqueSessionIds.map(() => "?").join(",");
  const completedRows = db
    .query(
      `SELECT DISTINCT session_id FROM session_telemetry WHERE session_id IN (${placeholders})`,
    )
    .all(...uniqueSessionIds) as Array<{ session_id: string }>;
  const completedSessions = new Set(completedRows.map((row) => row.session_id));

  return rows.map((row) => ({
    timestamp: row.occurred_at,
    session_id: row.session_id,
    skill_name: row.skill_name,
    query: row.query ?? "",
    triggered: row.triggered === 1,
    is_live: !completedSessions.has(row.session_id),
  }));
}
