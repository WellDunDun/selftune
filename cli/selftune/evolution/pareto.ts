/**
 * pareto.ts
 *
 * Pareto frontier computation for multi-candidate evolution.
 * All functions are pure — no I/O, no LLM calls.
 */

import type { InvocationType, InvocationTypeScores, ParetoCandidate } from "../types.js";

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute per-invocation-type scores from per-entry validation results.
 */
export function computeInvocationScores(
  perEntryResults: Array<{ entry: { invocation_type?: InvocationType }; after_pass: boolean }>,
): InvocationTypeScores {
  const dims: InvocationType[] = ["explicit", "implicit", "contextual", "negative"];
  const counts: Record<string, { passed: number; total: number }> = {};

  for (const dim of dims) {
    counts[dim] = { passed: 0, total: 0 };
  }

  for (const r of perEntryResults) {
    const type = r.entry.invocation_type ?? "implicit";
    if (!counts[type]) continue; // skip unknown invocation types
    counts[type].total++;
    if (r.after_pass) counts[type].passed++;
  }

  const result: Record<string, { passed: number; total: number; pass_rate: number }> = {};
  for (const dim of dims) {
    const { passed, total } = counts[dim];
    result[dim] = { passed, total, pass_rate: total > 0 ? passed / total : 0 };
  }

  return result as unknown as InvocationTypeScores;
}

// ---------------------------------------------------------------------------
// Pareto dominance
// ---------------------------------------------------------------------------

const DIMS: InvocationType[] = ["explicit", "implicit", "contextual", "negative"];

/**
 * Returns true if candidate A dominates candidate B:
 * A >= B on all dimensions AND A > B on at least one.
 */
export function dominates(a: InvocationTypeScores, b: InvocationTypeScores): boolean {
  let strictlyBetterOnAny = false;

  for (const dim of DIMS) {
    const aRate = a[dim].pass_rate;
    const bRate = b[dim].pass_rate;

    if (aRate < bRate) return false; // A is worse on this dim
    if (aRate > bRate) strictlyBetterOnAny = true;
  }

  return strictlyBetterOnAny;
}

/**
 * Compute the dimensions where candidate A dominates candidate B.
 */
export function getDominatedDimensions(
  a: InvocationTypeScores,
  b: InvocationTypeScores,
): InvocationType[] {
  const result: InvocationType[] = [];
  for (const dim of DIMS) {
    if (a[dim].pass_rate > b[dim].pass_rate) {
      result.push(dim);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pareto frontier
// ---------------------------------------------------------------------------

/**
 * Filter candidates to the Pareto frontier (non-dominated set).
 * Also sets `dominates_on` for each frontier member.
 */
export function computeParetoFrontier(candidates: ParetoCandidate[]): ParetoCandidate[] {
  if (candidates.length === 0) return [];

  const frontier: ParetoCandidate[] = [];

  for (const candidate of candidates) {
    // Check if any existing frontier member dominates this candidate
    let isDominated = false;
    for (const member of frontier) {
      if (dominates(member.invocation_scores, candidate.invocation_scores)) {
        isDominated = true;
        break;
      }
    }

    if (!isDominated) {
      // Remove frontier members that this candidate dominates
      for (let i = frontier.length - 1; i >= 0; i--) {
        if (dominates(candidate.invocation_scores, frontier[i].invocation_scores)) {
          frontier.splice(i, 1);
        }
      }
      frontier.push(candidate);
    }
  }

  // Set dominates_on for each frontier member (compared to others in frontier)
  for (const member of frontier) {
    const allDominatedDims = new Set<InvocationType>();
    for (const other of frontier) {
      if (other === member) continue;
      for (const dim of getDominatedDimensions(member.invocation_scores, other.invocation_scores)) {
        allDominatedDims.add(dim);
      }
    }
    member.dominates_on = [...allDominatedDims];
  }

  return frontier;
}

// ---------------------------------------------------------------------------
// Merge prompt
// ---------------------------------------------------------------------------

/**
 * Build a merge prompt for complementary frontier candidates.
 * Returns null if <= 1 candidate or no complementarity detected.
 */
export function buildMergePrompt(
  frontier: ParetoCandidate[],
  originalDescription: string,
): string | null {
  if (frontier.length <= 1) return null;

  // Check for complementarity: different candidates dominate on different dimensions
  const hasComplementarity = frontier.some((c) => c.dominates_on.length > 0);
  if (!hasComplementarity) return null;

  const candidateDescriptions = frontier
    .map((c, i) => {
      const strengths =
        c.dominates_on.length > 0
          ? `Strengths: ${c.dominates_on.join(", ")}`
          : "No unique strengths";
      return `Candidate ${i + 1} (${c.proposal.proposal_id}):\nDescription: ${c.proposal.proposed_description}\n${strengths}\nOverall pass rate: ${(c.validation.after_pass_rate * 100).toFixed(1)}%`;
    })
    .join("\n\n");

  return `You are merging multiple skill descriptions that each excel on different invocation types.

Original description:
${originalDescription}

Candidates:
${candidateDescriptions}

Create a single merged description that combines the strengths of all candidates.
Output ONLY valid JSON with:
- "proposed_description": the merged description
- "rationale": explanation of what was combined
- "confidence": 0.0-1.0`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Select the best candidate from a Pareto frontier.
 * Returns the best single candidate and whether a merge should be attempted.
 */
export function selectFromFrontier(frontier: ParetoCandidate[]): {
  best: ParetoCandidate;
  shouldMerge: boolean;
  mergePrompt: string | null;
} {
  if (frontier.length === 0) {
    throw new Error("Cannot select from empty frontier");
  }

  // Sort by overall after_pass_rate descending, then by number of new_passes
  const sorted = [...frontier].sort((a, b) => {
    const rateDiff = b.validation.after_pass_rate - a.validation.after_pass_rate;
    if (Math.abs(rateDiff) > 0.001) return rateDiff;
    return b.validation.new_passes.length - a.validation.new_passes.length;
  });

  const best = sorted[0];
  const shouldMerge = frontier.length > 1 && frontier.some((c) => c.dominates_on.length > 0);

  return {
    best,
    shouldMerge,
    mergePrompt: shouldMerge
      ? buildMergePrompt(frontier, best.proposal.original_description)
      : null,
  };
}
