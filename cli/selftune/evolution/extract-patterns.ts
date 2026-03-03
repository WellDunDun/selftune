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
  // 1. Build a set of triggered queries from skillUsage for the given skillName
  const triggeredQueries = new Set<string>();
  for (const record of skillUsage) {
    if (record.skill_name === skillName && record.triggered) {
      triggeredQueries.add(record.query);
    }
  }

  // 2. Find missed queries: should_trigger === true but NOT in the triggered set
  const missedByType = new Map<InvocationType, string[]>();

  for (const entry of evalEntries) {
    if (!entry.should_trigger) continue;
    if (triggeredQueries.has(entry.query)) continue;

    const invType = entry.invocation_type ?? "implicit";
    if (!missedByType.has(invType)) {
      missedByType.set(invType, []);
    }
    missedByType.get(invType)?.push(entry.query);
  }

  // 3. For each group, cluster similar queries
  const now = new Date().toISOString();
  const allPatterns: FailurePattern[] = [];
  let index = 0;

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

  // 3.5. Attach failure feedback from grading results if available
  if (gradingResults && gradingResults.length > 0) {
    const feedbackMap = new Map<string, FailureFeedback[]>();
    for (const gr of gradingResults) {
      if (gr.skill_name !== skillName) continue;
      if (gr.failure_feedback) {
        for (const fb of gr.failure_feedback) {
          const existing = feedbackMap.get(fb.query) ?? [];
          existing.push(fb);
          feedbackMap.set(fb.query, existing);
        }
      }
    }

    for (const pattern of allPatterns) {
      const matchingFeedback: FailureFeedback[] = [];
      for (const query of pattern.missed_queries) {
        const fbs = feedbackMap.get(query);
        if (fbs) matchingFeedback.push(...fbs);
      }
      if (matchingFeedback.length > 0) {
        pattern.feedback = matchingFeedback;
      }
    }
  }

  // 4. Sort by frequency descending
  allPatterns.sort((a, b) => b.frequency - a.frequency);

  return allPatterns;
}
