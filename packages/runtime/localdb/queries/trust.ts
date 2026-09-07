import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { MAX_REPORT_QUERY_TEXT_CHARS, normalizeSkillText } from "@selftune/skill-intelligence";
import type { AttentionItem, AutonomousDecision, DecisionKind } from "../../dashboard-contract.js";
import { getPendingProposals } from "./evolution.js";

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

export interface TrayAttentionSummary {
  skillsObserved: number;
  pendingReviews: number;
  attentionRequired: number;
  hasCritical: boolean;
  criticalCount: number;
}

export interface TrustedSkillObservationRow {
  skill_name: string;
  skill_path: string | null;
  session_id: string;
  occurred_at: string | null;
  triggered: number;
  matched_prompt_id: string | null;
  confidence: number | null;
  invocation_mode: string | null;
  query_text: string;
  query_fingerprint?: string;
}

interface RawTrustedSkillObservationRow {
  skill_name: string;
  skill_path: string | null;
  session_id: string;
  occurred_at: string | null;
  triggered: number;
  matched_prompt_id: string | null;
  confidence: number | null;
  invocation_mode: string | null;
  skill_invocation_id: string;
  capture_mode: string | null;
  is_contextual_read: number;
  query: string | null;
  query_text_length: number;
  prompt_text: string | null;
  prompt_text_length: number;
  prompt_kind: string | null;
  is_internal_selftune_prompt: number;
}

const SYSTEM_LIKE_PREFIXES = ["<system_instruction>", "<system-instruction>", "<command-name>"];
const INTERNAL_EVAL_MARKERS = [
  "you are an evaluation assistant",
  "you are a skill description optimizer",
  "would each query trigger this skill",
  "propose an improved description",
  "failure patterns:",
  "output only valid json",
];

function normalizeQueryForGrouping(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function* iterateTrustedSkillObservationRows(
  db: Database,
): IterableIterator<TrustedSkillObservationRow> {
  const isSystemLike = (text: string | null | undefined): boolean => {
    if (!text) return false;
    const trimmed = text.trimStart();
    return SYSTEM_LIKE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  };
  const isPollutingPrompt = (
    text: string | null | undefined,
    isInternalSelftunePrompt: number,
  ): boolean => isSystemLike(text) || isInternalSelftunePrompt === 1;
  const classifyObservationKind = (
    skillInvocationId: string,
    captureMode: string | null,
    triggered: number,
    isContextualRead: number,
  ): "canonical" | "repaired_trigger" | "repaired_contextual_miss" | "legacy_materialized" => {
    if (skillInvocationId.includes(":su:")) return "legacy_materialized";
    if (captureMode === "repair") {
      if (triggered === 0 && isContextualRead === 1) {
        return "repaired_contextual_miss";
      }
      return "repaired_trigger";
    }
    return "canonical";
  };
  const internalPromptSql = INTERNAL_EVAL_MARKERS.map(
    (marker) => `instr(lower(coalesce(p.prompt_text, '')), '${marker.replaceAll("'", "''")}') > 0`,
  ).join(" OR ");
  const rows = db.query<RawTrustedSkillObservationRow, []>(
    `SELECT
         si.skill_name,
         si.skill_path,
         si.session_id,
         si.occurred_at,
         si.triggered,
         si.matched_prompt_id,
         si.confidence,
         si.invocation_mode,
         si.skill_invocation_id,
         si.capture_mode,
         CASE WHEN json_valid(si.raw_source_ref)
           THEN CASE WHEN json_extract(si.raw_source_ref, '$.metadata.miss_type') = 'contextual_read'
             THEN 1 ELSE 0 END
           ELSE 0 END AS is_contextual_read,
         substr(si.query, 1, ${MAX_REPORT_QUERY_TEXT_CHARS}) AS query,
         length(coalesce(si.query, '')) AS query_text_length,
         substr(p.prompt_text, 1, ${MAX_REPORT_QUERY_TEXT_CHARS}) AS prompt_text,
         length(coalesce(p.prompt_text, '')) AS prompt_text_length,
         p.prompt_kind,
         CASE
           WHEN p.prompt_kind = 'meta' AND (${internalPromptSql}) THEN 1
           ELSE 0
         END AS is_internal_selftune_prompt
       FROM skill_invocations si
       LEFT JOIN prompts p ON si.matched_prompt_id = p.prompt_id`,
  );

  const bySkill = new Map<
    string,
    Array<{
      skill_name: string;
      skill_path: string | null;
      session_id: string;
      occurred_at: string | null;
      triggered: number;
      matched_prompt_id: string | null;
      confidence: number | null;
      invocation_mode: string | null;
      queryText: string;
      observation_kind:
        | "canonical"
        | "repaired_trigger"
        | "repaired_contextual_miss"
        | "legacy_materialized";
      groupKey: string;
      queryFingerprint?: string;
    }>
  >();
  for (const row of rows.iterate()) {
    const queryText = row.query || row.prompt_text || "";
    const pollutionText = row.prompt_text || row.query || "";
    const observationKind = classifyObservationKind(
      row.skill_invocation_id,
      row.capture_mode,
      row.triggered,
      row.is_contextual_read,
    );
    if (isPollutingPrompt(pollutionText, row.is_internal_selftune_prompt)) continue;
    if (observationKind === "legacy_materialized") continue;

    const normalizedQuery = normalizeQueryForGrouping(queryText);
    const hasInvocationQuery = Boolean(row.query);
    const queryTextIsComplete = hasInvocationQuery
      ? row.query_text_length <= MAX_REPORT_QUERY_TEXT_CHARS
      : row.prompt_text_length <= MAX_REPORT_QUERY_TEXT_CHARS;
    const truncatedQueryIdentity = hasInvocationQuery
      ? `invocation:${row.skill_invocation_id}`
      : `prompt:${row.matched_prompt_id ?? row.skill_invocation_id}`;
    const compactQueryIdentity = queryTextIsComplete
      ? fingerprint(normalizedQuery)
      : truncatedQueryIdentity;
    const groupKey =
      normalizedQuery.length > 0
        ? `${row.session_id}::${compactQueryIdentity}`
        : `${row.skill_invocation_id}`;
    const normalizedSkillQuery = normalizeSkillText(queryText);
    const queryFingerprint = queryTextIsComplete
      ? fingerprint(normalizedSkillQuery)
      : truncatedQueryIdentity;
    const observation = {
      skill_name: row.skill_name,
      skill_path: row.skill_path,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      triggered: row.triggered,
      matched_prompt_id: row.matched_prompt_id,
      confidence: row.confidence,
      invocation_mode: row.invocation_mode,
      queryText: queryText.slice(0, MAX_REPORT_QUERY_TEXT_CHARS),
      observation_kind: observationKind,
      groupKey,
      queryFingerprint: normalizedSkillQuery ? queryFingerprint : undefined,
    };
    const packageKey = `${row.skill_name}::${row.skill_path ?? "<unknown>"}`;
    const existing = bySkill.get(packageKey);
    if (existing) existing.push(observation);
    else bySkill.set(packageKey, [observation]);
  }

  for (const skillRows of bySkill.values()) {
    const grouped = new Map<string, typeof skillRows>();
    for (const row of skillRows) {
      const existing = grouped.get(row.groupKey);
      if (existing) existing.push(row);
      else grouped.set(row.groupKey, [row]);
    }

    const deduped = [...grouped.values()].map((group) => {
      const sorted = group.toSorted((a, b) => {
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

    yield* deduped.map((row) => ({
      skill_name: row.skill_name,
      skill_path: row.skill_path,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      triggered: row.triggered,
      matched_prompt_id: row.matched_prompt_id,
      confidence: row.confidence,
      invocation_mode: row.invocation_mode,
      query_text: row.queryText,
      query_fingerprint: row.queryFingerprint,
    }));
  }
}

export function queryTrustedSkillObservationRows(db: Database): TrustedSkillObservationRow[] {
  return [...iterateTrustedSkillObservationRows(db)];
}

export function getSkillTrustSummaries(db: Database): SkillTrustSummary[] {
  const rows = queryTrustedSkillObservationRows(db);
  const auditRows = db
    .query<{ skill_name: string; action: string; timestamp: string }, []>(
      `SELECT skill_name, action, timestamp
       FROM evolution_audit
       WHERE skill_name IS NOT NULL
       ORDER BY timestamp DESC`,
    )
    .all();

  const latestActions = new Map<string, string>();
  for (const row of auditRows) {
    if (row.skill_name && !latestActions.has(row.skill_name)) {
      latestActions.set(row.skill_name, row.action);
    }
  }

  const rowsBySkill = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = rowsBySkill.get(row.skill_name);
    if (existing) existing.push(row);
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
        .toSorted((a, b) => b.localeCompare(a))[0] ?? null;

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
  const pendingSkills = new Set(pending.map((proposal) => proposal.skill_name).filter(Boolean));

  const items: AttentionItem[] = [];

  for (const summary of summaries) {
    if (summary.latest_action === "rolled_back") {
      items.push({
        skill_name: summary.skill_name,
        category: "needs_review",
        severity: "critical",
        reason: "Rolled back after deployment",
        recommended_action: "Review rollback evidence and decide whether to re-evolve",
        timestamp: summary.last_seen ?? "",
      });
      continue;
    }

    if (pendingSkills.has(summary.skill_name)) {
      items.push({
        skill_name: summary.skill_name,
        category: "needs_review",
        severity: "info",
        reason: "Proposal awaiting review",
        recommended_action: "Review and approve or reject the pending proposal",
        timestamp: summary.last_seen ?? "",
      });
      continue;
    }

    if (summary.total_checks < 5) continue;

    if (summary.miss_rate > 0.1) {
      items.push({
        skill_name: summary.skill_name,
        category: "regression",
        severity: "warning",
        reason: `High miss rate (${Math.round(summary.miss_rate * 100)}%)`,
        recommended_action: "Review missed invocations and consider evolving the skill description",
        timestamp: summary.last_seen ?? "",
      });
      continue;
    }

    if (summary.system_like_rate > 0.1) {
      items.push({
        skill_name: summary.skill_name,
        category: "polluted",
        severity: "warning",
        reason: `Possible telemetry pollution (${Math.round(summary.system_like_rate * 100)}% system-like)`,
        recommended_action: "Inspect prompts for system-injected noise",
        timestamp: summary.last_seen ?? "",
      });
    }
  }

  return items;
}

export function getTrayAttentionSummary(db: Database): TrayAttentionSummary {
  // The tray polls every 30 seconds. Keep this summary on indexed scalar fields;
  // normalized prompt materialization belongs to the full overview and trust reports.
  const summaries = db
    .query<
      {
        skill_name: string;
        total_checks: number;
        triggered_count: number;
      },
      [string]
    >(
      `SELECT
         skill_name,
         COUNT(*) AS total_checks,
         SUM(CASE WHEN triggered = 1 THEN 1 ELSE 0 END) AS triggered_count
       FROM skill_invocations
       WHERE instr(skill_invocation_id, ?) = 0
       GROUP BY skill_name`,
    )
    .all(":su:");
  const latestActions = new Map(
    db
      .query<{ skill_name: string; action: string }, []>(
        `WITH ranked AS (
           SELECT
             skill_name,
             action,
             ROW_NUMBER() OVER (
               PARTITION BY skill_name
               ORDER BY timestamp DESC, id DESC
             ) AS rank
           FROM evolution_audit
           WHERE skill_name IS NOT NULL
         )
         SELECT skill_name, action
         FROM ranked
         WHERE rank = 1`,
      )
      .all()
      .map((row) => [row.skill_name, row.action] as const),
  );
  const pendingSkills = new Set(
    getPendingProposals(db)
      .map((proposal) => proposal.skill_name)
      .filter((skillName): skillName is string => skillName != null),
  );

  let pendingReviews = 0;
  let attentionRequired = 0;
  let hasCritical = false;
  let criticalCount = 0;
  for (const summary of summaries) {
    if (latestActions.get(summary.skill_name) === "rolled_back") {
      pendingReviews++;
      attentionRequired++;
      hasCritical = true;
      criticalCount++;
      continue;
    }
    if (pendingSkills.has(summary.skill_name)) {
      pendingReviews++;
      attentionRequired++;
      continue;
    }
    const misses = summary.total_checks - summary.triggered_count;
    if (summary.total_checks >= 5 && misses / summary.total_checks > 0.1) {
      attentionRequired++;
    }
  }

  return {
    skillsObserved: summaries.length,
    pendingReviews,
    attentionRequired,
    hasCritical,
    criticalCount,
  };
}

export function getRecentDecisions(db: Database, limit = 20): AutonomousDecision[] {
  const rows = db
    .query<
      {
        timestamp: string;
        proposal_id: string;
        skill_name: string;
        action: string;
        details: string | null;
        regression_count: number;
      },
      [number]
    >(
      `SELECT timestamp, proposal_id, skill_name, action, details,
         CASE WHEN json_valid(eval_snapshot_json)
           THEN COALESCE(json_array_length(eval_snapshot_json, '$.regressions'), 0)
           ELSE 0 END AS regression_count
       FROM evolution_audit
       WHERE timestamp >= datetime('now', '-7 days') AND skill_name IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit);

  return rows.flatMap((row) => {
    let kind: DecisionKind | null;
    switch (row.action) {
      case "proposed":
      case "created":
        kind = "proposal_created";
        break;
      case "rejected":
        kind = "proposal_rejected";
        break;
      case "validated":
        kind = row.regression_count > 0 ? "validation_failed" : "proposal_created";
        break;
      case "deployed":
        kind = "proposal_deployed";
        break;
      case "rolled_back":
        kind = "rollback_triggered";
        break;
      default:
        kind = null;
    }

    if (!kind) return [];

    return [
      {
        timestamp: row.timestamp,
        kind,
        skill_name: row.skill_name,
        proposal_id: row.proposal_id,
        summary: row.details ?? "",
      },
    ];
  });
}
