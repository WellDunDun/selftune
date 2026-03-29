/**
 * Route handler: GET /api/v2/skills/:name
 *
 * Returns SQLite-backed per-skill report with evolution audit, undeployed proposals,
 * invocation details, duration stats, selftune resource usage, prompt samples,
 * and session metadata.
 */

import type { Database } from "bun:sqlite";

import { parseCursorParam } from "../dashboard-contract.js";
import { scoreDescription } from "../evolution/description-quality.js";
import {
  getExecutionMetrics,
  getPendingProposals,
  getSkillCommitSummary,
  getSkillReportPayload,
  safeParseJson,
} from "../localdb/queries.js";

export function handleSkillReport(
  db: Database,
  skillName: string,
  searchParams?: URLSearchParams,
): Response {
  const report = getSkillReportPayload(db, skillName);

  // 1. Evolution audit with eval_snapshot
  const evolution = db
    .query(
      `SELECT timestamp, proposal_id, skill_name, action, details, eval_snapshot_json
       FROM evolution_audit
       WHERE skill_name = ? OR (skill_name IS NULL AND proposal_id LIKE 'evo-' || ? || '-%')
       ORDER BY timestamp DESC
       LIMIT 100`,
    )
    .all(skillName, skillName) as Array<{
    timestamp: string;
    proposal_id: string;
    skill_name: string | null;
    action: string;
    details: string;
    eval_snapshot_json: string | null;
  }>;
  const evolutionWithSnapshot = evolution.map((e) => ({
    ...e,
    eval_snapshot: e.eval_snapshot_json ? safeParseJson(e.eval_snapshot_json) : null,
    eval_snapshot_json: undefined,
  }));

  // 2. Pending proposals (shared helper from queries.ts)
  const pending_proposals = getPendingProposals(db, skillName);

  // CTE subquery for session IDs — avoids expanding bind parameters
  const skillSessionsCte = `
    WITH skill_sessions AS (
      SELECT DISTINCT session_id FROM skill_invocations WHERE skill_name = ?
    )`;

  // 3. Selftune resource usage from orchestrate runs that touched this skill
  const orchestrateRows = db
    .query(
      `SELECT skill_actions_json FROM orchestrate_runs
       WHERE skill_actions_json LIKE ? ESCAPE '\\'`,
    )
    .all(
      `%${skillName.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`,
    ) as Array<{
    skill_actions_json: string;
  }>;

  let totalLlmCalls = 0;
  let totalSelftunElapsedMs = 0;
  let selftuneRunCount = 0;
  for (const row of orchestrateRows) {
    try {
      const actions = JSON.parse(row.skill_actions_json) as Array<{
        skill: string;
        action?: string;
        elapsed_ms?: number;
        llm_calls?: number;
      }>;
      for (const a of actions) {
        if (a.skill !== skillName || a.action === "skip" || a.action === "watch") continue;
        if (a.elapsed_ms === undefined && a.llm_calls === undefined) continue;
        totalSelftunElapsedMs += a.elapsed_ms ?? 0;
        totalLlmCalls += a.llm_calls ?? 0;
        selftuneRunCount++;
      }
    } catch {
      // skip malformed JSON
    }
  }
  const selftuneStats = {
    total_llm_calls: totalLlmCalls,
    total_elapsed_ms: totalSelftunElapsedMs,
    avg_elapsed_ms: selftuneRunCount > 0 ? totalSelftunElapsedMs / selftuneRunCount : 0,
    run_count: selftuneRunCount,
  };

  // 4. Skill invocations — single source of truth (with optional cursor pagination)
  // JOIN prompts to recover query text when si.query is null (canonical records
  // don't carry query; it's only populated via the direct-write hook path).
  const invCursor = parseCursorParam(searchParams?.get("invocations_cursor") ?? null);
  const invLimitParam = searchParams?.get("invocations_limit");
  const invLimit = invLimitParam
    ? Math.max(1, Math.min(Number.parseInt(invLimitParam, 10) || 100, 10000))
    : 100;
  const invFetchLimit = invLimit + 1;

  let invocationsWithConfidence: Array<{
    timestamp: string;
    session_id: string;
    skill_name: string;
    invocation_mode: string | null;
    triggered: number;
    confidence: number | null;
    tool_name: string | null;
    agent_type: string | null;
    query: string | null;
    source: string | null;
    skill_invocation_id: string;
  }>;

  if (invCursor) {
    invocationsWithConfidence = db
      .query(
        `SELECT si.occurred_at as timestamp, si.session_id, si.skill_name,
                si.invocation_mode, si.triggered, si.confidence, si.tool_name,
                si.agent_type, COALESCE(si.query, p.prompt_text) as query, si.source,
                si.skill_invocation_id
         FROM skill_invocations si
         LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id
         WHERE si.skill_name = ?
           AND (si.occurred_at < ? OR (si.occurred_at = ? AND si.skill_invocation_id < ?))
         ORDER BY si.occurred_at DESC, si.skill_invocation_id DESC
         LIMIT ?`,
      )
      .all(
        skillName,
        invCursor.timestamp,
        invCursor.timestamp,
        String(invCursor.id),
        invFetchLimit,
      ) as typeof invocationsWithConfidence;
  } else {
    invocationsWithConfidence = db
      .query(
        `SELECT si.occurred_at as timestamp, si.session_id, si.skill_name,
                si.invocation_mode, si.triggered, si.confidence, si.tool_name,
                si.agent_type, COALESCE(si.query, p.prompt_text) as query, si.source,
                si.skill_invocation_id
         FROM skill_invocations si
         LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id
         WHERE si.skill_name = ?
         ORDER BY si.occurred_at DESC, si.skill_invocation_id DESC
         LIMIT ?`,
      )
      .all(skillName, invFetchLimit) as typeof invocationsWithConfidence;
  }

  const invHasMore = invocationsWithConfidence.length > invLimit;
  const invPageRows = invHasMore
    ? invocationsWithConfidence.slice(0, invLimit)
    : invocationsWithConfidence;
  const invLastRow = invPageRows[invPageRows.length - 1];
  const invNextCursor =
    invHasMore && invLastRow
      ? { timestamp: invLastRow.timestamp, id: invLastRow.skill_invocation_id }
      : null;

  // Not-found check — after all enrichment queries so evidence-only skills aren't 404'd
  const hasData =
    report.usage.total_checks > 0 ||
    report.recent_invocations.length > 0 ||
    report.evidence.length > 0 ||
    evolution.length > 0 ||
    pending_proposals.length > 0 ||
    invPageRows.length > 0;
  if (!hasData) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  // 5. Duration stats from execution_facts + missed trigger count
  const executionRow = db
    .query(
      `${skillSessionsCte}
       SELECT
         COALESCE(AVG(ef.duration_ms), 0) AS avg_duration_ms,
         COALESCE(SUM(ef.duration_ms), 0) AS total_duration_ms,
         COUNT(ef.duration_ms) AS execution_count,
         COALESCE(SUM(ef.input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(ef.output_tokens), 0) AS total_output_tokens
       FROM execution_facts ef
       WHERE ef.session_id IN (SELECT session_id FROM skill_sessions)`,
    )
    .get(skillName) as {
    avg_duration_ms: number;
    total_duration_ms: number;
    execution_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
  } | null;

  // Missed triggers: checks where the skill was evaluated but did not fire
  const missedRow = db
    .query(
      `SELECT COUNT(*) AS missed_triggers
       FROM skill_invocations
       WHERE skill_name = ? AND triggered = 0`,
    )
    .get(skillName) as { missed_triggers: number } | null;

  // 5b. Execution metrics (enrichment columns from execution_facts)
  const skillSessionIds = db
    .query(`SELECT DISTINCT session_id FROM skill_invocations WHERE skill_name = ?`)
    .all(skillName) as Array<{ session_id: string }>;
  const executionMetrics = getExecutionMetrics(
    db,
    skillSessionIds.map((r) => r.session_id),
  );

  // 5c. Commit summary (from commit_tracking via session join)
  const commitSummary = getSkillCommitSummary(db, skillName);

  // 6. Prompt texts — prefer matched prompts (the prompt that invoked the skill),
  //    fall back to all prompts from sessions that used the skill.
  const promptSamples = db
    .query(
      `${skillSessionsCte}
       SELECT p.prompt_text, p.prompt_kind, p.is_actionable, p.occurred_at, p.session_id,
              CASE WHEN si.matched_prompt_id IS NOT NULL THEN 1 ELSE 0 END AS is_matched
       FROM prompts p
       LEFT JOIN skill_invocations si ON si.matched_prompt_id = p.prompt_id
         AND si.skill_name = ?
       WHERE p.session_id IN (SELECT session_id FROM skill_sessions)
         AND p.prompt_text IS NOT NULL
         AND p.prompt_text != ''
       ORDER BY is_matched DESC, p.occurred_at DESC
       LIMIT 50`,
    )
    .all(skillName, skillName) as Array<{
    prompt_text: string;
    prompt_kind: string | null;
    is_actionable: number;
    occurred_at: string;
    session_id: string;
    is_matched: number;
  }>;

  // 7. Session metadata for sessions that used this skill
  const sessionMeta = db
    .query(
      `${skillSessionsCte}
       SELECT s.session_id, s.platform, s.model, s.agent_cli, s.branch,
              s.workspace_path, s.started_at, s.ended_at, s.completion_status
       FROM sessions s
       WHERE s.session_id IN (SELECT session_id FROM skill_sessions)
       ORDER BY s.started_at DESC
       LIMIT 50`,
    )
    .all(skillName) as Array<{
    session_id: string;
    platform: string | null;
    model: string | null;
    agent_cli: string | null;
    branch: string | null;
    workspace_path: string | null;
    started_at: string | null;
    ended_at: string | null;
    completion_status: string | null;
  }>;

  // 8. Description quality score — computed from latest evolution evidence
  const latestEvidence = db
    .query(
      `SELECT proposed_text, original_text FROM evolution_evidence
       WHERE skill_name = ? AND (proposed_text IS NOT NULL OR original_text IS NOT NULL)
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(skillName) as { proposed_text: string | null; original_text: string | null } | null;

  // Use the most recent description: deployed proposed_text, or fallback to original_text
  const currentDescriptionText = latestEvidence?.proposed_text ?? latestEvidence?.original_text;
  const descriptionQuality = currentDescriptionText
    ? scoreDescription(currentDescriptionText, skillName)
    : null;

  return Response.json({
    ...report,
    evolution: evolutionWithSnapshot,
    pending_proposals,
    token_usage: {
      total_input_tokens: executionRow?.total_input_tokens ?? 0,
      total_output_tokens: executionRow?.total_output_tokens ?? 0,
    },
    canonical_invocations: invPageRows.map((i) => ({
      ...i,
      triggered: i.triggered === 1,
    })),
    invocations_pagination:
      invNextCursor || invCursor ? { next_cursor: invNextCursor, has_more: invHasMore } : undefined,
    duration_stats: {
      avg_duration_ms: executionRow?.avg_duration_ms ?? 0,
      total_duration_ms: executionRow?.total_duration_ms ?? 0,
      execution_count: executionRow?.execution_count ?? 0,
      missed_triggers: missedRow?.missed_triggers ?? 0,
    },
    execution_metrics: executionMetrics,
    commit_summary: commitSummary.total_commits > 0 ? commitSummary : null,
    selftune_stats: selftuneStats,
    prompt_samples: promptSamples.map((p) => ({
      ...p,
      is_actionable: p.is_actionable === 1,
    })),
    session_metadata: sessionMeta,
    description_quality: descriptionQuality,
  });
}
