import type { Database } from "bun:sqlite";

import type { AttentionItem, AutonomousDecision, DecisionKind } from "../../dashboard-contract.js";
import { safeParseJson } from "./json.js";
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
    return SYSTEM_LIKE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
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
      observation_kind:
        | "canonical"
        | "repaired_trigger"
        | "repaired_contextual_miss"
        | "legacy_materialized";
      groupKey: string;
    }>
  >();
  const trustedRows: TrustedSkillObservationRow[] = [];

  for (const row of rows) {
    const queryText = row.query || row.prompt_text || "";
    const pollutionText = row.prompt_text || row.query || "";
    const observationKind = classifyObservationKind(
      row.skill_invocation_id,
      row.capture_mode,
      row.triggered,
      row.raw_source_ref,
    );
    if (isPollutingPrompt(pollutionText, row.prompt_kind)) continue;
    if (observationKind === "legacy_materialized") continue;

    const normalizedQuery = normalizeQueryForGrouping(queryText);
    const groupKey =
      normalizedQuery.length > 0
        ? `${row.session_id}::${normalizedQuery}`
        : `${row.skill_invocation_id}`;
    const observation = {
      skill_name: row.skill_name,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
      triggered: row.triggered,
      matched_prompt_id: row.matched_prompt_id,
      confidence: row.confidence,
      invocation_mode: row.invocation_mode,
      queryText,
      observation_kind: observationKind,
      groupKey,
    };
    const existing = bySkill.get(row.skill_name);
    if (existing) existing.push(observation);
    else bySkill.set(row.skill_name, [observation]);
  }

  for (const skillRows of bySkill.values()) {
    const grouped = new Map<string, typeof skillRows>();
    for (const row of skillRows) {
      const existing = grouped.get(row.groupKey);
      if (existing) existing.push(row);
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
    .flatMap((row) => {
      const evalSnapshot = safeParseJson(row.eval_snapshot_json) as {
        regressions?: unknown[];
      } | null;

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
          kind =
            evalSnapshot?.regressions && evalSnapshot.regressions.length > 0
              ? "validation_failed"
              : "proposal_created";
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
          skill_name: row.skill_name!,
          proposal_id: row.proposal_id,
          summary: row.details ?? "",
        },
      ];
    });
}
