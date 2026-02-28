/**
 * extract-patterns.ts
 *
 * Identifies failure patterns by cross-referencing eval entries with actual
 * skill usage records. Groups missed queries by invocation type and clusters
 * similar queries together using Jaccard similarity.
 */

import type { EvalEntry, FailurePattern, InvocationType, SkillUsageRecord } from "../types.js";

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
    let merged = false;

    for (const cluster of clusters) {
      // Single-linkage: if ANY member has similarity >= threshold, add to cluster
      for (const member of cluster) {
        if (computeQuerySimilarity(query, member) >= threshold) {
          cluster.push(query);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }

    if (!merged) {
      clusters.push([query]);
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

  // 4. Sort by frequency descending
  allPatterns.sort((a, b) => b.frequency - a.frequency);

  return allPatterns;
}
