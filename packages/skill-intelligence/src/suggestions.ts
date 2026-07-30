import { basename, resolve } from "node:path";

import {
  SKILL_CATEGORY_LABELS,
  type SkillCategoryId,
  type SkillSetSuggestionReview,
} from "./contract.js";
import {
  discoverOverlappingCommunities,
  evidenceFingerprint,
  existingSkillSetKeys,
  hasSingleKnownSource,
  partitionTemporalEvidence,
  stableEvidenceId,
  suggestionWasHandled,
  validateSuggestionCandidate,
  wilsonLowerBound,
  type CoUsageEdge,
  type SkillSetSuggestionDiscoveryCandidate,
} from "./evidence.js";
import type {
  SkillClassification,
  SkillIntelligenceInstalledSkill,
  SkillSetSuggestion,
  SkillSetSuggestionEvidenceState,
  SkillSetSuggestionPattern,
  SkillSetSuggestionSkill,
} from "./types.js";
import type {
  SessionTelemetryRecord,
  SkillIntelligenceSessionRow,
  SkillIntelligenceTriggeredObservationRow,
  SkillSetHarnessId,
  SkillSetManifest,
  SkillUsageRecord,
} from "./types.js";
import { clamp } from "./internal/math.js";
import { discoverWorkflows } from "./workflow-discovery.js";

function skillId(name: string): string {
  return name.trim().toLowerCase();
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function displayName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_:/.\s]+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function inferredHarnesses(
  packages: ReadonlyArray<SkillIntelligenceInstalledSkill>,
): SkillSetHarnessId[] {
  return [
    ...new Set(packages.flatMap((skill) => (skill.harness ? [skill.harness] : []))),
  ].toSorted();
}

function suggestionName(
  pattern: SkillSetSuggestionPattern,
  names: ReadonlyArray<string>,
  projectRoot: string | null,
  categories: ReadonlyArray<SkillCategoryId>,
): string {
  if (pattern === "project" && projectRoot) return `${displayName(basename(projectRoot))} Toolkit`;
  if (names.length === 2) return `${displayName(names[0]!)} + ${displayName(names[1]!)}`;
  const firstCategory = categories[0];
  if (firstCategory && categories.every((category) => category === firstCategory)) {
    return `${SKILL_CATEGORY_LABELS[firstCategory]} Toolkit`;
  }
  return pattern === "workflow" ? "Observed Skill Workflow" : "Cross-Disciplinary Toolkit";
}

function normalizedSemanticText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function skillIntentText(skill: SkillIntelligenceInstalledSkill): string {
  const description = skill.content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
  return normalizedSemanticText(`${skill.name} ${description}`);
}

function communityMembershipRole(
  id: string,
  catalog: SkillSuggestionCatalog,
  peerCount: number,
  possiblePeers: number,
): string {
  const skill = catalog.preferredById.get(id)!;
  const intent = skillIntentText(skill);
  const category = catalog.classificationById.get(id)?.category ?? "general";
  const evidence = `Evidence-backed links connect it to ${peerCount} of ${possiblePeers} peers.`;
  if (/\b(trace|diagnose|diagnostic|debug|failure|incident|root cause)\b/.test(intent)) {
    return `Provides failure analysis and debugging for the workflow. ${evidence}`;
  }
  if (/\b(wrangler|deploy|deployment|release|ci|operations|command line|cli)\b/.test(intent)) {
    return `Provides development and deployment operations. ${evidence}`;
  }
  if (/\b(cloudflare|cloud platform|workers|serverless|edge runtime)\b/.test(intent)) {
    return `Provides platform architecture and runtime guidance. ${evidence}`;
  }
  if (/\b(tdd|test driven|testing|regression|quality assurance)\b/.test(intent)) {
    return `Provides regression testing and quality control. ${evidence}`;
  }
  if (/\b(review|audit|thermonuclear)\b/.test(intent)) {
    return `Provides rigorous review and risk discovery. ${evidence}`;
  }
  if (/\b(domain model|domain modeling|codebase design|architecture|boundaries)\b/.test(intent)) {
    return `Provides architecture and domain-boundary modeling. ${evidence}`;
  }
  if (/\b(mobile|flutter|dart|ios|android|simulator|cross platform)\b/.test(intent)) {
    return `Provides cross-platform mobile implementation. ${evidence}`;
  }
  if (/\b(frontend|react|interface|ui|shadcn)\b/.test(intent)) {
    return `Provides frontend interface implementation. ${evidence}`;
  }
  return `Provides ${SKILL_CATEGORY_LABELS[category].toLowerCase()} capability. ${evidence}`;
}

function sourceDisplayName(source: string): string {
  const parts = source.split("/").filter(Boolean);
  const repository = parts.at(-1) ?? source;
  const base = /^(skills?|agent-skills?)$/i.test(repository)
    ? (parts.at(-2) ?? repository)
    : repository;
  return displayName(base);
}

function semanticMatchCount(
  ids: ReadonlyArray<string>,
  catalog: SkillSuggestionCatalog,
  expression: RegExp,
): number {
  return ids.filter((id) => {
    const skill = catalog.preferredById.get(id);
    return skill
      ? expression.test(normalizedSemanticText(`${skill.name} ${skill.content.slice(0, 2_000)}`))
      : false;
  }).length;
}

function communitySuggestionName(
  ids: ReadonlyArray<string>,
  catalog: SkillSuggestionCatalog,
): string {
  const mobileSignals = semanticMatchCount(
    ids,
    catalog,
    /\b(mobile|flutter|dart|ios|android|simulator|cross platform|react native|swift|kotlin)\b/,
  );
  if (mobileSignals >= 2) return "Cross-Platform Mobile";

  const sourceCounts = new Map<string, number>();
  for (const id of ids) {
    const source = catalog.sourceById.get(id);
    if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  const dominantSource = [...sourceCounts]
    .filter(([, count]) => count >= 2 && count / ids.length >= 0.4)
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  const platformSignals = semanticMatchCount(
    ids,
    catalog,
    /\b(cloud platform|cloudflare|wrangler|workers|serverless|edge runtime|infrastructure)\b/,
  );
  if (platformSignals >= 2 && dominantSource) {
    return `${sourceDisplayName(dominantSource)} Engineering`;
  }

  const reviewSignals = semanticMatchCount(
    ids,
    catalog,
    /\b(review|diagnose|diagnostic|debug|tdd|test driven|testing|quality|audit|failure analysis|codebase design)\b/,
  );
  if (reviewSignals >= 2) return "High-Rigor Review";

  if (dominantSource) return `${sourceDisplayName(dominantSource)} Engineering`;

  const categories = ids.map((id) => catalog.classificationById.get(id)?.category ?? "general");
  const categoryCounts = new Map<SkillCategoryId, number>();
  for (const category of categories) {
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const dominantCategory = [...categoryCounts].toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
  return dominantCategory && (categoryCounts.get(dominantCategory) ?? 0) > ids.length / 2
    ? `${SKILL_CATEGORY_LABELS[dominantCategory]} Toolkit`
    : "Cross-Disciplinary Toolkit";
}

function aggregateHarnesses(
  ids: ReadonlyArray<string>,
  packagesById: ReadonlyMap<string, ReadonlyArray<SkillIntelligenceInstalledSkill>>,
): SkillSetHarnessId[] {
  return [
    ...new Set(ids.flatMap((id) => inferredHarnesses(packagesById.get(id) ?? []))),
  ].toSorted();
}

export interface SkillSuggestionEvidence {
  orderedBySession: ReadonlyMap<string, ReadonlyArray<SkillIntelligenceTriggeredObservationRow>>;
  idsBySession: ReadonlyMap<string, ReadonlyArray<string>>;
  triggeredObservations: ReadonlyArray<SkillIntelligenceTriggeredObservationRow>;
  sessionsById: ReadonlyMap<string, SkillIntelligenceSessionRow>;
}

export interface SkillSuggestionCatalog {
  ids: ReadonlySet<string>;
  preferredById: ReadonlyMap<string, SkillIntelligenceInstalledSkill>;
  packagesById: ReadonlyMap<string, ReadonlyArray<SkillIntelligenceInstalledSkill>>;
  sourceById: ReadonlyMap<string, string | null>;
  classificationById: ReadonlyMap<string, SkillClassification>;
}

export interface SkillSuggestionThresholds {
  minOccurrences: number;
  minAffinity: number;
  holdoutRatio: number;
  minValidationOccurrences: number;
  minEvidenceScore: number;
  maxSuggestions: number;
}

export interface DiscoverSkillSetSuggestionsInput {
  evidence: SkillSuggestionEvidence;
  catalog: SkillSuggestionCatalog;
  thresholds: SkillSuggestionThresholds;
  existingSets: ReadonlyArray<SkillSetManifest>;
  reviews: ReadonlyArray<SkillSetSuggestionReview>;
}

export interface SkillSetSuggestionDiscoveryResult {
  suggestions: SkillSetSuggestion[];
  validation: {
    ready: boolean;
    discovery_sessions: number;
    held_out_sessions: number;
    cutoff_at: string | null;
  };
}

export function discoverSkillSetSuggestions(
  input: DiscoverSkillSetSuggestionsInput,
): SkillSetSuggestionDiscoveryResult {
  const { evidence, catalog, thresholds } = input;
  const partition = partitionTemporalEvidence(
    evidence.idsBySession,
    evidence.orderedBySession,
    evidence.sessionsById,
    thresholds.minOccurrences,
    thresholds.minValidationOccurrences,
    thresholds.holdoutRatio,
  );
  const discoveryIdsBySession = new Map(
    [...evidence.idsBySession].filter(([sessionId]) =>
      partition.discoverySessionIds.has(sessionId),
    ),
  );
  const heldOutIdsBySession = new Map(
    [...evidence.idsBySession].filter(([sessionId]) => partition.heldOutSessionIds.has(sessionId)),
  );
  const discoveryOrderedBySession = new Map(
    [...evidence.orderedBySession].filter(([sessionId]) =>
      partition.discoverySessionIds.has(sessionId),
    ),
  );
  const discoveryTriggeredObservations = evidence.triggeredObservations.filter((row) =>
    partition.discoverySessionIds.has(row.session_id),
  );
  const sanitizedSessions: SessionTelemetryRecord[] = [...discoveryIdsBySession].map(
    ([sessionId, ids]) => {
      const source = evidence.sessionsById.get(sessionId);
      return {
        timestamp:
          source?.timestamp ??
          discoveryOrderedBySession.get(sessionId)?.at(-1)?.occurred_at ??
          new Date(0).toISOString(),
        session_id: sessionId,
        cwd: source?.cwd ?? "",
        transcript_path: "",
        tool_calls: {},
        total_tool_calls: 0,
        bash_commands: [],
        skills_triggered: ids.map((id) => catalog.preferredById.get(id)!.name),
        skills_invoked: ids.map((id) => catalog.preferredById.get(id)!.name),
        assistant_turns: 0,
        errors_encountered: source?.errors_encountered ?? 0,
        transcript_chars: 0,
        last_user_query: source?.last_user_query ?? "",
      };
    },
  );
  const workflowUsage: SkillUsageRecord[] = discoveryTriggeredObservations.flatMap((row) => {
    const preferred = catalog.preferredById.get(skillId(row.skill_name));
    if (!preferred) return [];
    return [
      {
        timestamp: row.occurred_at ?? "",
        session_id: row.session_id,
        skill_name: preferred.name,
        skill_path: row.skill_path ?? preferred.skill_path,
        query: row.query_text,
        triggered: true,
        invocation_type:
          row.invocation_mode === "explicit" ||
          row.invocation_mode === "implicit" ||
          row.invocation_mode === "inferred" ||
          row.invocation_mode === "contextual"
            ? row.invocation_mode
            : undefined,
      },
    ];
  });
  const candidates: SkillSetSuggestionDiscoveryCandidate[] = [];
  const makeSkills = (
    ids: ReadonlyArray<string>,
    memberships?: ReadonlyMap<string, { score: number; role: string }>,
  ): SkillSetSuggestionSkill[] =>
    ids.map((id) => {
      const category = catalog.classificationById.get(id)?.category ?? "general";
      const membership = memberships?.get(id);
      return {
        name: catalog.preferredById.get(id)!.name,
        package_path: catalog.preferredById.get(id)!.package_path,
        category,
        role:
          membership?.role ??
          `Provides ${SKILL_CATEGORY_LABELS[category].toLowerCase()} capability in this set.`,
        source_id: catalog.sourceById.get(id) ?? null,
        membership_score: round(membership?.score ?? 0.5),
      };
    });

  const workflows = discoverWorkflows(sanitizedSessions, workflowUsage, {
    minOccurrences: thresholds.minOccurrences,
  });
  for (const workflow of workflows.workflows) {
    const ids = [...new Set(workflow.skills.map(skillId).filter((id) => catalog.ids.has(id)))];
    if (ids.length < 2 || ids.length > 6) continue;
    if (ids.length === 2 && hasSingleKnownSource(ids, catalog.sourceById)) continue;
    const skills = makeSkills(
      ids,
      new Map(
        ids.map((id, index) => [
          id,
          {
            score: clamp(0.65 + workflow.sequence_consistency * 0.25, 0, 0.99),
            role: `Step ${index + 1} of ${ids.length} in the observed workflow.`,
          },
        ]),
      ),
    );
    const confidence = clamp(
      0.45 +
        Math.min(workflow.occurrence_count / (thresholds.minOccurrences * 4), 0.2) +
        workflow.sequence_consistency * 0.2 +
        Math.max(workflow.synergy_score, 0) * 0.15,
      0,
      0.99,
    );
    candidates.push({
      suggestion_id: `workflow-${stableEvidenceId(ids.join("->"))}`,
      name: suggestionName(
        "workflow",
        skills.map((skill) => skill.name),
        null,
        skills.map((skill) => skill.category),
      ),
      description: `An ordered workflow observed in ${workflow.occurrence_count} trusted sessions.`,
      pattern: "workflow",
      skills,
      harnesses: aggregateHarnesses(ids, catalog.packagesById),
      project_root: null,
      confidence: round(confidence),
      occurrence_count: workflow.occurrence_count,
      support: round(workflow.completion_rate),
      affinity: null,
      discovery_edge_coverage: null,
      sequence_consistency: round(workflow.sequence_consistency),
      synergy_score: round(workflow.synergy_score),
      reason: `${skills.map((skill) => skill.name).join(" -> ")} repeated with ${Math.round(workflow.sequence_consistency * 100)}% ordering consistency.`,
    });
  }

  const sessionCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const ids of discoveryIdsBySession.values()) {
    for (const id of ids) sessionCounts.set(id, (sessionCounts.get(id) ?? 0) + 1);
    for (let left = 0; left < ids.length; left++) {
      for (let right = left + 1; right < ids.length; right++) {
        const key = [ids[left]!, ids[right]!].toSorted().join("\u0000");
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const coUsageEdges: CoUsageEdge[] = [];
  for (const [key, occurrenceCount] of pairCounts) {
    if (occurrenceCount < thresholds.minOccurrences) continue;
    const ids = key.split("\u0000");
    const leftCount = sessionCounts.get(ids[0]!) ?? 0;
    const rightCount = sessionCounts.get(ids[1]!) ?? 0;
    const union = leftCount + rightCount - occurrenceCount;
    const affinity = union > 0 ? occurrenceCount / union : 0;
    if (affinity < thresholds.minAffinity) continue;
    const support =
      discoveryIdsBySession.size > 0 ? occurrenceCount / discoveryIdsBySession.size : 0;
    const lift =
      leftCount > 0 && rightCount > 0
        ? (occurrenceCount * discoveryIdsBySession.size) / (leftCount * rightCount)
        : 0;
    const affinityLowerBound = wilsonLowerBound(occurrenceCount, union);
    const score =
      affinity * 0.4 +
      affinityLowerBound * 0.25 +
      Math.min(lift / 2, 1) * 0.2 +
      Math.min(occurrenceCount / (thresholds.minOccurrences * 2), 1) * 0.15;
    coUsageEdges.push({
      key,
      left: ids[0]!,
      right: ids[1]!,
      occurrenceCount,
      support,
      affinity,
      affinityLowerBound,
      lift,
      score,
    });
  }

  const communities = discoverOverlappingCommunities(
    coUsageEdges,
    discoveryIdsBySession,
    catalog.sourceById,
    thresholds.minOccurrences,
    thresholds.minAffinity,
  );
  for (const community of communities) {
    const skills = makeSkills(
      community.ids,
      new Map(
        community.ids.map((id) => {
          const membership = community.memberships.get(id)!;
          const peerCount = Math.round(membership.edgeCoverage * (community.ids.length - 1));
          return [
            id,
            {
              score: membership.score,
              role: communityMembershipRole(id, catalog, peerCount, community.ids.length - 1),
            },
          ];
        }),
      ),
    );
    const confidence = clamp(0.35 + community.score * 0.5 + skills.length * 0.025, 0, 0.99);
    candidates.push({
      suggestion_id: `co-usage-set-${stableEvidenceId(community.ids.join("\u0000"))}`,
      name: communitySuggestionName(community.ids, catalog),
      description: `An overlapping skill community supported by ${Math.round(community.edgeCoverage * 100)}% of its possible pair links.`,
      pattern: "co_usage",
      skills,
      harnesses: aggregateHarnesses(community.ids, catalog.packagesById),
      project_root: null,
      confidence: round(confidence),
      occurrence_count: community.occurrenceCount,
      support: round(community.support),
      affinity: round(community.affinity),
      discovery_edge_coverage: round(community.edgeCoverage),
      sequence_consistency: null,
      synergy_score: null,
      reason: `${skills.length} skills formed a dense pair graph with ${Math.round(community.edgeCoverage * 100)}% edge coverage, ${Math.round(community.affinity * 100)}% mean pair affinity, and ${round(community.meanLift)}x mean lift. No single session needed to contain the full set.`,
      discovery_edge_keys: community.edgeKeys,
    });
  }

  for (const edge of coUsageEdges) {
    const ids = [edge.left, edge.right];
    if (hasSingleKnownSource(ids, catalog.sourceById)) continue;
    const skills = makeSkills(
      ids,
      new Map(
        ids.map((id) => [
          id,
          {
            score: edge.score,
            role: `Pairs with ${catalog.preferredById.get(id === edge.left ? edge.right : edge.left)!.name} in repeated sessions.`,
          },
        ]),
      ),
    );
    candidates.push({
      suggestion_id: `co-usage-${stableEvidenceId(edge.key)}`,
      name: suggestionName(
        "co_usage",
        skills.map((skill) => skill.name),
        null,
        skills.map((skill) => skill.category),
      ),
      description: `An observed pairing used together in ${edge.occurrenceCount} trusted sessions.`,
      pattern: "co_usage",
      skills,
      harnesses: aggregateHarnesses(ids, catalog.packagesById),
      project_root: null,
      confidence: round(clamp(0.4 + edge.score * 0.6, 0, 0.99)),
      occurrence_count: edge.occurrenceCount,
      support: round(edge.support),
      affinity: round(edge.affinity),
      discovery_edge_coverage: 1,
      sequence_consistency: null,
      synergy_score: null,
      reason: `${Math.round(edge.affinity * 100)}% Jaccard affinity (${Math.round(edge.affinityLowerBound * 100)}% lower bound) with ${round(edge.lift)}x lift.`,
      discovery_edge_keys: [edge.key],
    });
  }

  const projectSessions = new Map<string, string[]>();
  for (const [sessionId] of discoveryIdsBySession) {
    const cwd = evidence.sessionsById.get(sessionId)?.cwd?.trim();
    if (!cwd) continue;
    const projectRoot = resolve(cwd);
    const sessions = projectSessions.get(projectRoot);
    if (sessions) sessions.push(sessionId);
    else projectSessions.set(projectRoot, [sessionId]);
  }
  for (const [projectRoot, sessionIds] of projectSessions) {
    if (sessionIds.length < thresholds.minOccurrences) continue;
    const counts = new Map<string, number>();
    for (const sessionId of sessionIds) {
      for (const id of discoveryIdsBySession.get(sessionId) ?? []) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const eligible = [...counts]
      .filter(
        ([, count]) =>
          count >= thresholds.minOccurrences && count / sessionIds.length >= thresholds.minAffinity,
      )
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5);
    if (eligible.length < 2) continue;
    const ids = eligible.map(([id]) => id);
    if (ids.length === 2 && hasSingleKnownSource(ids, catalog.sourceById)) continue;
    const occurrenceCount = Math.min(...eligible.map(([, count]) => count));
    const support = occurrenceCount / sessionIds.length;
    const skills = makeSkills(
      ids,
      new Map(
        eligible.map(([id, count]) => [
          id,
          {
            score: count / sessionIds.length,
            role: `Recurring ${SKILL_CATEGORY_LABELS[catalog.classificationById.get(id)?.category ?? "general"].toLowerCase()} capability for this project.`,
          },
        ]),
      ),
    );
    const confidence = clamp(
      0.4 + support * 0.4 + Math.min(sessionIds.length / (thresholds.minOccurrences * 3), 1) * 0.2,
      0,
      0.99,
    );
    candidates.push({
      suggestion_id: `project-${stableEvidenceId(`${projectRoot}\u0000${ids.toSorted().join("\u0000")}`)}`,
      name: suggestionName(
        "project",
        skills.map((skill) => skill.name),
        projectRoot,
        skills.map((skill) => skill.category),
      ),
      description: `A project toolkit inferred from ${sessionIds.length} trusted sessions in ${projectRoot}.`,
      pattern: "project",
      skills,
      harnesses: aggregateHarnesses(ids, catalog.packagesById),
      project_root: projectRoot,
      confidence: round(confidence),
      occurrence_count: occurrenceCount,
      support: round(support),
      affinity: null,
      discovery_edge_coverage: null,
      sequence_consistency: null,
      synergy_score: null,
      reason: `Every included skill appeared in at least ${Math.round(support * 100)}% of this project's observed sessions.`,
    });
  }

  const validatedCandidates = candidates.flatMap((candidate) => {
    const validated = validateSuggestionCandidate(
      candidate,
      partition,
      heldOutIdsBySession,
      evidence.sessionsById,
      thresholds.minAffinity,
      thresholds.minValidationOccurrences,
    );
    return validated && validated.confidence >= thresholds.minEvidenceScore ? [validated] : [];
  });
  const validatedCommunitySets = validatedCandidates
    .filter((candidate) => candidate.pattern === "co_usage" && candidate.skills.length >= 3)
    .map((candidate) => new Set(candidate.skills.map((skill) => skillId(skill.name))));
  const visibleCandidates = validatedCandidates.filter((candidate) => {
    if (candidate.pattern !== "co_usage" || candidate.skills.length !== 2) return true;
    const ids = candidate.skills.map((skill) => skillId(skill.name));
    return !validatedCommunitySets.some((community) => ids.every((id) => community.has(id)));
  });
  const patternRank: Record<SkillSetSuggestionPattern, number> = {
    workflow: 3,
    co_usage: 2,
    project: 1,
  };
  const evidenceRank: Record<SkillSetSuggestionEvidenceState, number> = {
    validated: 3,
    supported: 2,
    exploratory: 1,
  };
  const existingKeys = existingSkillSetKeys(input.existingSets);
  const selected = new Map<string, SkillSetSuggestion>();
  const consideredKeys = new Set<string>();
  for (const candidate of visibleCandidates.toSorted(
    (left, right) =>
      evidenceRank[right.evidence_state] - evidenceRank[left.evidence_state] ||
      patternRank[right.pattern] - patternRank[left.pattern] ||
      right.skills.length - left.skills.length ||
      right.confidence - left.confidence ||
      right.occurrence_count - left.occurrence_count,
  )) {
    const suggestion: SkillSetSuggestion = {
      ...candidate,
      evidence_fingerprint: evidenceFingerprint(candidate),
    };
    const key = candidate.skills
      .map((skill) => skillId(skill.name))
      .toSorted()
      .join("\u0000");
    if (consideredKeys.has(key)) continue;
    consideredKeys.add(key);
    if (existingKeys.has(key) || suggestionWasHandled(suggestion, input.reviews)) continue;
    selected.set(key, suggestion);
  }

  return {
    suggestions: [...selected.values()].slice(0, thresholds.maxSuggestions),
    validation: {
      ready: partition.ready,
      discovery_sessions: discoveryIdsBySession.size,
      held_out_sessions: heldOutIdsBySession.size,
      cutoff_at: partition.cutoffAt,
    },
  };
}
