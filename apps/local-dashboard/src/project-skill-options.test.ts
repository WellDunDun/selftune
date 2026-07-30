import { describe, expect, it } from "vitest";

import { projectSkillOptionsFromLibrary } from "./project-skill-options";
import type { LibrarySnapshot } from "./types";

type LibraryLocation = LibrarySnapshot["skills"][number]["locations"][number];

const location: LibraryLocation = {
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

describe("projectSkillOptionsFromLibrary", () => {
  it("emits one option per skill and prefers its active installed revision", () => {
    const library: LibrarySnapshot = {
      generatedAt: "2026-07-17T10:00:00.000Z",
      counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
      skills: [
        {
          skillId: "diagnose",
          name: "diagnose",
          lifecycle: "active",
          revisions: [
            {
              contentHash: "cached-newer",
              locations: [
                {
                  ...location,
                  sourceKind: "cached",
                  active: false,
                  packagePath: "/cache/diagnose",
                  skillPath: "/cache/diagnose/SKILL.md",
                  modifiedAt: "2026-07-18T10:00:00.000Z",
                },
              ],
            },
            { contentHash: "installed-current", locations: [location] },
            {
              contentHash: "archived-copy",
              locations: [
                {
                  ...location,
                  sourceKind: "archived",
                  active: false,
                  packagePath: "/archive/diagnose",
                  skillPath: "/archive/diagnose/SKILL.md",
                },
              ],
            },
          ],
          locations: [location],
          lastUsedAt: location.lastUsedAt,
          lastModifiedAt: location.modifiedAt,
          origins: [],
          updateStatus: "current",
        },
      ],
    };

    expect(projectSkillOptionsFromLibrary(library)).toEqual([
      {
        id: "diagnose",
        name: "diagnose",
        packagePath: "/skills/diagnose",
        contentHash: "installed-current",
        lifecycle: "active",
        revisionChoices: [
          {
            contentHash: "installed-current",
            packagePath: "/skills/diagnose",
            sourceKind: "installed",
            connection: "codex",
            scope: "global",
            projectRoot: null,
            active: true,
            modifiedAt: "2026-07-17T10:00:00.000Z",
            lastUsedAt: "2026-07-17T10:00:00.000Z",
            originLabel: null,
          },
        ],
      },
    ]);
  });
});
