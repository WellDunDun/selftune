import type {
  LibraryInventoryModel,
  LibraryMergeConnectionModel,
  LibraryPrepareMergeInput,
  LibrarySourceModel,
  SkillContextEntry,
} from "@selftune/dashboard-core/models";
import { recommendLibraryConsolidation } from "@selftune/control-plane/library-consolidation";

import type {
  HarnessConnection,
  LibrarySnapshot,
  PortfolioResponse,
  AnalyticsResponse,
  SkillCategoryId,
  SkillIntelligenceReport,
} from "./types";

const LOCAL_LIBRARY_CATEGORY_LABELS: Record<SkillCategoryId, string> = {
  software_development: "Software Development",
  testing_quality: "Testing & Quality",
  data_ai: "Data & AI",
  research: "Research",
  writing_content: "Writing & Content",
  design: "Design",
  product_business: "Product & Business",
  operations_automation: "Operations & Automation",
  communication: "Communication",
  security: "Security",
  agent_tooling: "Agent Tooling",
  general: "General",
};

const LOCAL_LIBRARY_CATEGORY_OPTIONS = Object.entries(LOCAL_LIBRARY_CATEGORY_LABELS).map(
  ([id, label]) => ({ id, label }),
);

export function isLocalSkillCategoryId(value: string): value is SkillCategoryId {
  return Object.hasOwn(LOCAL_LIBRARY_CATEGORY_LABELS, value);
}

export function connectionNames(
  harnesses: readonly HarnessConnection[],
): ReadonlyMap<string, string> {
  return new Map(harnesses.map((harness) => [harness.id, harness.name]));
}

export function connectionDisplayName(
  harnessId: string,
  names: ReadonlyMap<string, string>,
): string {
  return names.get(harnessId) ?? harnessId;
}

export function localMergeConnections(
  harnesses: readonly HarnessConnection[],
): LibraryMergeConnectionModel[] {
  return harnesses
    .filter((connection) => connection.detected && connection.source_merge !== null)
    .map((connection) => ({
      id: connection.id,
      label: connection.name,
      supportsModelOverride: connection.source_merge?.model_override ?? false,
      icon: connection.icon,
    }));
}

export function resolveLocalMergeRequest(
  input: LibraryPrepareMergeInput,
  harnesses: readonly HarnessConnection[],
) {
  const connection = harnesses.find(
    (candidate) =>
      candidate.id === input.connectionId && candidate.detected && candidate.source_merge !== null,
  );
  if (!connection?.source_merge) {
    throw new Error("Select a detected connection that supports agent-assisted merging.");
  }
  return {
    skillName: input.skillId,
    harnessId: connection.id,
    model: connection.source_merge.model_override ? input.model?.trim() || null : null,
    connection,
  };
}

function canonicalSourceKey(source: LibrarySourceModel): string {
  const rawHref = source.href?.trim();
  if (rawHref) {
    try {
      const url = new URL(rawHref);
      const pathname = url.pathname
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
      return `${source.kind}:${url.hostname.toLowerCase()}:${pathname}`;
    } catch {
      return `${source.kind}:${rawHref.toLowerCase()}`;
    }
  }
  return `${source.kind}:${source.label.trim().toLowerCase()}`;
}

function uniqueSources(sources: readonly LibrarySourceModel[]): LibrarySourceModel[] {
  const unique = new Map<string, LibrarySourceModel>();
  for (const source of sources) {
    const key = canonicalSourceKey(source);
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()];
}

function projectRootForLocation(
  location: LibrarySnapshot["skills"][number]["locations"][number],
  projectRoots: readonly string[],
): string | null {
  if (location.projectRoot) return location.projectRoot;
  return (
    projectRoots
      .filter(
        (root) => location.packagePath === root || location.packagePath.startsWith(`${root}/`),
      )
      .sort((left, right) => right.length - left.length)[0] ?? null
  );
}

export function mapLocalLibraryInventory(
  snapshot: LibrarySnapshot,
  intelligence: SkillIntelligenceReport | null,
  portfolio: PortfolioResponse | null,
  harnesses: readonly HarnessConnection[],
  analytics: AnalyticsResponse | null = null,
): LibraryInventoryModel {
  const harnessById = new Map(harnesses.map((harness) => [harness.id, harness]));
  const classificationById = new Map(
    (intelligence?.classifications ?? []).map((classification) => [
      classification.skill_id.toLowerCase(),
      classification,
    ]),
  );
  const triggerTrendByName = new Map(
    (analytics?.skill_trigger_trends ?? []).map((trend) => [
      trend.skill_name.toLowerCase(),
      trend.points,
    ]),
  );
  const lifetimeTriggerCountByName = new Map(
    (analytics?.skill_rankings ?? []).map((ranking) => [
      ranking.skill_name.toLowerCase(),
      ranking.triggered_count,
    ]),
  );

  return {
    categoryOptions: LOCAL_LIBRARY_CATEGORY_OPTIONS,
    skills: snapshot.skills.map((skill) => {
      const projectRoots = [
        ...new Set(
          skill.locations.flatMap((location) =>
            location.projectRoot ? [location.projectRoot] : [],
          ),
        ),
      ];
      const classification = classificationById.get(skill.skillId.toLowerCase());
      const archived = portfolio?.quarantined.find(
        (entry) =>
          entry.skill_name.toLowerCase() === skill.name.toLowerCase() &&
          entry.status === "quarantined",
      );
      const archiveEvidence = portfolio?.audit.skills.find(
        (entry) => entry.skill_name.toLowerCase() === skill.name.toLowerCase(),
      );
      const installedLocations = skill.locations.filter(
        (location) => location.sourceKind === "installed",
      );
      const consolidation = recommendLibraryConsolidation(skill);
      const onDemandLocation = installedLocations[0];
      const onDemandRevision =
        onDemandLocation &&
        skill.revisions.find((revision) =>
          revision.locations.some((location) => location.skillPath === onDemandLocation.skillPath),
        );
      const installedRevisions = skill.revisions.filter((revision) =>
        revision.locations.some(
          (location) => location.sourceKind === "installed" && location.active,
        ),
      );
      const canMoveOnDemand =
        installedLocations.length > 0 &&
        installedRevisions.length === 1 &&
        skill.name.toLowerCase() !== "selftune" &&
        installedLocations.every(
          (location) => location.scope !== "system" && location.scope !== "admin",
        );
      const onDemandSources =
        canMoveOnDemand && onDemandRevision
          ? installedLocations.map((location) => ({
              skillPath: location.skillPath,
              packagePath: location.packagePath,
              contentHash: onDemandRevision.contentHash,
            }))
          : [];
      const inactiveEvidence = installedLocations.map((location) =>
        portfolio?.audit.skills.find((entry) => entry.skill_path === location.skillPath),
      );
      return {
        id: skill.skillId,
        name: skill.name,
        lifecycle: skill.lifecycle,
        category: classification
          ? {
              id: classification.category,
              label: classification.category_label,
              inferredId: classification.inferred_category,
              source: classification.source,
              confidence: classification.confidence,
              reason: classification.reason,
              overrideReason: classification.override_reason,
              matchedTerms: classification.matched_terms,
            }
          : null,
        status: skill.lifecycle === "active" ? "Ready" : "Stored",
        updateStatus: skill.updateStatus,
        sources: uniqueSources(
          skill.origins.map((origin) => {
            const location = skill.locations.find(
              (candidate) =>
                candidate.origin?.kind === origin.kind && candidate.origin.label === origin.label,
            );
            return {
              kind:
                origin.kind === "github" ? "github" : origin.kind === "local" ? "local" : "other",
              label: origin.label,
              href: origin.url,
              path: location?.packagePath ?? skill.locations[0]?.packagePath ?? null,
            };
          }),
        ),
        locations: skill.locations.map((location) => {
          const connection = location.harness ? harnessById.get(location.harness) : null;
          const projectRoot = projectRootForLocation(location, projectRoots);
          return {
            id: `${location.sourceKind}:${location.packagePath}:${location.harness ?? "none"}`,
            groupId:
              projectRoot !== null
                ? `project:${projectRoot}`
                : location.scope === "global"
                  ? "scope:global"
                  : `${location.scope}:${location.packagePath}`,
            rootPath: projectRoot ?? location.packagePath,
            label:
              projectRoot !== null
                ? (projectRoot.split("/").filter(Boolean).at(-1) ?? "Project")
                : location.scope === "global"
                  ? "Global"
                  : location.scope[0]?.toUpperCase() + location.scope.slice(1),
            path: location.packagePath,
            sourceKind: location.sourceKind,
            linkedPath: location.linkedPackagePath ?? null,
            connection: connection?.name ?? location.harness,
            connectionIcon: connection?.icon ?? null,
            lastUsedAt: location.lastUsedAt,
            modifiedAt: location.modifiedAt,
            removable:
              skill.name.toLowerCase() !== "selftune" &&
              location.active &&
              location.sourceKind === "installed" &&
              location.scope !== "admin" &&
              location.scope !== "system",
          };
        }),
        revisionHashes: skill.revisions.map((revision) => revision.contentHash),
        modifiedAt: skill.lastModifiedAt,
        lastUsedAt: skill.lastUsedAt,
        triggerTrend: triggerTrendByName.get(skill.name.toLowerCase()) ?? [],
        lifetimeTriggerCount:
          lifetimeTriggerCountByName.get(skill.name.toLowerCase()) ?? (analytics ? 0 : null),
        instructionBytes: skill.instructionBytes ?? null,
        contextEntries: skill.locations.flatMap<SkillContextEntry>((location) => {
          const installed = location.sourceKind === "installed";
          const saved =
            location.sourceKind === "archived" &&
            skill.revisions.some(
              (revision) =>
                revision.locations.some((item) => item.skillPath === location.skillPath) &&
                revision.locations.some((item) => item.sourceKind === "cached"),
            );
          if (!installed && !saved) return [];
          const original = location.discovery?.originalSkillPath ?? location.skillPath;
          const marker = original.search(/\/\.(?:agents|claude|codex|opencode|pi|openclaw)\//);
          const entry: SkillContextEntry = {
            harness: location.harness,
            scope: location.scope,
            projectRoot:
              location.projectRoot ??
              (location.scope === "project" && marker >= 0 ? original.slice(0, marker) : null),
            path: original,
            state: installed ? "active" : "saved",
          };
          if (location.discovery) entry.metadata = location.discovery;
          return [entry];
        }),
        detailHref: `/skills/${encodeURIComponent(skill.name)}`,
        restoreId: archived?.quarantine_id ?? null,
        onDemandSources,
        onDemandReason:
          onDemandSources.length &&
          inactiveEvidence.every((entry) => entry?.classification === "inactive_candidate")
            ? `All ${onDemandSources.length} installations meet the inactivity threshold. ${inactiveEvidence[0]?.reason ?? ""}`
            : null,
        onDemandSource:
          canMoveOnDemand &&
          onDemandLocation &&
          onDemandRevision &&
          skill.name.toLowerCase() !== "selftune" &&
          onDemandLocation.scope !== "system" &&
          onDemandLocation.scope !== "admin"
            ? {
                skillPath: onDemandLocation.skillPath,
                packagePath: onDemandLocation.packagePath,
                contentHash: onDemandRevision.contentHash,
              }
            : null,
        archiveRecommendation:
          archiveEvidence &&
          archiveEvidence.classification === "inactive_candidate" &&
          archiveEvidence.recommendation === "review_quarantine" &&
          installedLocations.length === 1
            ? {
                classification: archiveEvidence.classification,
                reason: archiveEvidence.reason,
                skillPath: archiveEvidence.skill_path,
                packagePath: archiveEvidence.package_path,
                contentHash:
                  skill.revisions.find((revision) =>
                    revision.locations.some(
                      (location) => location.skillPath === archiveEvidence.skill_path,
                    ),
                  )?.contentHash ?? null,
              }
            : null,
        consolidationRecommendation: consolidation
          ? {
              installedCount: consolidation.installedCount,
              projectCount: consolidation.projectCount,
              duplicateCount: consolidation.duplicateCount,
              divergentCount: consolidation.divergentCount,
              reason: `${consolidation.projectCount} project installation${consolidation.projectCount === 1 ? "" : "s"} can use one managed Library revision. ${consolidation.canonical.reason}`,
              canonical: {
                contentHash: consolidation.canonical.contentHash,
                packagePath: consolidation.canonical.sourceLocation.packagePath,
                confidence: consolidation.canonical.confidence,
              },
              targets: consolidation.locations.flatMap((candidate) =>
                candidate.action === "replace_with_link" || candidate.action === "archive_copy"
                  ? [
                      {
                        packagePath: candidate.location.packagePath,
                        contentHash: candidate.contentHash,
                        action: candidate.action,
                        projectRoot: candidate.location.projectRoot,
                        connection: candidate.location.harness,
                      },
                    ]
                  : [],
              ),
            }
          : null,
      };
    }),
  };
}
