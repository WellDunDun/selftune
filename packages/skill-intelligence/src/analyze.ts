import { resolve } from "node:path";

import { classifySkillCategory as categoryForSkill } from "./classification.js";
import { discoverSkillSetSuggestions } from "./suggestions.js";
import { aggregateSkillIntelligenceObservations } from "./observation-groups.js";
import {
  SKILL_CATEGORY_LABELS,
  SKILL_INTELLIGENCE_ALGORITHM_VERSION,
  SKILL_INTELLIGENCE_EVIDENCE_VERSION,
  type SkillSetSuggestionReviewDecision,
} from "./contract.js";
import type {
  AnalyzeSkillIntelligenceInput,
  SkillClassification,
  SkillIntelligenceInstalledSkill,
  SkillIntelligenceObservationGroups,
  SkillIntelligenceReport,
  SkillIntelligenceTriggeredObservationRow,
} from "./types.js";
import { clamp } from "./internal/math.js";
import { suggestCatalogSkillSetExpansions } from "./catalog-expansion.js";
import { deriveSkillExecutionPatterns } from "./execution-patterns.js";

export {
  SKILL_CATEGORY_LABELS,
  SKILL_INTELLIGENCE_ALGORITHM_VERSION,
  SKILL_INTELLIGENCE_EVIDENCE_VERSION,
} from "./contract.js";
export type {
  SkillCategoryId,
  SkillClassificationOverride,
  SkillClassificationSource,
  SkillSetSuggestionReview,
  SkillSetSuggestionReviewDecision,
  SkillSetSuggestionReviewReasonCode,
} from "./contract.js";
export type {
  AnalyzeSkillIntelligenceInput,
  SkillClassification,
  SkillIntelligenceInstalledSkill,
  SkillIntelligenceReport,
  SkillSetSuggestion,
  SkillSetSuggestionEvidenceState,
  SkillSetSuggestionPattern,
  SkillSetSuggestionSkill,
} from "./types.js";

function skillId(name: string): string {
  return name.trim().toLowerCase();
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function skillScopeRank(scope: SkillIntelligenceInstalledSkill["skill_scope"]): number {
  return scope === "project" ? 2 : scope === "global" ? 1 : 0;
}

function preferredPackage(
  packages: ReadonlyArray<SkillIntelligenceInstalledSkill>,
  pathCounts: ReadonlyMap<string, number>,
): SkillIntelligenceInstalledSkill {
  return [...packages].toSorted((left, right) => {
    const observed =
      (pathCounts.get(resolve(right.skill_path)) ?? 0) -
      (pathCounts.get(resolve(left.skill_path)) ?? 0);
    if (observed !== 0) return observed;
    const scope = skillScopeRank(right.skill_scope) - skillScopeRank(left.skill_scope);
    if (scope !== 0) return scope;
    return right.modified_at.localeCompare(left.modified_at);
  })[0]!;
}

function normalizedSourceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const source = trimmed.replace(/\.git$/, "");
  const ssh = source.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  const https = source.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return (ssh?.[1] ?? https?.[1] ?? source).toLowerCase();
}

function selectSessionEvidence(
  groups: SkillIntelligenceObservationGroups,
  installedIds: ReadonlySet<string>,
): {
  orderedBySession: Map<string, SkillIntelligenceTriggeredObservationRow[]>;
  idsBySession: Map<string, string[]>;
} {
  const orderedBySession = new Map<string, SkillIntelligenceTriggeredObservationRow[]>();
  const idsBySession = new Map<string, string[]>();
  for (const [sessionId, rows] of groups.orderedBySession) {
    const selectedRows = rows.filter((row) => installedIds.has(skillId(row.skill_name)));
    if (selectedRows.length === 0) continue;
    orderedBySession.set(sessionId, selectedRows);
    idsBySession.set(
      sessionId,
      (groups.idsBySession.get(sessionId) ?? []).filter((id) => installedIds.has(id)),
    );
  }
  return { orderedBySession, idsBySession };
}

export function analyzeSkillIntelligence(
  input: AnalyzeSkillIntelligenceInput,
): SkillIntelligenceReport {
  const minOccurrences = Math.max(2, input.minOccurrences ?? 3);
  const minAffinity = clamp(input.minAffinity ?? 0.35, 0, 1);
  const holdoutRatio = clamp(input.holdoutRatio ?? 0.25, 0.1, 0.5);
  const minValidationOccurrences = Math.max(1, input.minValidationOccurrences ?? 2);
  const minEvidenceScore = clamp(input.minEvidenceScore ?? 0, 0, 1);
  const maxSuggestions = Math.max(1, input.maxSuggestions ?? 6);
  const packagesById = new Map<string, SkillIntelligenceInstalledSkill[]>();
  for (const skill of input.installedSkills) {
    const id = skillId(skill.name);
    const packages = packagesById.get(id);
    if (packages) packages.push(skill);
    else packagesById.set(id, [skill]);
  }
  const activePackagesById = new Map(
    [...packagesById]
      .map(([id, packages]) => [id, packages.filter((skill) => skill.active !== false)] as const)
      .filter(([, packages]) => packages.length > 0),
  );
  const activeIds = new Set(activePackagesById.keys());
  const suggestionPackagesById = new Map(
    [...activePackagesById]
      .filter(([id]) => id !== "selftune")
      .map(
        ([id, packages]) =>
          [
            id,
            packages.filter(
              (skill) => skill.skill_scope !== "admin" && skill.skill_scope !== "system",
            ),
          ] as const,
      )
      .filter(([, packages]) => packages.length > 0),
  );
  const suggestionIds = new Set(suggestionPackagesById.keys());
  const observationGroups =
    input.observationGroups ?? aggregateSkillIntelligenceObservations(input.observations ?? []);
  const triggeredObservations = observationGroups.triggeredObservations.filter((row) =>
    packagesById.has(skillId(row.skill_name)),
  );
  const pathCounts = new Map<string, number>();
  for (const id of packagesById.keys()) {
    for (const [path, count] of observationGroups.bySkillId.get(id)?.skill_paths ?? []) {
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + count);
    }
  }
  const preferredById = new Map(
    [...packagesById].map(
      ([id, packages]) =>
        [id, preferredPackage(activePackagesById.get(id) ?? packages, pathCounts)] as const,
    ),
  );
  const suggestionPreferredById = new Map(
    [...suggestionPackagesById].map(
      ([id, packages]) => [id, preferredPackage(packages, pathCounts)] as const,
    ),
  );
  const suggestionSourceById = new Map(
    [...suggestionPreferredById].map(([id, skill]) => [id, normalizedSourceId(skill.source_id)]),
  );
  const { orderedBySession, idsBySession } = selectSessionEvidence(
    observationGroups,
    suggestionIds,
  );
  const rawSessionsById = new Map(input.sessions.map((session) => [session.session_id, session]));
  const classificationOverrides = new Map(
    (input.classificationOverrides ?? []).map((override) => [skillId(override.skill_id), override]),
  );

  const coUsage = new Map<string, Map<string, number>>();
  for (const ids of idsBySession.values()) {
    for (const id of ids) {
      const peers = coUsage.get(id) ?? new Map<string, number>();
      for (const peer of ids) {
        if (peer !== id) peers.set(peer, (peers.get(peer) ?? 0) + 1);
      }
      coUsage.set(id, peers);
    }
  }

  const classifications = [...packagesById.entries()]
    .map(([id, packages]): SkillClassification => {
      const observationGroup = observationGroups.bySkillId.get(id);
      const queryTexts = observationGroup?.query_texts ?? [];
      const preferred = preferredById.get(id)!;
      const category = categoryForSkill(
        preferred.name,
        [...new Set(packages.map((skill) => skill.content))],
        queryTexts,
      );
      const peers = [...(coUsage.get(id)?.entries() ?? [])]
        .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 4)
        .map(([peer]) => preferredById.get(peer)?.name ?? peer);
      const override = classificationOverrides.get(id);
      return {
        skill_id: id,
        skill_name: preferred.name,
        category: override?.category ?? category.category,
        inferred_category: category.category,
        category_label: SKILL_CATEGORY_LABELS[override?.category ?? category.category],
        source: override ? "human" : "inferred",
        confidence: override ? 1 : category.confidence,
        reason: override
          ? `Assigned to ${SKILL_CATEGORY_LABELS[override.category]} by you.`
          : category.reason,
        override_reason: override?.reason ?? null,
        overridden_at: override?.updated_at ?? null,
        matched_terms: category.matched_terms,
        observed_queries: observationGroup?.distinct_normalized_query_count ?? 0,
        co_used_with: peers,
      };
    })
    .toSorted((left, right) => left.skill_name.localeCompare(right.skill_name));
  const classificationById = new Map(classifications.map((value) => [value.skill_id, value]));

  const suggestionDiscovery = discoverSkillSetSuggestions({
    evidence: {
      orderedBySession,
      idsBySession,
      triggeredObservations,
      sessionsById: rawSessionsById,
    },
    catalog: {
      ids: suggestionIds,
      preferredById: suggestionPreferredById,
      packagesById: suggestionPackagesById,
      sourceById: suggestionSourceById,
      classificationById,
    },
    thresholds: {
      minOccurrences,
      minAffinity,
      holdoutRatio,
      minValidationOccurrences,
      minEvidenceScore,
      maxSuggestions,
    },
    existingSets: input.existingSets ?? [],
    reviews: input.suggestionReviews ?? [],
  });

  const reviewCounts: Record<SkillSetSuggestionReviewDecision, number> = {
    accepted: 0,
    edited: 0,
    dismissed: 0,
  };
  for (const review of input.suggestionReviews ?? []) reviewCounts[review.decision] += 1;
  const executionEvidence = deriveSkillExecutionPatterns({
    installedSkills: [...activePackagesById.keys()].map((id) => preferredById.get(id)!),
    traceSignals: input.traceSignals,
  });

  return {
    algorithm_version: SKILL_INTELLIGENCE_ALGORITHM_VERSION,
    evidence_version: SKILL_INTELLIGENCE_EVIDENCE_VERSION,
    generated_at: (input.now ?? new Date()).toISOString(),
    sessions_analyzed: idsBySession.size,
    installed_skills: activeIds.size,
    classified_skills: packagesById.size,
    thresholds: {
      min_occurrences: minOccurrences,
      min_affinity: round(minAffinity),
      holdout_ratio: round(holdoutRatio),
      min_validation_occurrences: minValidationOccurrences,
      min_evidence_score: round(minEvidenceScore),
    },
    validation: suggestionDiscovery.validation,
    feedback: {
      classification_overrides: classificationOverrides.size,
      suggestion_reviews: reviewCounts,
      calibration: input.calibration ?? {
        algorithm_version: SKILL_INTELLIGENCE_ALGORITHM_VERSION,
        status: "insufficient_evidence",
        minimum_labeled_reviews: 20,
        labeled_reviews: 0,
        positive_labels: 0,
        negative_labels: 0,
        total_reviews: 0,
        acceptance_rate: 0,
        exact_acceptance_rate: 0,
        edit_rate: 0,
        mean_edit_distance: null,
        dismissal_reasons: {},
        category_corrections: 0,
        applied_min_evidence_score: 0,
        balanced_accuracy: null,
      },
    },
    classifications,
    suggestions: suggestionDiscovery.suggestions,
    catalog_expansions: suggestCatalogSkillSetExpansions({
      installed_skills: input.installedSkills
        .filter((skill) => skill.active !== false)
        .map((skill) => ({
          name: skill.name,
          package_path: skill.package_path,
          source_id: skill.source_id,
          content: skill.content,
          harness: skill.harness,
        })),
      catalog_entries: input.catalogEntries ?? [],
      project_signals: input.projectSignals ?? {},
    }),
    outcomes: [...(input.outcomes ?? [])],
    ...executionEvidence,
  };
}
