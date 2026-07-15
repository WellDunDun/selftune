/**
 * discover.ts
 *
 * Pure analysis functions for discovering multi-skill workflows from
 * telemetry and usage data. No I/O -- CLI wrapper handles reading JSONL.
 *
 * Adapts patterns from composability-v2.ts but removes single-skill scoping
 * to discover ALL multi-skill workflows across the codebase.
 */

import type {
  DiscoveredWorkflow,
  SessionTelemetryRecord,
  SkillUsageRecord,
  WorkflowDiscoveryReport,
} from "../types.js";
import { clamp } from "../utils/math.js";

/**
 * Discover multi-skill workflows from telemetry and usage data.
 *
 * Algorithm:
 *  1. Apply window filter to telemetry (sort by timestamp desc, take N)
 *  2. Build session ID set from filtered telemetry
 *  3. Filter usage records to in-scope sessions
 *  4. Group usage by session_id, sort by timestamp, deduplicate consecutive same-skill
 *  5. Keep sequences with 2+ skills
 *  6. Count frequency of each unique sequence, filter by minOccurrences (default 3)
 *  7. For each qualifying sequence compute metrics
 *  8. If --skill provided, filter to workflows containing that skill
 *  9. Sort by occurrence_count descending
 * 10. Return WorkflowDiscoveryReport
 */
export function discoverWorkflows(
  telemetry: SessionTelemetryRecord[],
  usage: SkillUsageRecord[],
  options?: { minOccurrences?: number; window?: number; skill?: string },
): WorkflowDiscoveryReport {
  const minOccurrences = options?.minOccurrences ?? 3;

  // 1. Apply window: sort by timestamp descending, take last N
  let sessions = telemetry.filter((r) => r && Array.isArray(r.skills_triggered));

  if (options?.window && options.window > 0) {
    sessions = sessions
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      .slice(0, options.window);
  }

  // 2. Build a set of session IDs in scope (after windowing)
  const sessionIdSet = new Set(sessions.map((s) => s.session_id));

  // 3. Filter usage records to in-scope sessions
  const usageInScope = usage.filter((u) => sessionIdSet.has(u.session_id));

  // 4. Group usage by session_id
  const usageBySession = new Map<string, SkillUsageRecord[]>();
  for (const u of usageInScope) {
    const group = usageBySession.get(u.session_id);
    if (group) {
      group.push(u);
    } else {
      usageBySession.set(u.session_id, [u]);
    }
  }

  // Build ordered sequences per session (ALL sessions, no target skill filter)
  const sessionSequences: Array<{
    skills: string[];
    sessionId: string;
    firstQuery: string;
  }> = [];

  for (const [sessionId, records] of usageBySession) {
    // Sort by timestamp ascending
    const sorted = [...records].sort((a, b) =>
      (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
    );

    // Extract skill names, deduplicate consecutive same-skill entries
    const skills: string[] = [];
    for (const r of sorted) {
      if (skills.length === 0 || skills[skills.length - 1] !== r.skill_name) {
        skills.push(r.skill_name);
      }
    }

    // 5. Only record sequences with 2+ skills
    if (skills.length >= 2) {
      sessionSequences.push({
        skills,
        sessionId,
        firstQuery: sorted[0]?.query ?? "",
      });
    }
  }

  // 6. Count frequency of each unique sequence (by JSON key)
  const sequenceCounts = new Map<
    string,
    { count: number; query: string; skills: string[]; sessionIds: string[] }
  >();
  for (const seq of sessionSequences) {
    const key = JSON.stringify(seq.skills);
    const existing = sequenceCounts.get(key);
    if (existing) {
      existing.count++;
      existing.sessionIds.push(seq.sessionId);
    } else {
      sequenceCounts.set(key, {
        count: 1,
        query: seq.firstQuery,
        skills: seq.skills,
        sessionIds: [seq.sessionId],
      });
    }
  }

  // Count all orderings of each skill set (for consistency computation)
  const skillSetCounts = new Map<string, number>();
  for (const seq of sessionSequences) {
    const setKey = JSON.stringify([...seq.skills].sort());
    skillSetCounts.set(setKey, (skillSetCounts.get(setKey) ?? 0) + 1);
  }

  // Build telemetry lookup by session_id
  const telemetryBySession = new Map<string, SessionTelemetryRecord>();
  for (const s of sessions) {
    telemetryBySession.set(s.session_id, s);
  }

  // Compute per-skill solo error rates (for avg_errors_individual)
  const skillSoloErrors = new Map<string, { totalErrors: number; count: number }>();
  for (const s of sessions) {
    if (s.skills_triggered.length === 1) {
      const skillName = s.skills_triggered[0];
      const entry = skillSoloErrors.get(skillName);
      if (entry) {
        entry.totalErrors += s.errors_encountered ?? 0;
        entry.count++;
      } else {
        skillSoloErrors.set(skillName, {
          totalErrors: s.errors_encountered ?? 0,
          count: 1,
        });
      }
    }
  }

  function getSkillSoloErrorRate(skillName: string): number | undefined {
    const entry = skillSoloErrors.get(skillName);
    if (!entry || entry.count === 0) return undefined;
    return entry.totalErrors / entry.count;
  }

  // 7. Build workflows, filtered by minOccurrences
  const workflows: DiscoveredWorkflow[] = [];
  for (const data of sequenceCounts.values()) {
    if (data.count < minOccurrences) continue;

    // workflow_id = skills.join("->")
    const workflowId = data.skills.join("\u2192");

    // Get matching telemetry sessions
    const matchingSessions = data.sessionIds
      .map((id) => telemetryBySession.get(id))
      .filter((s): s is SessionTelemetryRecord => s !== undefined);

    // avg_errors from matching telemetry sessions
    const avgErrors =
      matchingSessions.length > 0
        ? matchingSessions.reduce((sum, r) => sum + (r.errors_encountered ?? 0), 0) /
          matchingSessions.length
        : 0;

    const soloRates = data.skills
      .map((s) => getSkillSoloErrorRate(s))
      .filter((rate): rate is number => rate !== undefined);

    // avg_errors_individual = max of each skill's solo error rate
    // Note: This differs from composability-v2.ts which uses a single-skill anchor.
    // For multi-skill discovery, we conservatively anchor to the worst solo performer.
    const avgErrorsIndividual = soloRates.length > 0 ? Math.max(...soloRates) : 0;

    // synergy_score = clamp((individual - together) / (individual + 1), -1, 1)
    // If no solo baseline exists yet, keep the workflow neutral instead of treating missing data as zero.
    const synergyScore =
      soloRates.length > 0
        ? clamp((avgErrorsIndividual - avgErrors) / (avgErrorsIndividual + 1), -1, 1)
        : 0;

    // sequence_consistency = this_order_count / all_orderings_of_same_set
    const setKey = JSON.stringify([...data.skills].sort());
    const totalOrderings = skillSetCounts.get(setKey) ?? data.count;
    const sequenceConsistency = totalOrderings > 0 ? data.count / totalOrderings : 1;

    // completion_rate = sessions with ALL skills fired / sessions with ANY skill from set
    const skillSet = new Set(data.skills);
    let sessionsWithAny = 0;
    let sessionsWithAll = 0;
    for (const s of sessions) {
      const hasAny = s.skills_triggered.some((sk) => skillSet.has(sk));
      if (hasAny) {
        sessionsWithAny++;
        const hasAll = data.skills.every((sk) => s.skills_triggered.includes(sk));
        if (hasAll) sessionsWithAll++;
      }
    }
    const completionRate = sessionsWithAny > 0 ? sessionsWithAll / sessionsWithAny : 0;

    // representative_query = first query from first matching session
    const representativeQuery = data.query;

    // first_seen / last_seen from matching sessions
    const timestamps = matchingSessions
      .map((s) => s.timestamp)
      .filter((t) => t)
      .sort();
    const firstSeen = timestamps[0] ?? "";
    const lastSeen = timestamps[timestamps.length - 1] ?? "";

    workflows.push({
      workflow_id: workflowId,
      skills: data.skills,
      occurrence_count: data.count,
      avg_errors: avgErrors,
      avg_errors_individual: avgErrorsIndividual,
      synergy_score: synergyScore,
      representative_query: representativeQuery,
      sequence_consistency: sequenceConsistency,
      completion_rate: completionRate,
      first_seen: firstSeen,
      last_seen: lastSeen,
      session_ids: data.sessionIds,
    });
  }

  // 8. If --skill provided, filter to workflows containing that skill
  let filtered = workflows;
  if (options?.skill) {
    const skillFilter = options.skill;
    filtered = workflows.filter((w) => w.skills.includes(skillFilter));
  }

  // 9. Sort by occurrence_count descending
  filtered.sort((a, b) => b.occurrence_count - a.occurrence_count);

  // 10. Return WorkflowDiscoveryReport
  return {
    workflows: filtered,
    total_sessions_analyzed: sessions.length,
    generated_at: new Date().toISOString(),
  };
}
