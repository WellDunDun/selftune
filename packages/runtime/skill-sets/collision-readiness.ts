import { analyzeComposabilityV2 } from "../eval/composability-v2.js";
import { analyzeSkillFamilyOverlap } from "../eval/family-overlap.js";
import type {
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillFamilyColdStartPair,
  SkillFamilyOverlapPair,
  SkillUsageRecord,
} from "../types.js";

export type SkillSetCollisionReadiness = "ready" | "needs_evidence" | "collision_risk";

export interface SkillSetCollisionEvidence {
  readonly kind: "trusted_routing_overlap" | "observed_runtime_conflict";
  readonly skill_a: string;
  readonly skill_b: string;
  readonly summary: string;
}

export interface SkillSetCollisionAdvisory {
  readonly kind: "static_surface_similarity";
  readonly skill_a: string;
  readonly skill_b: string;
  readonly summary: string;
}

export interface SkillSetCollisionReadinessReport {
  readonly readiness: SkillSetCollisionReadiness;
  readonly skill_names: readonly string[];
  readonly blocking_evidence: readonly SkillSetCollisionEvidence[];
  readonly advisories: readonly SkillSetCollisionAdvisory[];
  readonly evidence_gaps: readonly string[];
  readonly checked_at: string;
}

export interface SkillSetCollisionReadinessInput {
  readonly skillNames: readonly string[];
  readonly telemetry: readonly SessionTelemetryRecord[];
  readonly usage: readonly SkillUsageRecord[];
  readonly queries: readonly QueryLogRecord[];
  readonly searchDirs?: readonly string[];
}

function routingOverlapEvidence(pair: SkillFamilyOverlapPair): SkillSetCollisionEvidence {
  return {
    kind: "trusted_routing_overlap",
    skill_a: pair.skill_a,
    skill_b: pair.skill_b,
    summary: `${pair.shared_query_count} trusted positive queries overlap (${Math.round(pair.overlap_pct * 100)}%).`,
  };
}

function staticAdvisory(pair: SkillFamilyColdStartPair): SkillSetCollisionAdvisory {
  return {
    kind: "static_surface_similarity",
    skill_a: pair.skill_a,
    skill_b: pair.skill_b,
    summary:
      "Skill descriptions or routing surfaces look similar. This is a prompt to run routing checks, not proof of a collision.",
  };
}

export function checkSkillSetCollisionReadiness(
  input: SkillSetCollisionReadinessInput,
): SkillSetCollisionReadinessReport {
  const skillNames = [...new Set(input.skillNames.map((name) => name.trim()).filter(Boolean))];
  if (skillNames.length < 2) {
    throw new Error("Skill Set collision readiness requires at least two distinct skills.");
  }

  const family = analyzeSkillFamilyOverlap(skillNames, [...input.usage], [...input.queries], {
    searchDirs: input.searchDirs ? [...input.searchDirs] : undefined,
  });
  const blockingEvidence: SkillSetCollisionEvidence[] = family.pairs.map(routingOverlapEvidence);

  const seenRuntimePairs = new Set<string>();
  for (const skillName of skillNames) {
    const composability = analyzeComposabilityV2(skillName, [...input.telemetry], [...input.usage]);
    for (const pair of composability.pairs) {
      if (!pair.conflict_detected || !skillNames.includes(pair.skill_b)) continue;
      const pairKey = [pair.skill_a, pair.skill_b].sort().join("\u0000");
      if (seenRuntimePairs.has(pairKey)) continue;
      seenRuntimePairs.add(pairKey);
      blockingEvidence.push({
        kind: "observed_runtime_conflict",
        skill_a: pair.skill_a,
        skill_b: pair.skill_b,
        summary: `${pair.co_occurrence_count} observed co-occurrences had worse outcomes together (synergy ${pair.synergy_score.toFixed(2)}).`,
      });
    }
  }

  const advisories = (family.cold_start_suspicion?.pairs ?? []).map(staticAdvisory);
  const evidenceGaps = family.members
    .filter((member) => member.positive_query_count < 2)
    .map(
      (member) =>
        `${member.skill_name} has fewer than two trusted positive routing examples; collect or run routing evals before rollout.`,
    );

  return {
    readiness:
      blockingEvidence.length > 0
        ? "collision_risk"
        : evidenceGaps.length > 0
          ? "needs_evidence"
          : "ready",
    skill_names: skillNames,
    blocking_evidence: blockingEvidence,
    advisories,
    evidence_gaps: evidenceGaps,
    checked_at: new Date().toISOString(),
  };
}
