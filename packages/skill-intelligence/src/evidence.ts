import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  SKILL_INTELLIGENCE_EVIDENCE_VERSION,
  type SkillSetSuggestionReview,
  type SkillSetSuggestionReviewReasonCode,
} from "./contract.js";
import type { SkillSetSuggestion, SkillSetSuggestionEvidenceState } from "./types.js";
import type {
  SkillIntelligenceSessionRow,
  SkillIntelligenceTriggeredObservationRow,
  SkillSetManifest,
  TrustedSkillObservationRow,
} from "./types.js";
import { clamp } from "./internal/math.js";

function skillId(name: string): string {
  return name.trim().toLowerCase();
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export function stableEvidenceId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export interface CoUsageEdge {
  key: string;
  left: string;
  right: string;
  occurrenceCount: number;
  support: number;
  affinity: number;
  affinityLowerBound: number;
  lift: number;
  score: number;
}

export interface CoUsageCommunity {
  ids: string[];
  edgeKeys: string[];
  occurrenceCount: number;
  support: number;
  affinity: number;
  edgeCoverage: number;
  meanLift: number;
  score: number;
  memberships: ReadonlyMap<string, CoUsageCommunityMembership>;
}

export interface CoUsageCommunityMembership {
  score: number;
  edgeCoverage: number;
  meanEdgeStrength: number;
  specificity: number;
}

export const COMMUNITY_MIN_EDGE_COVERAGE = 0.65;
const COMMUNITY_MIN_MEMBER_EDGE_COVERAGE = 0.5;
const COMMUNITY_MIN_RELATIVE_MEMBER_STRENGTH = 0.65;
const COMMUNITY_MIN_MEMBERSHIP_SCORE = 0.5;

function associationKey(left: string, right: string): string {
  return [left, right].toSorted().join("\u0000");
}

export function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  // One-sided 90% bound: a conservative ranking feature, not a significance test.
  const z = 1.645;
  const probability = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = probability + zSquared / (2 * trials);
  const margin =
    z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
}

export function hasSingleKnownSource(
  ids: ReadonlyArray<string>,
  sourceById: ReadonlyMap<string, string | null>,
): boolean {
  const sources = ids.map((id) => sourceById.get(id) ?? null);
  return sources.every((source) => source !== null) && new Set(sources).size === 1;
}

function connectionEdges(
  id: string,
  group: ReadonlyArray<string>,
  edgesByKey: ReadonlyMap<string, CoUsageEdge>,
): CoUsageEdge[] {
  return group.flatMap((peer) => {
    const edge = edgesByKey.get(associationKey(id, peer));
    return edge ? [edge] : [];
  });
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted[middle]!;
}

function internalEdges(
  ids: ReadonlyArray<string>,
  edgesByKey: ReadonlyMap<string, CoUsageEdge>,
): CoUsageEdge[] {
  return ids.flatMap((left, leftIndex) =>
    ids.slice(leftIndex + 1).flatMap((right) => {
      const edge = edgesByKey.get(associationKey(left, right));
      return edge ? [edge] : [];
    }),
  );
}

function communityMemberships(
  ids: ReadonlyArray<string>,
  edgesByKey: ReadonlyMap<string, CoUsageEdge>,
  incidentEdgesById: ReadonlyMap<string, ReadonlyArray<CoUsageEdge>>,
): ReadonlyMap<string, CoUsageCommunityMembership> {
  const memberships = new Map<string, CoUsageCommunityMembership>();
  for (const id of ids) {
    const inside = connectionEdges(
      id,
      ids.filter((peer) => peer !== id),
      edgesByKey,
    );
    const insideStrength = inside.reduce((total, edge) => total + edge.score, 0);
    const totalStrength = (incidentEdgesById.get(id) ?? []).reduce(
      (total, edge) => total + edge.score,
      0,
    );
    const edgeCoverage = ids.length > 1 ? inside.length / (ids.length - 1) : 0;
    const meanEdgeStrength = inside.length > 0 ? insideStrength / inside.length : 0;
    const specificity = totalStrength > 0 ? insideStrength / totalStrength : 0;
    memberships.set(id, {
      score: clamp(edgeCoverage * 0.35 + meanEdgeStrength * 0.45 + specificity * 0.2, 0, 1),
      edgeCoverage,
      meanEdgeStrength,
      specificity,
    });
  }
  return memberships;
}

function evaluateCommunity(
  ids: ReadonlyArray<string>,
  edgesByKey: ReadonlyMap<string, CoUsageEdge>,
  incidentEdgesById: ReadonlyMap<string, ReadonlyArray<CoUsageEdge>>,
  minOccurrences: number,
): CoUsageCommunity | null {
  if (ids.length < 3) return null;
  const possibleEdges = (ids.length * (ids.length - 1)) / 2;
  const groupEdges = internalEdges(ids, edgesByKey);
  const edgeCoverage = groupEdges.length / possibleEdges;
  if (edgeCoverage < COMMUNITY_MIN_EDGE_COVERAGE) return null;

  const memberships = communityMemberships(ids, edgesByKey, incidentEdgesById);
  if (
    [...memberships.values()].some(
      (membership) =>
        membership.edgeCoverage < COMMUNITY_MIN_MEMBER_EDGE_COVERAGE ||
        membership.score < COMMUNITY_MIN_MEMBERSHIP_SCORE,
    )
  ) {
    return null;
  }
  const meanEdgeStrength =
    groupEdges.reduce((total, edge) => total + edge.score, 0) / possibleEdges;
  if (
    [...memberships.values()].some(
      (membership) =>
        membership.meanEdgeStrength < meanEdgeStrength * COMMUNITY_MIN_RELATIVE_MEMBER_STRENGTH,
    )
  ) {
    return null;
  }

  // Missing edges count as zero. This prevents a sparse hub from looking like a dense workflow.
  const affinity = groupEdges.reduce((total, edge) => total + edge.affinity, 0) / possibleEdges;
  const support = groupEdges.reduce((total, edge) => total + edge.support, 0) / possibleEdges;
  const meanLift = groupEdges.reduce((total, edge) => total + edge.lift, 0) / possibleEdges;
  const occurrenceCount = median(groupEdges.map((edge) => edge.occurrenceCount));
  const weakestMembership = Math.min(...[...memberships.values()].map((value) => value.score));
  const score =
    edgeCoverage * 0.25 +
    affinity * 0.25 +
    meanEdgeStrength * 0.25 +
    weakestMembership * 0.15 +
    Math.min(occurrenceCount / (minOccurrences * 2), 1) * 0.1;
  return {
    ids: [...ids].toSorted(),
    edgeKeys: groupEdges.map((edge) => edge.key).toSorted(),
    occurrenceCount,
    support,
    affinity,
    edgeCoverage,
    meanLift,
    score,
    memberships,
  };
}

export function discoverOverlappingCommunities(
  edges: ReadonlyArray<CoUsageEdge>,
  _idsBySession: ReadonlyMap<string, ReadonlyArray<string>>,
  sourceById: ReadonlyMap<string, string | null>,
  minOccurrences: number,
  _minAffinity: number,
  maxSkills = 6,
): CoUsageCommunity[] {
  void _idsBySession;
  void sourceById;
  void _minAffinity;
  const edgesByKey = new Map(edges.map((edge) => [edge.key, edge]));
  const neighbors = new Map<string, Set<string>>();
  const incidentEdgesById = new Map<string, CoUsageEdge[]>();
  for (const edge of edges) {
    const left = neighbors.get(edge.left) ?? new Set<string>();
    left.add(edge.right);
    neighbors.set(edge.left, left);
    const right = neighbors.get(edge.right) ?? new Set<string>();
    right.add(edge.left);
    neighbors.set(edge.right, right);
    const leftEdges = incidentEdgesById.get(edge.left) ?? [];
    leftEdges.push(edge);
    incidentEdgesById.set(edge.left, leftEdges);
    const rightEdges = incidentEdgesById.get(edge.right) ?? [];
    rightEdges.push(edge);
    incidentEdgesById.set(edge.right, rightEdges);
  }

  const communities = new Map<string, CoUsageCommunity>();
  const sortedEdges = edges.toSorted(
    (left, right) => right.score - left.score || left.key.localeCompare(right.key),
  );
  for (const seed of sortedEdges) {
    const group = [seed.left, seed.right];
    while (group.length < maxSkills) {
      const currentCommunity = evaluateCommunity(
        group,
        edgesByKey,
        incidentEdgesById,
        minOccurrences,
      );
      if (currentCommunity) {
        const key = currentCommunity.ids.join("\u0000");
        const existing = communities.get(key);
        if (!existing || currentCommunity.score > existing.score) {
          communities.set(key, currentCommunity);
        }
      }
      const candidates = [...new Set(group.flatMap((id) => [...(neighbors.get(id) ?? [])]))]
        .filter((id) => !group.includes(id))
        .flatMap((id) => {
          const candidateEdges = connectionEdges(id, group, edgesByKey);
          const candidateCoverage = candidateEdges.length / group.length;
          if (candidateCoverage < COMMUNITY_MIN_MEMBER_EDGE_COVERAGE) return [];
          const possibleEdges = ((group.length + 1) * group.length) / 2;
          const currentEdges = internalEdges(group, edgesByKey);
          const edgeCoverage = (currentEdges.length + candidateEdges.length) / possibleEdges;
          if (edgeCoverage < COMMUNITY_MIN_EDGE_COVERAGE) return [];
          const meanScore =
            candidateEdges.reduce((total, edge) => total + edge.score, 0) / candidateEdges.length;
          const currentMeanScore =
            currentEdges.reduce((total, edge) => total + edge.score, 0) / currentEdges.length;
          if (meanScore < currentMeanScore * COMMUNITY_MIN_RELATIVE_MEMBER_STRENGTH) return [];
          if (!evaluateCommunity([...group, id], edgesByKey, incidentEdgesById, minOccurrences)) {
            return [];
          }
          return [{ id, candidateCoverage, edgeCoverage, meanScore }];
        })
        .toSorted(
          (left, right) =>
            right.edgeCoverage - left.edgeCoverage ||
            right.candidateCoverage - left.candidateCoverage ||
            right.meanScore - left.meanScore ||
            left.id.localeCompare(right.id),
        );
      const next = candidates[0];
      if (!next) break;
      group.push(next.id);
    }

    const community = evaluateCommunity(group, edgesByKey, incidentEdgesById, minOccurrences);
    if (!community) continue;
    const key = community.ids.join("\u0000");
    const current = communities.get(key);
    if (!current || community.score > current.score) {
      communities.set(key, community);
    }
  }

  const ranked = [...communities.values()].toSorted(
    (left, right) =>
      right.ids.length - left.ids.length ||
      right.score - left.score ||
      left.ids.join("\u0000").localeCompare(right.ids.join("\u0000")),
  );
  return ranked.filter(
    (candidate, index) =>
      !ranked
        .slice(0, index)
        .some(
          (larger) =>
            larger.ids.length > candidate.ids.length &&
            candidate.ids.every((id) => larger.ids.includes(id)),
        ),
  );
}

export function buildSessionEvidence(
  observations: ReadonlyArray<TrustedSkillObservationRow>,
  installedIds: ReadonlySet<string>,
) {
  const orderedBySession = new Map<string, TrustedSkillObservationRow[]>();
  for (const row of observations) {
    const id = skillId(row.skill_name);
    if (row.triggered !== 1 || !installedIds.has(id)) continue;
    const rows = orderedBySession.get(row.session_id);
    if (rows) rows.push(row);
    else orderedBySession.set(row.session_id, [row]);
  }

  const idsBySession = new Map<string, string[]>();
  for (const [sessionId, rows] of orderedBySession) {
    rows.sort((left, right) => (left.occurred_at ?? "").localeCompare(right.occurred_at ?? ""));
    const ids: string[] = [];
    for (const row of rows) {
      const id = skillId(row.skill_name);
      if (!ids.includes(id)) ids.push(id);
    }
    idsBySession.set(sessionId, ids);
  }
  return { orderedBySession, idsBySession };
}

export interface TemporalEvidencePartition {
  ready: boolean;
  discoverySessionIds: Set<string>;
  heldOutSessionIds: Set<string>;
  cutoffAt: string | null;
}

function sessionTimestamp(
  sessionId: string,
  orderedBySession: ReadonlyMap<string, ReadonlyArray<SkillIntelligenceTriggeredObservationRow>>,
  rawSessionsById: ReadonlyMap<string, SkillIntelligenceSessionRow>,
): string {
  return (
    rawSessionsById.get(sessionId)?.timestamp ??
    orderedBySession.get(sessionId)?.at(-1)?.occurred_at ??
    new Date(0).toISOString()
  );
}

export function partitionTemporalEvidence(
  idsBySession: ReadonlyMap<string, ReadonlyArray<string>>,
  orderedBySession: ReadonlyMap<string, ReadonlyArray<SkillIntelligenceTriggeredObservationRow>>,
  rawSessionsById: ReadonlyMap<string, SkillIntelligenceSessionRow>,
  minOccurrences: number,
  minValidationOccurrences: number,
  holdoutRatio: number,
): TemporalEvidencePartition {
  const sessionIds = [...idsBySession.keys()].toSorted((left, right) => {
    const byTimestamp = sessionTimestamp(left, orderedBySession, rawSessionsById).localeCompare(
      sessionTimestamp(right, orderedBySession, rawSessionsById),
    );
    return byTimestamp || left.localeCompare(right);
  });
  const allDiscovery = new Set(sessionIds);
  if (sessionIds.length < minOccurrences + minValidationOccurrences) {
    return {
      ready: false,
      discoverySessionIds: allDiscovery,
      heldOutSessionIds: new Set(),
      cutoffAt: null,
    };
  }

  const heldOutCount = Math.min(
    sessionIds.length - minOccurrences,
    Math.max(minValidationOccurrences, Math.ceil(sessionIds.length * holdoutRatio)),
  );
  if (heldOutCount < minValidationOccurrences) {
    return {
      ready: false,
      discoverySessionIds: allDiscovery,
      heldOutSessionIds: new Set(),
      cutoffAt: null,
    };
  }

  const splitIndex = sessionIds.length - heldOutCount;
  const discoverySessionIds = new Set(sessionIds.slice(0, splitIndex));
  const heldOutIds = sessionIds.slice(splitIndex);
  return {
    ready: true,
    discoverySessionIds,
    heldOutSessionIds: new Set(heldOutIds),
    cutoffAt: heldOutIds[0]
      ? sessionTimestamp(heldOutIds[0], orderedBySession, rawSessionsById)
      : null,
  };
}

export function existingSkillSetKeys(sets: ReadonlyArray<SkillSetManifest>): Set<string> {
  return new Set(
    sets.map((set) =>
      set.skills
        .map((skill) => skillId(skill.name))
        .toSorted()
        .join("\u0000"),
    ),
  );
}

export type SkillSetSuggestionCandidate = Omit<SkillSetSuggestion, "evidence_fingerprint">;
export type SkillSetSuggestionDiscoveryCandidate = Omit<
  SkillSetSuggestionCandidate,
  | "evidence_state"
  | "discovery_occurrence_count"
  | "held_out_occurrence_count"
  | "held_out_support"
  | "held_out_affinity"
  | "held_out_edge_coverage"
  | "held_out_sequence_consistency"
> & {
  discovery_edge_keys?: ReadonlyArray<string>;
};

export function evidenceFingerprint(candidate: SkillSetSuggestionCandidate): string {
  return stableEvidenceId(
    JSON.stringify({
      evidence_version: SKILL_INTELLIGENCE_EVIDENCE_VERSION,
      pattern: candidate.pattern,
      skills:
        candidate.pattern === "workflow"
          ? candidate.skills.map((skill) => skillId(skill.name))
          : candidate.skills.map((skill) => skillId(skill.name)).toSorted(),
      project_root: candidate.project_root,
      evidence_state: candidate.evidence_state,
      occurrence_count: candidate.occurrence_count,
      discovery_occurrence_count: candidate.discovery_occurrence_count,
      held_out_occurrence_count: candidate.held_out_occurrence_count,
      support: candidate.support,
      held_out_support: candidate.held_out_support,
      affinity: candidate.affinity,
      held_out_affinity: candidate.held_out_affinity,
      discovery_edge_coverage: candidate.discovery_edge_coverage,
      held_out_edge_coverage: candidate.held_out_edge_coverage,
      sequence_consistency: candidate.sequence_consistency,
      held_out_sequence_consistency: candidate.held_out_sequence_consistency,
      synergy_score: candidate.synergy_score,
    }),
  );
}

function orderedPatternMatches(sessionIds: ReadonlyArray<string>, pattern: ReadonlyArray<string>) {
  let cursor = -1;
  for (const id of pattern) {
    cursor = sessionIds.indexOf(id, cursor + 1);
    if (cursor < 0) return false;
  }
  return true;
}

interface HeldOutEdgeEvidence {
  occurrenceCount: number;
  support: number;
  affinity: number;
  edgeCoverage: number;
}

function heldOutEdgeEvidence(
  skillIds: ReadonlyArray<string>,
  discoveryEdgeKeys: ReadonlyArray<string>,
  heldOutIdsBySession: ReadonlyMap<string, ReadonlyArray<string>>,
): HeldOutEdgeEvidence {
  const requestedKeys =
    discoveryEdgeKeys.length > 0
      ? new Set(discoveryEdgeKeys)
      : new Set(
          skillIds.flatMap((left, leftIndex) =>
            skillIds.slice(leftIndex + 1).map((right) => associationKey(left, right)),
          ),
        );
  const pairEvidence = skillIds.flatMap((left, leftIndex) =>
    skillIds.slice(leftIndex + 1).flatMap((right) => {
      const key = associationKey(left, right);
      if (!requestedKeys.has(key)) return [];
      let occurrenceCount = 0;
      let unionCount = 0;
      let leftCount = 0;
      let rightCount = 0;
      for (const ids of heldOutIdsBySession.values()) {
        const hasLeft = ids.includes(left);
        const hasRight = ids.includes(right);
        if (hasLeft) leftCount += 1;
        if (hasRight) rightCount += 1;
        if (hasLeft || hasRight) unionCount += 1;
        if (hasLeft && hasRight) occurrenceCount += 1;
      }
      return [
        {
          left,
          right,
          occurrenceCount,
          support: heldOutIdsBySession.size > 0 ? occurrenceCount / heldOutIdsBySession.size : 0,
          affinity: unionCount > 0 ? occurrenceCount / unionCount : 0,
          lift:
            leftCount > 0 && rightCount > 0
              ? (occurrenceCount * heldOutIdsBySession.size) / (leftCount * rightCount)
              : 0,
        },
      ];
    }),
  );
  if (pairEvidence.length === 0) {
    return { occurrenceCount: 0, support: 0, affinity: 0, edgeCoverage: 0 };
  }
  const recurringEdges = pairEvidence.filter((edge) => edge.occurrenceCount > 0 && edge.lift >= 1);
  const membersWithRecurringEdges = new Set(
    recurringEdges.flatMap((edge) => [edge.left, edge.right]),
  );
  return {
    occurrenceCount: median(recurringEdges.map((edge) => edge.occurrenceCount)),
    support: pairEvidence.reduce((total, edge) => total + edge.support, 0) / pairEvidence.length,
    affinity: pairEvidence.reduce((total, edge) => total + edge.affinity, 0) / pairEvidence.length,
    edgeCoverage:
      membersWithRecurringEdges.size === skillIds.length
        ? recurringEdges.length / pairEvidence.length
        : 0,
  };
}

export function validateSuggestionCandidate(
  candidate: SkillSetSuggestionDiscoveryCandidate,
  partition: TemporalEvidencePartition,
  heldOutIdsBySession: ReadonlyMap<string, ReadonlyArray<string>>,
  rawSessionsById: ReadonlyMap<string, SkillIntelligenceSessionRow>,
  minAffinity: number,
  minValidationOccurrences: number,
): SkillSetSuggestionCandidate | null {
  const { discovery_edge_keys: discoveryEdgeKeys = [], ...publicCandidate } = candidate;
  if (!partition.ready) {
    return {
      ...publicCandidate,
      evidence_state: "exploratory",
      confidence: round(Math.min(candidate.confidence, 0.55)),
      discovery_occurrence_count: candidate.occurrence_count,
      held_out_occurrence_count: 0,
      held_out_support: null,
      held_out_affinity: null,
      held_out_edge_coverage: null,
      held_out_sequence_consistency: null,
      reason: `${candidate.reason} More later sessions are needed for held-out validation.`,
    };
  }

  const skillIds = candidate.skills.map((skill) => skillId(skill.name));
  let heldOutOccurrenceCount = 0;
  let heldOutSupport = 0;
  let heldOutAffinity: number | null = null;
  let heldOutSequenceConsistency: number | null = null;
  let validationStrength = 0;
  let meetsQualityFloor = false;

  if (candidate.pattern === "workflow") {
    let sessionsWithAny = 0;
    let sessionsWithAll = 0;
    for (const ids of heldOutIdsBySession.values()) {
      if (skillIds.some((id) => ids.includes(id))) sessionsWithAny += 1;
      if (!skillIds.every((id) => ids.includes(id))) continue;
      sessionsWithAll += 1;
      if (orderedPatternMatches(ids, skillIds)) heldOutOccurrenceCount += 1;
    }
    heldOutSupport = sessionsWithAny > 0 ? heldOutOccurrenceCount / sessionsWithAny : 0;
    heldOutSequenceConsistency = sessionsWithAll > 0 ? heldOutOccurrenceCount / sessionsWithAll : 0;
    validationStrength = heldOutSequenceConsistency;
    meetsQualityFloor = heldOutSequenceConsistency >= 0.7;
  } else if (candidate.pattern === "co_usage") {
    const edgeEvidence = heldOutEdgeEvidence(skillIds, discoveryEdgeKeys, heldOutIdsBySession);
    heldOutOccurrenceCount = edgeEvidence.occurrenceCount;
    heldOutSupport = edgeEvidence.support;
    heldOutAffinity = edgeEvidence.affinity;
    const heldOutEdgeCoverage = edgeEvidence.edgeCoverage;
    validationStrength = heldOutAffinity * 0.55 + heldOutEdgeCoverage * 0.45;
    meetsQualityFloor =
      skillIds.length === 2
        ? heldOutAffinity >= minAffinity
        : heldOutEdgeCoverage >= COMMUNITY_MIN_EDGE_COVERAGE;
    if (heldOutOccurrenceCount === 0) return null;
    if (skillIds.length >= 3 && !meetsQualityFloor) return null;
    const evidenceState: SkillSetSuggestionEvidenceState =
      heldOutOccurrenceCount >= minValidationOccurrences && meetsQualityFloor
        ? "validated"
        : "supported";
    const confidence =
      evidenceState === "validated"
        ? clamp(candidate.confidence * 0.65 + validationStrength * 0.35, 0.7, 0.99)
        : Math.min(candidate.confidence * 0.75 + validationStrength * 0.25, 0.79);
    const validationReason =
      evidenceState === "validated"
        ? `Its pair graph recurred across ${Math.round(heldOutEdgeCoverage * 100)}% of possible edges in later unseen sessions.`
        : heldOutOccurrenceCount < minValidationOccurrences
          ? `Its pair graph recurred across ${Math.round(heldOutEdgeCoverage * 100)}% of possible edges, but the representative edge recurrence of ${heldOutOccurrenceCount} is below ${minValidationOccurrences}.`
          : `Its pair graph recurred across ${Math.round(heldOutEdgeCoverage * 100)}% of possible edges but did not meet the held-out pattern-quality floor.`;
    return {
      ...publicCandidate,
      evidence_state: evidenceState,
      confidence: round(confidence),
      occurrence_count: candidate.occurrence_count + heldOutOccurrenceCount,
      discovery_occurrence_count: candidate.occurrence_count,
      held_out_occurrence_count: heldOutOccurrenceCount,
      held_out_support: round(heldOutSupport),
      held_out_affinity: round(heldOutAffinity),
      held_out_edge_coverage: round(heldOutEdgeCoverage),
      held_out_sequence_consistency: null,
      reason: `${candidate.reason} ${validationReason}`,
    };
  } else {
    const projectSessionIds = [...heldOutIdsBySession.keys()].filter((sessionId) => {
      const cwd = rawSessionsById.get(sessionId)?.cwd?.trim();
      return Boolean(cwd && candidate.project_root && resolve(cwd) === candidate.project_root);
    });
    const counts = new Map(skillIds.map((id) => [id, 0]));
    for (const sessionId of projectSessionIds) {
      for (const id of heldOutIdsBySession.get(sessionId) ?? []) {
        if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    heldOutOccurrenceCount = Math.min(...counts.values());
    heldOutSupport =
      projectSessionIds.length > 0 ? heldOutOccurrenceCount / projectSessionIds.length : 0;
    validationStrength = heldOutSupport;
    meetsQualityFloor = heldOutSupport >= minAffinity;
  }

  if (heldOutOccurrenceCount === 0) return null;
  if (skillIds.length >= 3 && !meetsQualityFloor) return null;

  const evidenceState: SkillSetSuggestionEvidenceState =
    heldOutOccurrenceCount >= minValidationOccurrences && meetsQualityFloor
      ? "validated"
      : "supported";
  const confidence =
    evidenceState === "validated"
      ? clamp(candidate.confidence * 0.65 + validationStrength * 0.35, 0.7, 0.99)
      : Math.min(candidate.confidence * 0.75 + validationStrength * 0.25, 0.79);
  const validationReason =
    evidenceState === "validated"
      ? `Recurred in ${heldOutOccurrenceCount} later sessions and met the held-out validation floor.`
      : heldOutOccurrenceCount < minValidationOccurrences
        ? `Recurred in ${heldOutOccurrenceCount} later ${heldOutOccurrenceCount === 1 ? "session" : "sessions"}, below the recurrence floor of ${minValidationOccurrences}.`
        : `Recurred in ${heldOutOccurrenceCount} later sessions but did not meet the held-out pattern-quality floor.`;

  return {
    ...publicCandidate,
    evidence_state: evidenceState,
    confidence: round(confidence),
    occurrence_count: candidate.occurrence_count + heldOutOccurrenceCount,
    discovery_occurrence_count: candidate.occurrence_count,
    held_out_occurrence_count: heldOutOccurrenceCount,
    held_out_support: round(heldOutSupport),
    held_out_affinity: heldOutAffinity === null ? null : round(heldOutAffinity),
    held_out_edge_coverage: null,
    held_out_sequence_consistency:
      heldOutSequenceConsistency === null ? null : round(heldOutSequenceConsistency),
    reason: `${candidate.reason} ${validationReason}`,
  };
}

const PERMANENT_DISMISSAL_REASONS = new Set<SkillSetSuggestionReviewReasonCode>([
  "skills_should_remain_separate",
  "not_a_real_pattern",
  "already_have_workflow",
]);

export function suggestionWasHandled(
  candidate: SkillSetSuggestion,
  reviews: ReadonlyArray<SkillSetSuggestionReview>,
): boolean {
  return reviews.some((review) => {
    if (review.suggestion_id !== candidate.suggestion_id) return false;
    if (review.decision === "accepted" || review.decision === "edited") return true;
    if (PERMANENT_DISMISSAL_REASONS.has(review.reason_code)) return true;
    return review.evidence_fingerprint === candidate.evidence_fingerprint;
  });
}
