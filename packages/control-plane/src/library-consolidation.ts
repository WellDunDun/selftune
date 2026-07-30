import type { LibraryLocation, LibrarySkill } from "./domain";

export type LibraryConsolidationAction =
  | "keep_source"
  | "replace_with_link"
  | "archive_copy"
  | "unchanged_link";

export interface LibraryConsolidationLocation {
  readonly contentHash: string;
  readonly location: LibraryLocation;
  readonly action: LibraryConsolidationAction;
}

export interface LibraryConsolidationRecommendation {
  readonly skillId: string;
  readonly skillName: string;
  readonly installedCount: number;
  readonly projectCount: number;
  readonly duplicateCount: number;
  readonly divergentCount: number;
  readonly canonical: {
    readonly contentHash: string;
    readonly sourceLocation: LibraryLocation;
    readonly installedLocation: LibraryLocation;
    readonly confidence: "source_current" | "review_required";
    readonly reason: string;
  };
  readonly locations: readonly LibraryConsolidationLocation[];
}

interface InstalledRevision {
  readonly contentHash: string;
  readonly location: LibraryLocation;
}

function locationPriority(location: LibraryLocation): number {
  if (location.updateStatus === "current") return 0;
  if (location.updateStatus === "unknown" || location.updateStatus === "untracked") return 1;
  return 2;
}

function scopePriority(location: LibraryLocation): number {
  if (location.scope === "global") return 0;
  if (location.scope === "project") return 1;
  return 2;
}

function compareInstalled(left: InstalledRevision, right: InstalledRevision): number {
  const status = locationPriority(left.location) - locationPriority(right.location);
  if (status !== 0) return status;
  const scope = scopePriority(left.location) - scopePriority(right.location);
  if (scope !== 0) return scope;
  const used = (right.location.lastUsedAt ?? "").localeCompare(left.location.lastUsedAt ?? "");
  if (used !== 0) return used;
  const modified = right.location.modifiedAt.localeCompare(left.location.modifiedAt);
  if (modified !== 0) return modified;
  const path = left.location.packagePath.localeCompare(right.location.packagePath);
  return path !== 0 ? path : left.contentHash.localeCompare(right.contentHash);
}

function installedRevisions(skill: LibrarySkill): InstalledRevision[] {
  const revisions: InstalledRevision[] = [];
  for (const revision of skill.revisions) {
    for (const location of revision.locations) {
      if (
        location.sourceKind === "installed" &&
        location.active &&
        location.scope !== "admin" &&
        location.scope !== "system"
      ) {
        revisions.push({ contentHash: revision.contentHash, location });
      }
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- revisions is a fresh local accumulator.
  return revisions.sort(compareInstalled);
}

function canonicalSource(skill: LibrarySkill, canonical: InstalledRevision): LibraryLocation {
  const revision = skill.revisions.find(
    (candidate) => candidate.contentHash === canonical.contentHash,
  );
  return (
    revision?.locations.find((location) => location.sourceKind === "cached") ?? canonical.location
  );
}

function actionOrder(action: LibraryConsolidationAction): number {
  switch (action) {
    case "keep_source":
      return 0;
    case "replace_with_link":
      return 1;
    case "archive_copy":
      return 2;
    case "unchanged_link":
      return 3;
  }
}

export function recommendLibraryConsolidation(
  skill: LibrarySkill,
): LibraryConsolidationRecommendation | null {
  if (skill.skillId.trim().toLowerCase() === "selftune") return null;
  const installed = installedRevisions(skill);
  if (installed.length < 2) return null;

  const canonical = installed[0];
  if (!canonical) return null;
  const sourceLocation = canonicalSource(skill, canonical);
  const keptGlobal = installed.find(
    (candidate) =>
      candidate.contentHash === canonical.contentHash && candidate.location.scope === "global",
  );
  const locations = installed
    .flatMap((candidate): LibraryConsolidationLocation[] => {
      let action: LibraryConsolidationAction | null = null;
      if (candidate.location.scope === "project") {
        action =
          candidate.contentHash === canonical.contentHash &&
          candidate.location.linkedPackagePath === sourceLocation.packagePath
            ? "unchanged_link"
            : "replace_with_link";
      } else if (candidate === keptGlobal) action = "keep_source";
      else if (candidate.location.scope === "global") action = "archive_copy";
      return action ? [{ ...candidate, action }] : [];
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- flatMap creates a fresh recommendation array.
    .sort(
      (left, right) =>
        actionOrder(left.action) - actionOrder(right.action) ||
        left.location.packagePath.localeCompare(right.location.packagePath),
    );
  const mutations = locations.filter(
    ({ action }) => action === "replace_with_link" || action === "archive_copy",
  );
  if (mutations.length === 0) return null;

  return {
    skillId: skill.skillId,
    skillName: skill.name,
    installedCount: installed.length,
    projectCount: locations.filter(({ action }) => action === "replace_with_link").length,
    duplicateCount: mutations.filter(({ contentHash }) => contentHash === canonical.contentHash)
      .length,
    divergentCount: mutations.filter(({ contentHash }) => contentHash !== canonical.contentHash)
      .length,
    canonical: {
      contentHash: canonical.contentHash,
      sourceLocation,
      installedLocation: canonical.location,
      confidence:
        canonical.location.updateStatus === "current" ? "source_current" : "review_required",
      reason:
        canonical.location.updateStatus === "current"
          ? "This revision is recorded as current with its source."
          : "No source-confirmed current revision is available; review the proposed canonical copy.",
    },
    locations,
  };
}
