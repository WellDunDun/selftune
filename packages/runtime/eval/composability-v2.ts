/**
 * composability-v2.ts
 *
 * Extended composability analysis with synergy detection and sequence extraction.
 * Builds on v1 patterns but adds:
 *   - Synergy scores (positive = better together, negative = conflict)
 *   - Ordered skill sequence detection from timestamps
 *   - Workflow candidate flagging
 *
 * Pure function -- no I/O. CLI wrapper handles reading JSONL.
 */

import type {
  ComposabilityReportV2,
  CoOccurrencePairV2,
  SessionTelemetryRecord,
  SkillSequence,
  SkillUsageRecord,
} from "../types.js";
import { clamp } from "../utils/math.js";

/**
 * Extended composability analysis with synergy detection and sequence extraction.
 *
 * @param skillName  - The skill to analyze
 * @param telemetry  - Session telemetry records
 * @param usage      - Skill usage records (for timestamp-based ordering)
 * @param options    - Analysis options
 * @returns ComposabilityReportV2 with synergy pairs, sequences, and workflow candidates
 */
export function analyzeComposabilityV2(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  usage: SkillUsageRecord[],
  options?: {
    window?: number;
    minOccurrences?: number;
  },
): ComposabilityReportV2 {
  const minOccurrences = options?.minOccurrences ?? 3;

  // Apply window: sort by timestamp descending, take last N
  let sessions = telemetry.filter((r) => r && Array.isArray(r.skills_triggered));

  if (options?.window && options.window > 0) {
    sessions = sessions
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      .slice(0, options.window);
  }

  // Build a set of session IDs in scope (after windowing)
  const sessionIdSet = new Set(sessions.map((s) => s.session_id));

  // Sessions where the target skill was triggered
  const skillSessions = sessions.filter((r) => r.skills_triggered.includes(skillName));

  // Sessions where the target skill was triggered ALONE (no other skills)
  const aloneSessions = skillSessions.filter((r) => r.skills_triggered.length === 1);

  // Average errors when skill is used alone
  const errorsAlone =
    aloneSessions.length > 0
      ? aloneSessions.reduce((sum, r) => sum + (r.errors_encountered ?? 0), 0) /
        aloneSessions.length
      : 0;

  // Find all co-occurring skills
  const coSkills = new Set<string>();
  for (const r of skillSessions) {
    for (const s of r.skills_triggered) {
      if (s !== skillName) coSkills.add(s);
    }
  }

  // -----------------------------------------------------------------------
  // Synergy computation for each co-occurring skill
  // -----------------------------------------------------------------------

  const pairs: CoOccurrencePairV2[] = [];
  for (const coSkill of coSkills) {
    // Sessions where BOTH skills are triggered together
    const togetherSessions = skillSessions.filter((r) => r.skills_triggered.includes(coSkill));
    const coOccurrenceCount = togetherSessions.length;

    // Average errors when both skills are used together
    const avgErrorsTogether =
      togetherSessions.length > 0
        ? togetherSessions.reduce((sum, r) => sum + (r.errors_encountered ?? 0), 0) /
          togetherSessions.length
        : 0;

    // Baseline: consider BOTH skills' solo error rates, take the max
    const coSkillAloneSessions = sessions.filter(
      (r) => r.skills_triggered.length === 1 && r.skills_triggered.includes(coSkill),
    );
    const errorsCoSkillAlone =
      coSkillAloneSessions.length > 0
        ? coSkillAloneSessions.reduce((sum, r) => sum + (r.errors_encountered ?? 0), 0) /
          coSkillAloneSessions.length
        : errorsAlone;
    const avgErrorsAlone = Math.max(errorsAlone, errorsCoSkillAlone);

    // synergy_score = clamp((avg_errors_alone - avg_errors_together) / (avg_errors_alone + 1), -1, 1)
    const synergyScore = clamp((avgErrorsAlone - avgErrorsTogether) / (avgErrorsAlone + 1), -1, 1);

    const conflictDetected = synergyScore < -0.3;
    const workflowCandidate = synergyScore > 0.3 && coOccurrenceCount >= minOccurrences;

    const pair: CoOccurrencePairV2 = {
      skill_a: skillName,
      skill_b: coSkill,
      co_occurrence_count: coOccurrenceCount,
      conflict_detected: conflictDetected,
      synergy_score: synergyScore,
      avg_errors_together: avgErrorsTogether,
      avg_errors_alone: avgErrorsAlone,
      workflow_candidate: workflowCandidate,
    };

    if (conflictDetected) {
      pair.conflict_reason = `synergy_score=${synergyScore.toFixed(3)} (avg errors together=${avgErrorsTogether.toFixed(1)} vs alone=${avgErrorsAlone.toFixed(1)})`;
    }

    pairs.push(pair);
  }

  // Sort by co-occurrence count descending
  pairs.sort((a, b) => b.co_occurrence_count - a.co_occurrence_count);

  // -----------------------------------------------------------------------
  // Sequence extraction from usage records
  // -----------------------------------------------------------------------

  // Filter usage records for sessions in scope that contain the target skill
  const usageInScope = usage.filter((u) => sessionIdSet.has(u.session_id));

  // Group by session_id
  const usageBySession = new Map<string, SkillUsageRecord[]>();
  for (const u of usageInScope) {
    const group = usageBySession.get(u.session_id);
    if (group) {
      group.push(u);
    } else {
      usageBySession.set(u.session_id, [u]);
    }
  }

  // Build ordered sequences per session (only sessions containing target skill)
  const sessionSequences: Array<{ skills: string[]; sessionId: string; firstQuery: string }> = [];

  for (const [sessionId, records] of usageBySession) {
    // Only sessions containing the target skill
    if (!records.some((r) => r.skill_name === skillName)) continue;

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

    // Only record sequences with 2+ skills
    if (skills.length >= 2) {
      sessionSequences.push({
        skills,
        sessionId,
        firstQuery: sorted[0]?.query ?? "",
      });
    }
  }

  // Count frequency of each unique sequence (by JSON key)
  const sequenceCounts = new Map<
    string,
    { count: number; queryCounts: Map<string, number>; skills: string[] }
  >();
  for (const seq of sessionSequences) {
    const key = JSON.stringify(seq.skills);
    const existing = sequenceCounts.get(key);
    if (existing) {
      existing.count++;
      existing.queryCounts.set(seq.firstQuery, (existing.queryCounts.get(seq.firstQuery) ?? 0) + 1);
    } else {
      sequenceCounts.set(key, {
        count: 1,
        queryCounts: new Map([[seq.firstQuery, 1]]),
        skills: seq.skills,
      });
    }
  }

  // Also count all orderings of each skill set (for consistency computation)
  // Key: sorted skill set -> total count of all orderings
  const skillSetCounts = new Map<string, number>();
  for (const seq of sessionSequences) {
    const setKey = JSON.stringify([...seq.skills].sort());
    skillSetCounts.set(setKey, (skillSetCounts.get(setKey) ?? 0) + 1);
  }

  // Build telemetry lookup by session_id for synergy scoring
  const telemetryBySession = new Map<string, SessionTelemetryRecord>();
  for (const s of sessions) {
    telemetryBySession.set(s.session_id, s);
  }

  // Build sequences, filtered by minOccurrences
  const sequences: SkillSequence[] = [];
  for (const [key, data] of sequenceCounts) {
    if (data.count < minOccurrences) continue;

    // Compute synergy_score for this sequence's sessions
    const matchingSessions = sessionSequences
      .filter((s) => JSON.stringify(s.skills) === key)
      .map((s) => telemetryBySession.get(s.sessionId))
      .filter((s): s is SessionTelemetryRecord => s !== undefined);

    const seqErrorsTogether =
      matchingSessions.length > 0
        ? matchingSessions.reduce((sum, r) => sum + (r.errors_encountered ?? 0), 0) /
          matchingSessions.length
        : 0;

    const seqSynergyScore = clamp((errorsAlone - seqErrorsTogether) / (errorsAlone + 1), -1, 1);

    // Consistency: count of this exact order / count of all orderings of same skill set
    const setKey = JSON.stringify([...data.skills].sort());
    const totalOrderings = skillSetCounts.get(setKey) ?? data.count;
    const sequenceConsistency = totalOrderings > 0 ? data.count / totalOrderings : 1;

    let representativeQuery = "";
    let highestFrequency = -1;
    for (const [query, frequency] of data.queryCounts) {
      if (frequency > highestFrequency) {
        representativeQuery = query;
        highestFrequency = frequency;
      }
    }

    sequences.push({
      skills: data.skills,
      occurrence_count: data.count,
      synergy_score: seqSynergyScore,
      representative_query: representativeQuery,
      sequence_consistency: sequenceConsistency,
    });
  }

  // Sort sequences by occurrence_count descending
  sequences.sort((a, b) => b.occurrence_count - a.occurrence_count);

  // -----------------------------------------------------------------------
  // Assemble report
  // -----------------------------------------------------------------------

  const workflowCandidates = pairs.filter((p) => p.workflow_candidate);
  const synergyCount = pairs.filter((p) => p.synergy_score > 0.3).length;

  return {
    pairs,
    sequences,
    workflow_candidates: workflowCandidates,
    synergy_count: synergyCount,
    total_sessions_analyzed: skillSessions.length,
    conflict_count: pairs.filter((p) => p.conflict_detected).length,
    generated_at: new Date().toISOString(),
  };
}
