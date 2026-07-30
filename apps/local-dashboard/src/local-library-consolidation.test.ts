import { describe, expect, it } from "vitest";

import { mapLocalLibraryInventory } from "./local-library-model";
import type { LibrarySnapshot } from "./types";

describe("local Library consolidation recommendations", () => {
  it("maps duplicate project installations into one reviewable recommendation", () => {
    const current: LibrarySnapshot["skills"][number]["locations"][number] = {
      sourceKind: "installed",
      packagePath: "/home/test/.agents/skills/research",
      skillPath: "/home/test/.agents/skills/research/SKILL.md",
      harness: "codex",
      scope: "global",
      projectRoot: null,
      linkedPackagePath: null,
      active: true,
      modifiedAt: "2026-07-20T10:00:00.000Z",
      lastUsedAt: "2026-07-20T10:00:00.000Z",
      origin: null,
      updateStatus: "current",
    };
    const project: LibrarySnapshot["skills"][number]["locations"][number] = {
      ...current,
      packagePath: "/projects/a/.agents/skills/research",
      skillPath: "/projects/a/.agents/skills/research/SKILL.md",
      scope: "project",
      projectRoot: "/projects/a",
      updateStatus: "untracked",
    };
    const snapshot: LibrarySnapshot = {
      generatedAt: "2026-07-20T10:00:00.000Z",
      counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
      skills: [
        {
          skillId: "research",
          name: "research",
          lifecycle: "active",
          revisions: [{ contentHash: "current-hash", locations: [current, project] }],
          locations: [current, project],
          lastUsedAt: current.lastUsedAt,
          lastModifiedAt: current.modifiedAt,
          origins: [],
          updateStatus: "current",
        },
      ],
    };

    expect(mapLocalLibraryInventory(snapshot, null, null, []).skills[0]).toMatchObject({
      consolidationRecommendation: {
        installedCount: 2,
        projectCount: 1,
        duplicateCount: 1,
        divergentCount: 0,
        canonical: {
          contentHash: "current-hash",
          packagePath: current.packagePath,
          confidence: "source_current",
        },
        targets: [{ packagePath: project.packagePath, action: "replace_with_link" }],
      },
    });
  });
});
