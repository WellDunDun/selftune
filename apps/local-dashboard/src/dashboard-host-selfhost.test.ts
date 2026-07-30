import { describe, expect, it } from "vitest";

import { localHostAdapter, mapSelfHostLibraryInventory, selfHostAdapter } from "./dashboard-host";
import { mapLocalLibraryInventory } from "./local-library-model";
import type { LibrarySnapshot } from "./types";

describe("Self-host dashboard adapter", () => {
  it("keeps remote inventory contributions separate from Desktop", () => {
    expect(localHostAdapter.host).toBe("local");
    expect(selfHostAdapter.host).toBe("selfhost");
    expect(selfHostAdapter.queries).toBe(localHostAdapter.queries);
    expect(selfHostAdapter.features).toBe(localHostAdapter.features);
    expect(localHostAdapter.library.access).toBe("available");
    expect(selfHostAdapter.library).not.toBe(localHostAdapter.library);
    expect(localHostAdapter.projects.access).toBe("available");
    expect(selfHostAdapter.projects).not.toBe(localHostAdapter.projects);
  });

  it("keeps Library and Skill Sets readable while failing closed on mutations", () => {
    expect(selfHostAdapter.library.access).toBe("available");
    expect(selfHostAdapter.projects.access).toBe("available");
    if (selfHostAdapter.library.access !== "available") {
      throw new TypeError("Expected the Self-host Library contribution.");
    }
    if (selfHostAdapter.projects.access !== "available") {
      throw new TypeError("Expected the Self-host Skill Sets contribution.");
    }

    const libraryActions = selfHostAdapter.library.useActions();
    expect([
      libraryActions.updateCategory.access,
      libraryActions.openLocation.access,
      libraryActions.previewSourceUpdate.access,
      libraryActions.applySourceUpdate.access,
      libraryActions.prepareMerge.access,
      libraryActions.applyMerge.access,
      libraryActions.archive.access,
      libraryActions.remove.access,
      libraryActions.decideRemoval.access,
      libraryActions.restore.access,
      libraryActions.create.access,
    ]).toEqual(Array.from({ length: 11 }, () => "unavailable"));
    expect(libraryActions.mergeConnections).toEqual([]);
    expect(libraryActions.primary).toEqual([]);
    expect(libraryActions.archiveMany).toBeUndefined();
    expect(libraryActions.consolidate).toBeUndefined();

    const projectActions = selfHostAdapter.projects.useActions();
    expect([
      projectActions.create.access,
      projectActions.update.access,
      projectActions.derive.access,
      projectActions.export.access,
      projectActions.remove.access,
      projectActions.plan.access,
      projectActions.apply.access,
      projectActions.resolveConflict.access,
      projectActions.decideConflict.access,
      projectActions.rollbackConflict.access,
      projectActions.rollback.access,
      projectActions.reviewSuggestion.access,
    ]).toEqual(Array.from({ length: 12 }, () => "unavailable"));
    expect(projectActions.provision).toBeUndefined();
    expect(projectActions.share).toBeUndefined();

    expect(localHostAdapter.decisions.access).toBe("available");
    expect(localHostAdapter.correctionStudies?.access).toBe("available");
    expect(selfHostAdapter.decisions).toEqual({
      access: "unavailable",
      reason: "Durable local decisions are unavailable on this read-only Self-host dashboard.",
    });
    expect(selfHostAdapter.correctionStudies).toEqual({
      access: "unavailable",
      reason: "Correction studies require connected local agent data.",
    });
  });

  it("keeps remote skills readable without advertising local-only reports", () => {
    const modifiedAt = "2026-07-30T10:00:00.000Z";
    const origin = {
      kind: "registry" as const,
      label: "SelfTune Remote Library",
      url: "https://selftune.example.com",
    };
    const location = {
      sourceKind: "remote" as const,
      packagePath: "selftune-remote://objects/abc/packages/team-helper",
      skillPath: "selftune-remote://objects/abc/packages/team-helper/SKILL.md",
      harness: null,
      scope: "library" as const,
      projectRoot: null,
      active: false,
      modifiedAt,
      lastUsedAt: null,
      origin,
      updateStatus: "untracked" as const,
    };
    const snapshot: LibrarySnapshot = {
      generatedAt: modifiedAt,
      counts: { total: 1, active: 0, library: 1, draft: 0, archived: 0 },
      skills: [
        {
          skillId: "team-helper",
          name: "team-helper",
          lifecycle: "library",
          revisions: [{ contentHash: "abc", locations: [location] }],
          locations: [location],
          lastUsedAt: null,
          lastModifiedAt: modifiedAt,
          origins: [origin],
          updateStatus: "untracked",
        },
      ],
    };

    const localInventory = mapLocalLibraryInventory(snapshot, null, null, []);
    const selfHostInventory = mapSelfHostLibraryInventory(snapshot);

    expect(localInventory.skills[0]?.detailHref).toBe("/skills/team-helper");
    expect(selfHostInventory.skills[0]).toMatchObject({
      id: "team-helper",
      name: "team-helper",
      lifecycle: "library",
      status: "Stored",
      detailHref: null,
    });
    expect(selfHostInventory.skills[0]?.locations).toEqual([
      expect.objectContaining({
        sourceKind: "remote",
        path: location.packagePath,
        removable: false,
      }),
    ]);
  });
});
