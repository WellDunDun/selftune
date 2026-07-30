import { describe, expect, it } from "vitest";

import type { LibraryLocation, LibrarySkill } from "./domain";
import { recommendLibraryConsolidation } from "./library-consolidation";

function location(packagePath: string, overrides: Partial<LibraryLocation> = {}): LibraryLocation {
  return {
    sourceKind: "installed",
    packagePath,
    skillPath: `${packagePath}/SKILL.md`,
    harness: "codex",
    scope: "project",
    projectRoot: packagePath.split("/.agents/")[0] ?? null,
    active: true,
    modifiedAt: "2026-07-20T10:00:00.000Z",
    lastUsedAt: null,
    origin: null,
    updateStatus: "untracked",
    ...overrides,
  };
}

function skill(revisions: LibrarySkill["revisions"]): LibrarySkill {
  const locations = revisions.flatMap((revision) => revision.locations);
  return {
    skillId: "research",
    name: "research",
    lifecycle: "active",
    revisions,
    locations,
    lastUsedAt: null,
    lastModifiedAt: "2026-07-20T10:00:00.000Z",
    origins: [],
    updateStatus: "available",
  };
}

describe("recommendLibraryConsolidation", () => {
  it("recommends replacing duplicate project copies with links to one current source", () => {
    const current = location("/home/test/.agents/skills/research", {
      scope: "global",
      projectRoot: null,
      updateStatus: "current",
      modifiedAt: "2026-07-18T10:00:00.000Z",
    });
    const projectA = location("/projects/a/.agents/skills/research");
    const projectB = location("/projects/b/.agents/skills/research");

    const recommendation = recommendLibraryConsolidation(
      skill([{ contentHash: "current-hash", locations: [current, projectA, projectB] }]),
    );

    expect(recommendation).toMatchObject({
      skillName: "research",
      installedCount: 3,
      projectCount: 2,
      duplicateCount: 2,
      divergentCount: 0,
      canonical: {
        contentHash: "current-hash",
        sourceLocation: { packagePath: current.packagePath },
        confidence: "source_current",
      },
    });
    expect(
      recommendation?.locations.map(({ action, location: item }) => [action, item.packagePath]),
    ).toEqual([
      ["keep_source", current.packagePath],
      ["replace_with_link", projectA.packagePath],
      ["replace_with_link", projectB.packagePath],
    ]);
  });

  it("prefers a source-confirmed revision over a newer divergent copy", () => {
    const current = location("/home/test/.agents/skills/research", {
      scope: "global",
      projectRoot: null,
      updateStatus: "current",
      modifiedAt: "2026-07-18T10:00:00.000Z",
    });
    const divergent = location("/projects/a/.agents/skills/research", {
      updateStatus: "available",
      modifiedAt: "2026-07-21T10:00:00.000Z",
      lastUsedAt: "2026-07-21T10:00:00.000Z",
    });

    const recommendation = recommendLibraryConsolidation(
      skill([
        { contentHash: "current-hash", locations: [current] },
        { contentHash: "older-or-modified-hash", locations: [divergent] },
      ]),
    );

    expect(recommendation).toMatchObject({
      duplicateCount: 0,
      divergentCount: 1,
      canonical: { contentHash: "current-hash", confidence: "source_current" },
      locations: [
        { action: "keep_source", contentHash: "current-hash" },
        { action: "replace_with_link", contentHash: "older-or-modified-hash" },
      ],
    });
  });

  it("does not re-recommend project links that already use the canonical Library package", () => {
    const current = location("/home/test/.agents/skills/research", {
      scope: "global",
      projectRoot: null,
      updateStatus: "current",
    });
    const cached = location("/state/library/packages/current-hash/research", {
      sourceKind: "cached",
      scope: "library",
      projectRoot: null,
      harness: null,
      active: false,
    });
    const projectLink = location("/projects/a/.agents/skills/research", {
      linkedPackagePath: cached.packagePath,
    });

    expect(
      recommendLibraryConsolidation(
        skill([{ contentHash: "current-hash", locations: [current, cached, projectLink] }]),
      ),
    ).toBeNull();
  });
});
