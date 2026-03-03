/**
 * Aggregation logic for community contribution data.
 *
 * Computes session-weighted average pass rate from ContributionBundle submissions.
 * Trend computed by splitting time-ordered bundles into halves.
 */

import type { ContributionBundle } from "../../cli/selftune/types.js";
import type { AggregatedSkillData, SubmissionRecord } from "../types.js";

/**
 * Aggregate submissions for a single skill into a single AggregatedSkillData.
 *
 * Algorithm:
 * - Weight each contributor's pass rate by their graded_sessions count
 * - Trend: split time-ordered bundles into halves, compare weighted averages
 * - Status: HEALTHY if pass_rate > 0.6, REGRESSED if regression detected, NO DATA otherwise
 */
export function aggregateSkillData(
  skillName: string,
  submissions: SubmissionRecord[],
): AggregatedSkillData {
  if (submissions.length === 0) {
    return {
      skill_name: skillName,
      weighted_pass_rate: 0,
      trend: "unknown",
      status: "NO DATA",
      contributor_count: 0,
      session_count: 0,
      last_updated: new Date().toISOString(),
    };
  }

  // Parse bundles from submissions
  const bundles: Array<{ bundle: ContributionBundle; acceptedAt: string }> = [];
  for (const sub of submissions) {
    try {
      const bundle = JSON.parse(sub.bundle_json) as ContributionBundle;
      bundles.push({ bundle, acceptedAt: sub.accepted_at });
    } catch {
      // Skip malformed bundles
    }
  }

  if (bundles.length === 0) {
    return {
      skill_name: skillName,
      weighted_pass_rate: 0,
      trend: "unknown",
      status: "NO DATA",
      contributor_count: 0,
      session_count: 0,
      last_updated: new Date().toISOString(),
    };
  }

  // Compute session-weighted average pass rate
  let totalWeightedRate = 0;
  let totalSessions = 0;
  const contributors = new Set<string>();

  for (const { bundle } of bundles) {
    contributors.add(bundle.contributor_id);
    const grading = bundle.grading_summary;
    if (grading && grading.graded_sessions > 0) {
      totalWeightedRate += grading.average_pass_rate * grading.graded_sessions;
      totalSessions += grading.graded_sessions;
    }
  }

  const weightedPassRate = totalSessions > 0 ? totalWeightedRate / totalSessions : 0;

  // Compute trend: split time-ordered bundles into halves
  const sorted = [...bundles].sort(
    (a, b) => a.acceptedAt.localeCompare(b.acceptedAt),
  );
  const trend = computeTrend(sorted.map((s) => s.bundle));

  // Determine status
  let status: AggregatedSkillData["status"];
  if (totalSessions === 0) {
    status = "NO DATA";
  } else if (trend === "down" && weightedPassRate < 0.6) {
    status = "REGRESSED";
  } else {
    status = "HEALTHY";
  }

  return {
    skill_name: skillName,
    weighted_pass_rate: weightedPassRate,
    trend,
    status,
    contributor_count: contributors.size,
    session_count: totalSessions,
    last_updated: new Date().toISOString(),
  };
}

/**
 * Compute trend by splitting bundles into halves and comparing average pass rates.
 * Mirrors the approach used in cli/selftune/status.ts computeTrend().
 */
function computeTrend(
  bundles: ContributionBundle[],
): "up" | "down" | "stable" | "unknown" {
  const withGrading = bundles.filter(
    (b) => b.grading_summary && b.grading_summary.graded_sessions > 0,
  );

  if (withGrading.length < 2) return "unknown";

  const mid = Math.floor(withGrading.length / 2);
  const firstHalf = withGrading.slice(0, mid);
  const secondHalf = withGrading.slice(mid);

  const avgRate = (bs: ContributionBundle[]): number => {
    let totalW = 0;
    let totalS = 0;
    for (const b of bs) {
      if (b.grading_summary) {
        totalW += b.grading_summary.average_pass_rate * b.grading_summary.graded_sessions;
        totalS += b.grading_summary.graded_sessions;
      }
    }
    return totalS > 0 ? totalW / totalS : 0;
  };

  const firstRate = avgRate(firstHalf);
  const secondRate = avgRate(secondHalf);

  if (secondRate > firstRate + 0.01) return "up";
  if (secondRate < firstRate - 0.01) return "down";
  return "stable";
}
