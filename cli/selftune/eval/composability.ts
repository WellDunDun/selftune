/**
 * composability.ts
 *
 * Analyzes co-occurrence patterns between skills in session telemetry
 * to detect composability conflicts. A conflict is flagged when two
 * skills used together produce more errors than either skill used alone.
 *
 * Pure function -- no I/O. CLI wrapper handles reading JSONL.
 */

import type { CoOccurrencePair, ComposabilityReport, SessionTelemetryRecord } from "../types.js";

/**
 * Clamp a number between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Analyze composability of a target skill against all co-occurring skills.
 *
 * @param skillName - The skill to analyze
 * @param telemetry - All session telemetry records
 * @param window    - Optional: only consider the last N sessions (by timestamp)
 * @returns ComposabilityReport with co-occurrence pairs and conflict detection
 */
export function analyzeComposability(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  window?: number,
): ComposabilityReport {
  // Apply window: sort by timestamp descending, take last N
  let sessions = telemetry.filter(
    (r) => r && Array.isArray(r.skills_triggered),
  );

  if (window && window > 0) {
    sessions = sessions
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      .slice(0, window);
  }

  // Sessions where the target skill was triggered
  const skillSessions = sessions.filter((r) =>
    r.skills_triggered.includes(skillName),
  );

  // Sessions where the target skill was triggered ALONE (no other skills)
  const aloneSessions = skillSessions.filter(
    (r) => r.skills_triggered.length === 1,
  );

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

  // For each co-occurring skill, compute conflict score
  const pairs: CoOccurrencePair[] = [];
  for (const coSkill of coSkills) {
    // Sessions where BOTH skills are triggered together
    const togetherSessions = skillSessions.filter((r) =>
      r.skills_triggered.includes(coSkill),
    );

    const coOccurrenceCount = togetherSessions.length;

    // Average errors when both skills are used together
    const errorsTogether =
      togetherSessions.length > 0
        ? togetherSessions.reduce(
            (sum, r) => sum + (r.errors_encountered ?? 0),
            0,
          ) / togetherSessions.length
        : 0;

    // conflict_score = clamp((errors_together - errors_alone) / (errors_alone + 1), 0, 1)
    const conflictScore = clamp(
      (errorsTogether - errorsAlone) / (errorsAlone + 1),
      0,
      1,
    );

    const conflictDetected = conflictScore > 0.3;

    const pair: CoOccurrencePair = {
      skill_a: skillName,
      skill_b: coSkill,
      co_occurrence_count: coOccurrenceCount,
      conflict_detected: conflictDetected,
    };

    if (conflictDetected) {
      pair.conflict_reason = `conflict_score=${conflictScore.toFixed(3)} (avg errors together=${errorsTogether.toFixed(1)} vs alone=${errorsAlone.toFixed(1)})`;
    }

    pairs.push(pair);
  }

  // Sort by co-occurrence count descending for readability
  pairs.sort((a, b) => b.co_occurrence_count - a.co_occurrence_count);

  return {
    pairs,
    total_sessions_analyzed: skillSessions.length,
    conflict_count: pairs.filter((p) => p.conflict_detected).length,
    generated_at: new Date().toISOString(),
  };
}
