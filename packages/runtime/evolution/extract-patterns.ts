/**
 * extract-patterns.ts
 *
 * Identifies failure patterns by cross-referencing eval entries with actual
 * skill usage records. Groups missed queries by invocation type and clusters
 * similar queries together using Jaccard similarity.
 */

import type {
  EvalEntry,
  FailureFeedback,
  FailurePattern,
  GradingResult,
  InvocationType,
  SkillUsageRecord,
} from "../types.js";
import { filterActionableSkillUsageRecords } from "../utils/query-filter.js";
import { isHighConfidencePositiveSkillRecord } from "../utils/skill-usage-confidence.js";

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------

/** Tokenize a string into a set of lowercase words. */
function tokenize(s: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of s.split(/\s+/)) {
    const w = word.toLowerCase();
    if (w) tokens.add(w);
  }
  return tokens;
}

/** Jaccard similarity on word sets, returns 0.0-1.0 */
export function computeQuerySimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}

// ---------------------------------------------------------------------------
// Single-linkage clustering
// ---------------------------------------------------------------------------

/** Single-linkage clustering, default threshold 0.3 */
export function clusterQueries(queries: string[], threshold = 0.3): string[][] {
  if (queries.length === 0) return [];

  const clusters: string[][] = [];

  for (const query of queries) {
    // Collect indices of all clusters where any member has similarity >= threshold
    const matchingIndices: number[] = [];
    for (let i = 0; i < clusters.length; i++) {
      for (const member of clusters[i]) {
        if (computeQuerySimilarity(query, member) >= threshold) {
          matchingIndices.push(i);
          break;
        }
      }
    }

    if (matchingIndices.length === 0) {
      clusters.push([query]);
    } else {
      // Merge all matching clusters into the first one, then add the query
      const targetCluster = clusters[matchingIndices[0]];
      // Merge in reverse order so splice indices stay valid
      for (let j = matchingIndices.length - 1; j >= 1; j--) {
        const idx = matchingIndices[j];
        targetCluster.push(...clusters[idx]);
        clusters.splice(idx, 1);
      }
      targetCluster.push(query);
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Failure pattern extraction
// ---------------------------------------------------------------------------

/**
 * Cross-reference eval entries with actual usage to find missed queries.
 * Groups by invocation_type and clusters similar missed queries into patterns.
 * Returns sorted by frequency descending.
 */
export function extractFailurePatterns(
  evalEntries: EvalEntry[],
  skillUsage: SkillUsageRecord[],
  skillName: string,
  gradingResults?: GradingResult[],
): FailurePattern[] {
  const actionableSkillUsage = filterActionableSkillUsageRecords(skillUsage);
  const triggeredQueries = new Set<string>();
  const skillUsageBySession = new Map<string, SkillUsageRecord[]>();

  for (const record of actionableSkillUsage) {
    if (!isHighConfidencePositiveSkillRecord(record, skillName)) continue;
    triggeredQueries.add(record.query);
    const sessionRecords = skillUsageBySession.get(record.session_id) ?? [];
    sessionRecords.push(record);
    skillUsageBySession.set(record.session_id, sessionRecords);
  }

  const missedByType = new Map<InvocationType, string[]>();
  for (const entry of evalEntries) {
    if (!entry.should_trigger) continue;
    if (triggeredQueries.has(entry.query)) continue;

    const invType = entry.invocation_type ?? "implicit";
    const queries = missedByType.get(invType) ?? [];
    queries.push(entry.query);
    missedByType.set(invType, queries);
  }

  const now = new Date().toISOString();
  const allPatterns: FailurePattern[] = [];
  let index = 0;
  const feedbackMap = new Map<string, FailureFeedback[]>();
  const sampleSessionsByQuery = new Map<string, Set<string>>();

  for (const [invType, queries] of missedByType) {
    const clusters = clusterQueries(queries);
    for (const cluster of clusters) {
      allPatterns.push({
        pattern_id: `fp-${skillName}-${index}`,
        skill_name: skillName,
        invocation_type: invType,
        missed_queries: cluster,
        frequency: cluster.length,
        sample_sessions: [],
        extracted_at: now,
      });
      index++;
    }
  }

  if (gradingResults && gradingResults.length > 0) {
    for (const result of gradingResults) {
      const hasExplicitFeedback = (result.failure_feedback?.length ?? 0) > 0;
      const hasFailedSummary = (result.summary.failed ?? 0) > 0;
      if (result.skill_name !== skillName || (!hasExplicitFeedback && !hasFailedSummary)) continue;

      const failedQueries = new Set<string>();

      if (result.failure_feedback) {
        const sessionRecords = skillUsageBySession.get(result.session_id) ?? [];
        for (const feedback of result.failure_feedback) {
          if (!feedback.query) continue;
          const existing = feedbackMap.get(feedback.query) ?? [];
          existing.push(feedback);
          feedbackMap.set(feedback.query, existing);
          if (sessionRecords.some((record) => record.query === feedback.query)) {
            failedQueries.add(feedback.query);
            const sessions = sampleSessionsByQuery.get(feedback.query) ?? new Set<string>();
            sessions.add(result.session_id);
            sampleSessionsByQuery.set(feedback.query, sessions);
          }
        }
      }

      if (failedQueries.size === 0) {
        const sessionRecords = skillUsageBySession.get(result.session_id) ?? [];
        const failedExpectations = result.expectations.filter((expectation) => !expectation.passed);
        for (const record of sessionRecords) {
          failedQueries.add(record.query);
          const sessions = sampleSessionsByQuery.get(record.query) ?? new Set<string>();
          sessions.add(result.session_id);
          sampleSessionsByQuery.set(record.query, sessions);

          if (failedExpectations.length > 0) {
            const feedback = feedbackMap.get(record.query) ?? [];
            for (const expectation of failedExpectations) {
              feedback.push({
                query: record.query,
                failure_reason: expectation.evidence || expectation.text,
                improvement_hint: expectation.text,
                invocation_type: "contextual",
              });
            }
            feedbackMap.set(record.query, feedback);
          }
        }
      }
    }

    const contextualQueries = [...sampleSessionsByQuery.keys()];
    if (contextualQueries.length > 0) {
      const clusters = clusterQueries(contextualQueries);
      for (const cluster of clusters) {
        allPatterns.push({
          pattern_id: `fp-${skillName}-${index}`,
          skill_name: skillName,
          invocation_type: "contextual",
          missed_queries: cluster,
          frequency: cluster.length,
          sample_sessions: [
            ...new Set(cluster.flatMap((query) => [...(sampleSessionsByQuery.get(query) ?? [])])),
          ],
          extracted_at: now,
          feedback: cluster.flatMap((query) => feedbackMap.get(query) ?? []),
        });
        index++;
      }
    }
  }

  for (const pattern of allPatterns) {
    if (pattern.feedback && pattern.feedback.length > 0) continue;
    const matchingFeedback = pattern.missed_queries.flatMap(
      (query) => feedbackMap.get(query) ?? [],
    );
    if (matchingFeedback.length > 0) {
      pattern.feedback = matchingFeedback;
    }
  }

  allPatterns.sort((a, b) => b.frequency - a.frequency);
  return allPatterns;
}
