import type { LibraryLocation, LibraryRevision, LibrarySkill } from "./domain";

export interface PreferredLibraryRevision {
  readonly contentHash: string;
  readonly location: LibraryLocation;
  readonly activeRevisionCount: number;
}

export interface LibraryRevisionChoice {
  readonly contentHash: string;
  readonly location: LibraryLocation;
}

const SOURCE_PRIORITY: Record<LibraryLocation["sourceKind"], number> = {
  installed: 5,
  cached: 4,
  remote: 3,
  draft: 2,
  archived: 1,
};

function compareLocations(left: LibraryLocation, right: LibraryLocation): number {
  if (left.active !== right.active) return left.active ? -1 : 1;
  const sourceDifference = SOURCE_PRIORITY[right.sourceKind] - SOURCE_PRIORITY[left.sourceKind];
  if (sourceDifference !== 0) return sourceDifference;
  const modifiedDifference = right.modifiedAt.localeCompare(left.modifiedAt);
  if (modifiedDifference !== 0) return modifiedDifference;
  return left.packagePath.localeCompare(right.packagePath);
}

function preferredLocation(revision: LibraryRevision): LibraryLocation | null {
  let preferred: LibraryLocation | null = null;
  for (const location of revision.locations) {
    if (location.sourceKind === "archived") continue;
    if (preferred === null || compareLocations(location, preferred) < 0) preferred = location;
  }
  return preferred;
}

function compareChoices(left: LibraryRevisionChoice, right: LibraryRevisionChoice): number {
  const locationDifference = compareLocations(left.location, right.location);
  if (locationDifference !== 0) return locationDifference;
  return left.contentHash.localeCompare(right.contentHash);
}

export function libraryRevisionChoices(skill: LibrarySkill): readonly LibraryRevisionChoice[] {
  const candidates: LibraryRevisionChoice[] = [];
  for (const revision of skill.revisions) {
    const location = preferredLocation(revision);
    if (location) candidates.push({ contentHash: revision.contentHash, location });
  }
  const activeCandidates = candidates.filter(({ location }) => location.active);
  const choices = activeCandidates.length > 0 ? activeCandidates : candidates;
  const ordered: LibraryRevisionChoice[] = [];
  for (const choice of choices) {
    const index = ordered.findIndex((current) => compareChoices(choice, current) < 0);
    if (index === -1) ordered.push(choice);
    else ordered.splice(index, 0, choice);
  }
  return ordered;
}

/**
 * Selects the canonical revision used when a consumer needs one concrete package
 * from an already-grouped Library skill. Skill identity remains `skillId`; this
 * function must not be used to expand revisions back into separate skill rows.
 */
export function preferredLibraryRevision(skill: LibrarySkill): PreferredLibraryRevision | null {
  const choices = libraryRevisionChoices(skill);
  const preferred = choices[0];

  return preferred
    ? {
        contentHash: preferred.contentHash,
        location: preferred.location,
        activeRevisionCount: choices.filter(({ location }) => location.active).length,
      }
    : null;
}
