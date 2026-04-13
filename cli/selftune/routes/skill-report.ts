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
import { getSkillTestingReadiness } from "../testing-readiness.js";

export function handleSkillReport(
  db: Database,
  skillName: string,
  searchParams?: URLSearchParams,
): Response {
  const report = getSkillReportPayload(db, skillName);
  const testing_readiness = getSkillTestingReadiness(db, skillName);

  // 1. Evolution audit with eval_snapshot
  const evolution = db
    .query(
      `SELECT timestamp, proposal_id, skill_name, action, details, eval_snapshot_json,
              validation_mode, validation_agent, validation_fixture_id, validation_evidence_ref
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
    validation_mode: string | null;
    validation_agent: string | null;
    validation_fixture_id: string | null;
    validation_evidence_ref: string | null;
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
    capture_mode: string | null;
    raw_source_ref: string | null;
  }>;

  if (invCursor) {
    invocationsWithConfidence = db
      .query(
        `SELECT si.occurred_at as timestamp, si.session_id, si.skill_name,
                si.invocation_mode, si.triggered, si.confidence, si.tool_name,
                si.agent_type, COALESCE(si.query, p.prompt_text) as query, si.source,
                si.skill_invocation_id, si.capture_mode, si.raw_source_ref
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
                si.skill_invocation_id, si.capture_mode, si.raw_source_ref
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

  // Not-found check — after all enrichment queries so evidence-only skills aren't 404'd
  const hasData =
    report.usage.total_checks > 0 ||
    report.recent_invocations.length > 0 ||
    report.evidence.length > 0 ||
    evolution.length > 0 ||
    pending_proposals.length > 0 ||
    invPageRows.length > 0 ||
    Boolean(
      testing_readiness?.skill_path ||
      testing_readiness?.eval_set_entries ||
      testing_readiness?.unit_test_cases ||
      testing_readiness?.replay_check_count ||
      testing_readiness?.baseline_sample_size,
    );
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

  // ── Trust field computation ──────────────────────────────────────────────

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

  // Fetch all invocations for this skill with joined prompt + session data
  const allInvocations = db
    .query(
      `SELECT si.occurred_at AS timestamp, si.session_id, si.skill_name,
              si.invocation_mode, si.triggered, si.confidence, si.tool_name,
              si.agent_type, si.query AS inline_query, si.source,
              si.matched_prompt_id, si.skill_scope, si.skill_path,
              si.skill_invocation_id, si.capture_mode, si.raw_source_ref,
              p.prompt_text, p.prompt_kind,
              s.platform, s.workspace_path
       FROM skill_invocations si
       LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id
       LEFT JOIN sessions s ON si.session_id = s.session_id
       WHERE si.skill_name = ?
       ORDER BY si.occurred_at DESC`,
    )
    .all(skillName) as Array<{
    timestamp: string | null;
    session_id: string;
    skill_name: string;
    invocation_mode: string | null;
    triggered: number;
    confidence: number | null;
    tool_name: string | null;
    agent_type: string | null;
    inline_query: string | null;
    source: string | null;
    matched_prompt_id: string | null;
    skill_scope: string | null;
    skill_path: string | null;
    skill_invocation_id: string;
    capture_mode: string | null;
    raw_source_ref: string | null;
    prompt_text: string | null;
    prompt_kind: string | null;
    platform: string | null;
    workspace_path: string | null;
  }>;

  const totalInv = allInvocations.length;
  const safeDiv = (num: number, den: number): number => (den > 0 ? num / den : 0);

  // Coverage
  const distinctSessions = new Set(allInvocations.map((r) => r.session_id));
  const distinctWorkspaces = new Set(allInvocations.map((r) => r.workspace_path).filter(Boolean));
  const allTimestamps = allInvocations
    .map((r) => r.timestamp)
    .filter((t): t is string => t != null);
  const coverage = {
    checks: report.usage.total_checks,
    sessions: distinctSessions.size,
    workspaces: distinctWorkspaces.size,
    first_seen: allTimestamps.length > 0 ? allTimestamps[allTimestamps.length - 1] : null,
    last_seen: allTimestamps.length > 0 ? allTimestamps[0] : null,
  };

  // Evidence quality
  let promptLinked = 0;
  let inlineQueryCount = 0;
  let userPromptCount = 0;
  let metaPromptCount = 0;
  let internalPromptCount = 0;
  let noPromptCount = 0;
  let systemLikeCount = 0;
  let invModeCount = 0;
  let confCount = 0;
  let sourceCount = 0;
  let scopeCount = 0;

  for (const inv of allInvocations) {
    const queryText = inv.inline_query || inv.prompt_text || "";
    if (inv.matched_prompt_id != null) promptLinked++;
    if (inv.inline_query != null && inv.inline_query !== "") inlineQueryCount++;
    if (inv.prompt_kind === "user") userPromptCount++;
    if (inv.prompt_kind === "meta") metaPromptCount++;
    if (isInternalSelftunePrompt(queryText, inv.prompt_kind)) internalPromptCount++;
    if (inv.matched_prompt_id == null && (inv.inline_query == null || inv.inline_query === ""))
      noPromptCount++;
    if (isPollutingPrompt(queryText, inv.prompt_kind)) systemLikeCount++;
    if (inv.invocation_mode != null && inv.invocation_mode !== "") invModeCount++;
    if (inv.confidence != null) confCount++;
    if (inv.source != null && inv.source !== "") sourceCount++;
    if (inv.skill_scope != null && inv.skill_scope !== "") scopeCount++;
  }

  const evidence_quality = {
    prompt_link_rate: safeDiv(promptLinked, totalInv),
    inline_query_rate: safeDiv(inlineQueryCount, totalInv),
    user_prompt_rate: safeDiv(userPromptCount, totalInv),
    meta_prompt_rate: safeDiv(metaPromptCount, totalInv),
    internal_prompt_rate: safeDiv(internalPromptCount, totalInv),
    no_prompt_rate: safeDiv(noPromptCount, totalInv),
    system_like_rate: safeDiv(systemLikeCount, totalInv),
    invocation_mode_coverage: safeDiv(invModeCount, totalInv),
    confidence_coverage: safeDiv(confCount, totalInv),
    source_coverage: safeDiv(sourceCount, totalInv),
    scope_coverage: safeDiv(scopeCount, totalInv),
  };

  // Routing quality
  const missedTriggers = allInvocations.filter((r) => r.triggered === 0).length;
  const withConfidence = allInvocations.filter((r) => r.confidence != null);
  const avgConfidence =
    withConfidence.length > 0
      ? withConfidence.reduce((s, r) => s + (r.confidence ?? 0), 0) / withConfidence.length
      : null;
  const lowConfCount = withConfidence.filter((r) => (r.confidence ?? 0) < 0.5).length;

  const routing_quality = {
    missed_triggers: missedTriggers,
    miss_rate: safeDiv(missedTriggers, totalInv),
    avg_confidence: avgConfidence,
    confidence_coverage: safeDiv(confCount, totalInv),
    low_confidence_rate:
      withConfidence.length > 0 ? safeDiv(lowConfCount, withConfidence.length) : null,
  };

  // Evolution state
  const evidenceCountRow = db
    .query(`SELECT COUNT(*) AS cnt FROM evolution_evidence WHERE skill_name = ?`)
    .get(skillName) as { cnt: number } | null;
  const evolutionCountRow = db
    .query(
      `SELECT COUNT(*) AS cnt FROM evolution_audit
       WHERE skill_name = ? OR (skill_name IS NULL AND proposal_id LIKE 'evo-' || ? || '-%')`,
    )
    .get(skillName, skillName) as { cnt: number } | null;
  const latestAuditRow = db
    .query(
      `SELECT action, timestamp FROM evolution_audit
       WHERE (skill_name = ? OR (skill_name IS NULL AND proposal_id LIKE 'evo-' || ? || '-%'))
         AND action IN ('deployed', 'rolled_back', 'validated', 'proposed', 'approved')
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(skillName, skillName) as { action: string; timestamp: string } | null;

  const evolution_state = {
    has_evidence: (evidenceCountRow?.cnt ?? 0) > 0,
    has_pending_proposals: pending_proposals.length > 0,
    latest_action: latestAuditRow?.action ?? null,
    latest_timestamp: latestAuditRow?.timestamp ?? null,
    evidence_rows: evidenceCountRow?.cnt ?? 0,
    evolution_rows: evolutionCountRow?.cnt ?? 0,
  };

  // Data hygiene
  const namingVariants = db
    .query(`SELECT DISTINCT skill_name FROM skill_invocations WHERE lower(skill_name) = lower(?)`)
    .all(skillName) as Array<{ skill_name: string }>;

  const sourceBreakdown = db
    .query(
      `SELECT COALESCE(source, '(null)') AS source, COUNT(*) AS count
       FROM skill_invocations WHERE skill_name = ?
       GROUP BY source ORDER BY count DESC`,
    )
    .all(skillName) as Array<{ source: string; count: number }>;

  const promptKindBreakdown = db
    .query(
      `SELECT COALESCE(p.prompt_kind, '(null)') AS kind, COUNT(*) AS count
       FROM skill_invocations si
       LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id
       WHERE si.skill_name = ?
       GROUP BY p.prompt_kind ORDER BY count DESC`,
    )
    .all(skillName) as Array<{ kind: string; count: number }>;

  const observationBreakdownMap = new Map<
    "canonical" | "repaired_trigger" | "repaired_contextual_miss" | "legacy_materialized",
    number
  >();
  const enrichedInvocations = allInvocations.map((inv) => {
    const queryText = inv.inline_query || inv.prompt_text || "";
    const isPolluting = isPollutingPrompt(queryText, inv.prompt_kind);
    const observation_kind = classifyObservationKind(
      inv.skill_invocation_id,
      inv.capture_mode,
      inv.triggered,
      inv.raw_source_ref,
    );
    return {
      ...inv,
      queryText,
      isPolluting,
      observation_kind,
    };
  });

  for (const inv of enrichedInvocations) {
    observationBreakdownMap.set(
      inv.observation_kind,
      (observationBreakdownMap.get(inv.observation_kind) ?? 0) + 1,
    );
  }

  const trustInvocationsRaw = enrichedInvocations.filter(
    (inv) => inv.observation_kind !== "legacy_materialized",
  );

  const normalizeQueryForGrouping = (query: string) =>
    query.replace(/\s+/g, " ").trim().toLowerCase();

  const dedupeTrustInvocations = <T extends (typeof trustInvocationsRaw)[number]>(rows: T[]) => {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      const normalizedQuery = normalizeQueryForGrouping(row.queryText);
      const key =
        normalizedQuery.length > 0
          ? `${row.session_id}::${normalizedQuery}`
          : `${row.skill_invocation_id}`;
      const arr = grouped.get(key);
      if (arr) arr.push(row);
      else grouped.set(key, [row]);
    }

    return [...grouped.values()]
      .map((group) => {
        const sorted = [...group].sort((a, b) => {
          const aScore =
            (a.triggered === 1 ? 100 : 0) +
            (a.observation_kind === "canonical" ? 20 : 0) +
            (a.observation_kind === "repaired_trigger" ? 15 : 0) +
            (a.confidence != null ? 5 : 0);
          const bScore =
            (b.triggered === 1 ? 100 : 0) +
            (b.observation_kind === "canonical" ? 20 : 0) +
            (b.observation_kind === "repaired_trigger" ? 15 : 0) +
            (b.confidence != null ? 5 : 0);
          if (aScore !== bScore) return bScore - aScore;
          return (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
        });
        const primary = sorted[0]!;
        return {
          ...primary,
          historical_context:
            primary.triggered === 1 && group.some((row) => row.triggered === 0)
              ? ("previously_missed" as const)
              : null,
        };
      })
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  };

  const trustInvocations = dedupeTrustInvocations(trustInvocationsRaw);

  const trustTotalInv = trustInvocations.length;
  const trustDistinctSessions = new Set(trustInvocations.map((r) => r.session_id));
  const trustDistinctWorkspaces = new Set(
    trustInvocations.map((r) => r.workspace_path).filter(Boolean),
  );
  const trustTimestamps = trustInvocations
    .map((r) => r.timestamp)
    .filter((t): t is string => t != null);

  const legacyRows = enrichedInvocations.filter(
    (inv) => inv.observation_kind === "legacy_materialized",
  ).length;
  const repairedRows = enrichedInvocations.filter(
    (inv) =>
      inv.observation_kind === "repaired_trigger" ||
      inv.observation_kind === "repaired_contextual_miss",
  ).length;

  const data_hygiene = {
    naming_variants: namingVariants.map((r) => r.skill_name),
    source_breakdown: sourceBreakdown,
    prompt_kind_breakdown: promptKindBreakdown,
    observation_breakdown: [...observationBreakdownMap.entries()].map(([kind, count]) => ({
      kind,
      count,
    })),
    raw_checks: totalInv,
    operational_checks: trustTotalInv,
    internal_prompt_rows: internalPromptCount,
    internal_prompt_rate: safeDiv(internalPromptCount, totalInv),
    legacy_rows: legacyRows,
    legacy_rate: safeDiv(legacyRows, totalInv),
    repaired_rows: repairedRows,
    repaired_rate: safeDiv(repairedRows, totalInv),
  };

  // Recompute trust-facing metrics from operational non-legacy observations.
  const trustPromptLinked = trustInvocations.filter((inv) => inv.matched_prompt_id != null).length;
  const trustInlineQueryCount = trustInvocations.filter(
    (inv) => inv.inline_query != null && inv.inline_query !== "",
  ).length;
  const trustUserPromptCount = trustInvocations.filter((inv) => inv.prompt_kind === "user").length;
  const trustMetaPromptCount = trustInvocations.filter((inv) => inv.prompt_kind === "meta").length;
  const trustNoPromptCount = trustInvocations.filter(
    (inv) => inv.matched_prompt_id == null && (inv.inline_query == null || inv.inline_query === ""),
  ).length;
  const trustSystemLikeCount = trustInvocations.filter((inv) => inv.isPolluting).length;
  const trustInvModeCount = trustInvocations.filter(
    (inv) => inv.invocation_mode != null && inv.invocation_mode !== "",
  ).length;
  const trustConfCount = trustInvocations.filter((inv) => inv.confidence != null).length;
  const trustSourceCount = trustInvocations.filter(
    (inv) => inv.source != null && inv.source !== "",
  ).length;
  const trustScopeCount = trustInvocations.filter(
    (inv) => inv.skill_scope != null && inv.skill_scope !== "",
  ).length;

  coverage.checks = trustTotalInv;
  coverage.sessions = trustDistinctSessions.size;
  coverage.workspaces = trustDistinctWorkspaces.size;
  coverage.first_seen =
    trustTimestamps.length > 0 ? trustTimestamps[trustTimestamps.length - 1] : null;
  coverage.last_seen = trustTimestamps.length > 0 ? trustTimestamps[0] : null;

  evidence_quality.prompt_link_rate = safeDiv(trustPromptLinked, trustTotalInv);
  evidence_quality.inline_query_rate = safeDiv(trustInlineQueryCount, trustTotalInv);
  evidence_quality.user_prompt_rate = safeDiv(trustUserPromptCount, trustTotalInv);
  evidence_quality.meta_prompt_rate = safeDiv(trustMetaPromptCount, trustTotalInv);
  evidence_quality.no_prompt_rate = safeDiv(trustNoPromptCount, trustTotalInv);
  evidence_quality.system_like_rate = safeDiv(trustSystemLikeCount, trustTotalInv);
  evidence_quality.invocation_mode_coverage = safeDiv(trustInvModeCount, trustTotalInv);
  evidence_quality.confidence_coverage = safeDiv(trustConfCount, trustTotalInv);
  evidence_quality.source_coverage = safeDiv(trustSourceCount, trustTotalInv);
  evidence_quality.scope_coverage = safeDiv(trustScopeCount, trustTotalInv);

  const trustMissedTriggers = trustInvocations.filter((r) => r.triggered === 0).length;
  const trustWithConfidence = trustInvocations.filter((r) => r.confidence != null);
  const trustAvgConfidence =
    trustWithConfidence.length > 0
      ? trustWithConfidence.reduce((s, r) => s + (r.confidence ?? 0), 0) /
        trustWithConfidence.length
      : null;
  const trustLowConfCount = trustWithConfidence.filter((r) => (r.confidence ?? 0) < 0.5).length;

  routing_quality.missed_triggers = trustMissedTriggers;
  routing_quality.miss_rate = safeDiv(trustMissedTriggers, trustTotalInv);
  routing_quality.avg_confidence = trustAvgConfidence;
  routing_quality.confidence_coverage = safeDiv(trustConfCount, trustTotalInv);
  routing_quality.low_confidence_rate =
    trustWithConfidence.length > 0 ? safeDiv(trustLowConfCount, trustWithConfidence.length) : null;

  // Examples (limit 10 per category)
  type ExampleRowInternal = {
    timestamp: string | null;
    session_id: string;
    query_text: string;
    triggered: boolean;
    confidence: number | null;
    invocation_mode: string | null;
    prompt_kind: string | null;
    source: string | null;
    platform: string | null;
    workspace_path: string | null;
    query_origin: "inline_query" | "matched_prompt" | "missing";
    is_system_like: boolean;
    observation_kind:
      | "canonical"
      | "repaired_trigger"
      | "repaired_contextual_miss"
      | "legacy_materialized";
    historical_context: "previously_missed" | null;
  };

  const goodExamples: ExampleRowInternal[] = [];
  const missedExamples: ExampleRowInternal[] = [];
  const noisyExamples: ExampleRowInternal[] = [];

  for (const inv of dedupeTrustInvocations(trustInvocationsRaw)) {
    const queryText = inv.queryText;
    const sysLike = inv.isPolluting;
    const queryOrigin: "inline_query" | "matched_prompt" | "missing" =
      inv.inline_query != null && inv.inline_query !== ""
        ? "inline_query"
        : inv.matched_prompt_id != null
          ? "matched_prompt"
          : "missing";
    const row: ExampleRowInternal = {
      timestamp: inv.timestamp,
      session_id: inv.session_id,
      query_text: queryText,
      triggered: inv.triggered === 1,
      confidence: inv.confidence,
      invocation_mode: inv.invocation_mode,
      prompt_kind: inv.prompt_kind,
      source: inv.source,
      platform: inv.platform,
      workspace_path: inv.workspace_path,
      query_origin: queryOrigin,
      is_system_like: sysLike,
      observation_kind: inv.observation_kind,
      historical_context: inv.historical_context,
    };

    if (inv.triggered === 0 && missedExamples.length < 10) {
      missedExamples.push(row);
    } else if (
      inv.triggered === 1 &&
      queryText !== "" &&
      (queryOrigin === "inline_query" || inv.prompt_kind === "user" || inv.prompt_kind == null) &&
      goodExamples.length < 10
    ) {
      goodExamples.push(row);
    }
  }

  for (const inv of enrichedInvocations) {
    if (!inv.isPolluting || noisyExamples.length >= 10) continue;
    const queryOrigin: "inline_query" | "matched_prompt" | "missing" =
      inv.inline_query != null && inv.inline_query !== ""
        ? "inline_query"
        : inv.matched_prompt_id != null
          ? "matched_prompt"
          : "missing";
    noisyExamples.push({
      timestamp: inv.timestamp,
      session_id: inv.session_id,
      query_text: inv.queryText,
      triggered: inv.triggered === 1,
      confidence: inv.confidence,
      invocation_mode: inv.invocation_mode,
      prompt_kind: inv.prompt_kind,
      source: inv.source,
      platform: inv.platform,
      workspace_path: inv.workspace_path,
      query_origin: queryOrigin,
      is_system_like: true,
      observation_kind: inv.observation_kind,
      historical_context: null,
    });
  }

  const examples = {
    good: goodExamples,
    missed: missedExamples,
    noisy: noisyExamples,
  };

  // Trust state determination
  type TrustStateType =
    | "low_sample"
    | "observed"
    | "watch"
    | "validated"
    | "deployed"
    | "rolled_back";
  let trustState: TrustStateType;
  let trustSummary: string;

  if (coverage.checks < 5) {
    trustState = "low_sample";
    trustSummary =
      coverage.checks === 0 && testing_readiness
        ? `No runtime observations yet. Use the creator test loop to bootstrap this skill before trusting live routing.`
        : `Too few operational observations to assess trust — only ${coverage.checks} checks recorded.`;
  } else if (latestAuditRow?.action === "rolled_back") {
    trustState = "rolled_back";
    trustSummary = "Recent evolution was rolled back — review evidence before re-deploying.";
  } else if (latestAuditRow?.action === "deployed") {
    trustState = "deployed";
    trustSummary = `Deployed evolution; ${evolution_state.evidence_rows} evidence rows support current state.`;
  } else if (latestAuditRow?.action === "validated" || latestAuditRow?.action === "approved") {
    trustState = "validated";
    trustSummary = "Validated with evidence but not yet deployed.";
  } else if (
    routing_quality.missed_triggers > 0 ||
    evidence_quality.system_like_rate > 0.1 ||
    evidence_quality.prompt_link_rate < 0.3
  ) {
    trustState = "watch";
    const reasons: string[] = [];
    if (routing_quality.missed_triggers > 0)
      reasons.push(`${routing_quality.missed_triggers} missed triggers`);
    if (evidence_quality.system_like_rate > 0.1)
      reasons.push(`${(evidence_quality.system_like_rate * 100).toFixed(0)}% system-like queries`);
    if (evidence_quality.prompt_link_rate < 0.3)
      reasons.push(
        `low prompt link rate (${(evidence_quality.prompt_link_rate * 100).toFixed(0)}%)`,
      );
    trustSummary = `Needs attention — ${reasons.join(", ")}.`;
  } else {
    trustState = "observed";
    const qualityDesc =
      evidence_quality.prompt_link_rate > 0.7
        ? "strong"
        : evidence_quality.prompt_link_rate > 0.4
          ? "moderate"
          : "sparse";
    trustSummary = `Observed in ${coverage.sessions} sessions across ${coverage.workspaces} workspaces; evidence is ${qualityDesc}.`;
  }

  const trust = { state: trustState, summary: trustSummary };

  return Response.json({
    ...report,
    evolution: evolutionWithSnapshot,
    pending_proposals,
    token_usage: {
      total_input_tokens: executionRow?.total_input_tokens ?? 0,
      total_output_tokens: executionRow?.total_output_tokens ?? 0,
    },
    canonical_invocations: trustInvocations.slice(0, invLimit).map((i) => ({
      timestamp: i.timestamp,
      session_id: i.session_id,
      skill_name: i.skill_name,
      invocation_mode: i.invocation_mode,
      triggered: i.triggered === 1,
      confidence: i.confidence,
      tool_name: i.tool_name,
      agent_type: i.agent_type,
      query: i.queryText,
      source: i.source,
      skill_path: i.skill_path,
      skill_scope: i.skill_scope,
      observation_kind: i.observation_kind,
      historical_context: i.historical_context,
    })),
    invocations_pagination:
      trustInvocations.length > invLimit
        ? {
            next_cursor: {
              timestamp: trustInvocations[invLimit - 1]!.timestamp!,
              id: trustInvocations[invLimit - 1]!.skill_invocation_id,
            },
            has_more: true,
          }
        : undefined,
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
    trust,
    coverage,
    evidence_quality,
    routing_quality,
    evolution_state,
    data_hygiene,
    examples,
    testing_readiness,
  });
}
