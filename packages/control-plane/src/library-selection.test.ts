import { describe, expect, it } from "vitest";

import type { LibraryLocation, LibrarySkill } from "./domain";
import { libraryRevisionChoices, preferredLibraryRevision } from "./library-selection";

const installedLocation: LibraryLocation = {
  sourceKind: "installed",
  packagePath: "/skills/diagnose",
  skillPath: "/skills/diagnose/SKILL.md",
  harness: "codex",
  scope: "global",
  projectRoot: null,
  active: true,
  modifiedAt: "2026-07-17T10:00:00.000Z",
  lastUsedAt: "2026-07-17T10:00:00.000Z",
  origin: null,
  updateStatus: "current",
};

describe("preferredLibraryRevision", () => {
  it("prefers an active installed revision without changing canonical skill identity", () => {
    const skill: LibrarySkill = {
      skillId: "diagnose",
      name: "diagnose",
      lifecycle: "active",
      revisions: [
        {
          contentHash: "cached-newer",
          locations: [
            {
              ...installedLocation,
              sourceKind: "cached",
              active: false,
              packagePath: "/cache/diagnose",
              skillPath: "/cache/diagnose/SKILL.md",
              modifiedAt: "2026-07-18T10:00:00.000Z",
            },
          ],
        },
        { contentHash: "installed-current", locations: [installedLocation] },
        {
          contentHash: "installed-other",
          locations: [
            {
              ...installedLocation,
              packagePath: "/project/.agents/skills/diagnose",
              skillPath: "/project/.agents/skills/diagnose/SKILL.md",
              modifiedAt: "2026-07-16T10:00:00.000Z",
            },
          ],
        },
      ],
      locations: [installedLocation],
      lastUsedAt: installedLocation.lastUsedAt,
      lastModifiedAt: installedLocation.modifiedAt,
      origins: [],
      updateStatus: "current",
    };

    expect(preferredLibraryRevision(skill)).toMatchObject({
      contentHash: "installed-current",
      activeRevisionCount: 2,
      location: { packagePath: "/skills/diagnose" },
    });
    expect(libraryRevisionChoices(skill)).toHaveLength(2);
  });

  it("ignores archived-only revisions", () => {
    const skill: LibrarySkill = {
      skillId: "archived",
      name: "archived",
      lifecycle: "archived",
      revisions: [
        {
          contentHash: "archived-copy",
          locations: [
            {
              ...installedLocation,
              sourceKind: "archived",
              active: false,
            },
          ],
        },
      ],
      locations: [],
      lastUsedAt: null,
      lastModifiedAt: installedLocation.modifiedAt,
      origins: [],
      updateStatus: "untracked",
    };

    expect(preferredLibraryRevision(skill)).toBeNull();
  });
});
