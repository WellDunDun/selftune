import type { ProjectSkillOptionModel } from "@selftune/dashboard-core/models";
import {
  libraryRevisionChoices,
  preferredLibraryRevision,
} from "@selftune/control-plane/library-selection";

import type { LibrarySnapshot } from "./types";

export function projectSkillOptionsFromLibrary(
  library: LibrarySnapshot,
): ProjectSkillOptionModel[] {
  return library.skills.flatMap((skill) => {
    const preferred = preferredLibraryRevision(skill);
    const revisionChoices = libraryRevisionChoices(skill).map((choice) => ({
      contentHash: choice.contentHash,
      packagePath: choice.location.packagePath,
      sourceKind: choice.location.sourceKind,
      connection: choice.location.harness,
      scope: choice.location.scope,
      projectRoot: choice.location.projectRoot,
      active: choice.location.active,
      modifiedAt: choice.location.modifiedAt,
      lastUsedAt: choice.location.lastUsedAt,
      originLabel: choice.location.origin?.label ?? null,
    }));
    return preferred
      ? [
          {
            id: skill.skillId,
            name: skill.name,
            packagePath: preferred.location.packagePath,
            contentHash: preferred.contentHash,
            lifecycle: skill.lifecycle,
            revisionChoices,
          },
        ]
      : [];
  });
}
