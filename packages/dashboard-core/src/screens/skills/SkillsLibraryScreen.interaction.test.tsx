// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DashboardHostProvider,
  type DashboardHostModules,
  type DashboardLibraryActions,
} from "../../host";
import type {
  DashboardDecisionModel,
  LibraryInventoryModel,
  LibrarySkillModel,
} from "../../models";
import { hostModules } from "../../test/host-modules";
import { SkillsLibraryScreen } from "./SkillsLibraryScreen";
import { ON_DEMAND_SETUP_KEY } from "./OnDemandSkillsPanel";

beforeEach(() => {
  // These are returning-user Library flows; first-run setup has its own interaction tests.
  const values = new Map([[ON_DEMAND_SETUP_KEY, "true"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

const inventory: LibraryInventoryModel = {
  categoryOptions: [],
  skills: [
    {
      id: "agent-browser",
      name: "agent-browser",
      lifecycle: "active",
      status: "Ready",
      updateStatus: "current",
      sources: [{ kind: "local", label: "Local package" }],
      locations: [
        {
          id: "global",
          label: "Global",
          path: "/Users/test/.agents/skills/agent-browser",
          sourceKind: "installed",
          removable: true,
        },
      ],
      revisionHashes: ["abcdef123456"],
      archiveRecommendation: {
        classification: "inactive_candidate",
        reason: "No trusted use was observed.",
        skillPath: "/Users/test/.agents/skills/agent-browser/SKILL.md",
        packagePath: "/Users/test/.agents/skills/agent-browser",
      },
      consolidationRecommendation: {
        installedCount: 3,
        projectCount: 1,
        duplicateCount: 1,
        divergentCount: 1,
        reason: "One project installation can use the source-confirmed Library revision.",
        canonical: {
          contentHash: "abcdef1234567890",
          packagePath: "/Users/test/.agents/skills/agent-browser",
          confidence: "source_current",
        },
        targets: [
          {
            packagePath: "/projects/example/.agents/skills/agent-browser",
            contentHash: "outdated1234567890",
            action: "replace_with_link",
            projectRoot: "/projects/example",
            connection: "codex",
          },
        ],
      },
    },
  ],
};

function sortingSkill(overrides: Partial<LibrarySkillModel>): LibrarySkillModel {
  return {
    id: "base",
    name: "base",
    lifecycle: "active",
    category: null,
    status: "Ready",
    updateStatus: "current",
    sources: [],
    locations: [
      {
        id: "base-location",
        label: "Global",
        path: "/Users/test/.agents/skills/base",
        connection: null,
        lastUsedAt: null,
        modifiedAt: null,
        removable: false,
      },
    ],
    revisionHashes: [],
    modifiedAt: null,
    lastUsedAt: null,
    triggerTrend: [],
    lifetimeTriggerCount: null,
    archiveRecommendation: null,
    consolidationRecommendation: null,
    statusBadge: null,
    ...overrides,
  };
}

function sortingCategory(id: string, label: string) {
  return {
    id,
    label,
    inferredId: id,
    source: "inferred" as const,
    confidence: 1,
    reason: "Fixture category",
    matchedTerms: [],
  };
}

const sortingInventory: LibraryInventoryModel = {
  categoryOptions: [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
    { id: "zeta", label: "Zeta" },
  ],
  skills: [
    sortingSkill({
      id: "zulu",
      name: "zulu",
      category: sortingCategory("zeta", "Zeta"),
      sources: [{ kind: "local", label: "Zulu source" }],
      locations: [
        {
          id: "zulu-location",
          label: "Global",
          path: "/Users/test/.agents/skills/zulu",
          connection: "Slack",
          lastUsedAt: "2026-07-10T12:00:00.000Z",
          modifiedAt: "2026-07-12T12:00:00.000Z",
          removable: false,
        },
      ],
      modifiedAt: "2026-07-12T12:00:00.000Z",
      lastUsedAt: "2026-07-10T12:00:00.000Z",
      triggerTrend: [],
      lifetimeTriggerCount: 20,
      statusBadge: { label: "Healthy", tone: "healthy" },
    }),
    sortingSkill({
      id: "alpha",
      name: "alpha",
      category: sortingCategory("alpha", "Alpha"),
      sources: [{ kind: "local", label: "Alpha source" }],
      locations: [
        {
          id: "alpha-location",
          label: "Global",
          path: "/Users/test/.agents/skills/alpha",
          connection: "Codex",
          lastUsedAt: "2026-07-20T12:00:00.000Z",
          modifiedAt: "2026-07-22T12:00:00.000Z",
          removable: false,
        },
      ],
      modifiedAt: "2026-07-22T12:00:00.000Z",
      lastUsedAt: "2026-07-20T12:00:00.000Z",
      triggerTrend: [],
      lifetimeTriggerCount: 2,
      statusBadge: { label: "Warning", tone: "warning" },
    }),
    sortingSkill({
      id: "beta",
      name: "beta",
      category: sortingCategory("beta", "Beta"),
      sources: [{ kind: "local", label: "Beta source" }],
      locations: [
        {
          id: "beta-location",
          label: "Global",
          path: "/Users/test/.agents/skills/beta",
          connection: "GitHub",
          lastUsedAt: "2026-07-15T12:00:00.000Z",
          modifiedAt: null,
          removable: false,
        },
      ],
      modifiedAt: null,
      lastUsedAt: "2026-07-15T12:00:00.000Z",
      triggerTrend: [],
      lifetimeTriggerCount: 10,
      statusBadge: { label: "Healthy", tone: "healthy" },
    }),
    sortingSkill({
      id: "never-used",
      name: "never-used",
      category: null,
      sources: [],
      locations: [
        {
          id: "never-used-location",
          label: "Global",
          path: "/Users/test/.agents/skills/never-used",
          connection: null,
          lastUsedAt: null,
          modifiedAt: null,
          removable: false,
        },
      ],
      modifiedAt: null,
      lastUsedAt: null,
      triggerTrend: [],
      lifetimeTriggerCount: null,
      statusBadge: { label: "Unknown", tone: "neutral" },
    }),
  ],
};

const archivedInventory: LibraryInventoryModel = {
  categoryOptions: [],
  skills: [
    {
      ...inventory.skills[0]!,
      id: "archived-skill",
      name: "archived-skill",
      lifecycle: "archived",
      archiveRecommendation: null,
      restoreId: "restore-1",
    },
  ],
};

const bulkArchiveInventory: LibraryInventoryModel = {
  categoryOptions: [],
  skills: [
    inventory.skills[0]!,
    {
      ...inventory.skills[0]!,
      id: "never-used",
      name: "never-used",
      locations: [
        {
          ...inventory.skills[0]!.locations[0]!,
          id: "never-used-global",
          path: "/Users/test/.agents/skills/never-used",
        },
      ],
      archiveRecommendation: {
        classification: "inactive_candidate",
        reason: "No trusted use was observed after installation.",
        skillPath: "/Users/test/.agents/skills/never-used/SKILL.md",
        packagePath: "/Users/test/.agents/skills/never-used",
      },
    },
  ],
};

const bulkConsolidationInventory: LibraryInventoryModel = {
  categoryOptions: [],
  skills: [
    inventory.skills[0]!,
    {
      ...inventory.skills[0]!,
      id: "playwright-cli",
      name: "playwright-cli",
      archiveRecommendation: null,
      consolidationRecommendation: {
        ...inventory.skills[0]!.consolidationRecommendation!,
        canonical: {
          contentHash: "playwright1234567890",
          packagePath: "/Users/test/.agents/skills/playwright-cli",
          confidence: "source_current",
        },
        targets: [
          {
            packagePath: "/projects/example/.agents/skills/playwright-cli",
            contentHash: "outdated-playwright1234567890",
            action: "replace_with_link",
            projectRoot: "/projects/example",
            connection: "codex",
          },
        ],
      },
    },
    {
      ...inventory.skills[0]!,
      id: "research",
      name: "research",
      archiveRecommendation: null,
      consolidationRecommendation: {
        installedCount: 3,
        projectCount: 1,
        duplicateCount: 0,
        divergentCount: 2,
        reason: "No source-confirmed current revision is available.",
        canonical: {
          contentHash: "candidate1234567890",
          packagePath: "/Users/test/.agents/skills/research",
          confidence: "review_required",
        },
        targets: [
          {
            packagePath: "/projects/example/.agents/skills/research",
            contentHash: "divergent1234567890",
            action: "replace_with_link",
            projectRoot: "/projects/example",
            connection: "codex",
          },
        ],
      },
    },
  ],
};

function consolidationDecisionFor(
  skillName: string,
): Extract<DashboardDecisionModel, { kind: "skill_consolidation" }> {
  return {
    id: `consolidation-${skillName}`,
    kind: "skill_consolidation",
    status: "approved",
    title: `Consolidate ${skillName}`,
    summary: "Applied",
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2026-07-22T11:00:00.000Z",
    decidedAt: "2026-07-22T10:01:00.000Z",
    failure: null,
    audit: [],
    hasRecoveryReceipt: true,
    skillName,
    canonicalContentHash: "abcdef1234567890",
    canonicalPackagePath: `/library/${skillName}/abcdef1234567890`,
    targets: [],
    recoveryStatus: "applied",
  };
}

function adapter(
  library: DashboardHostModules["skills"]["library"],
  decisions: DashboardHostModules["skills"]["decisions"] = {
    access: "unavailable",
    reason: "unused",
  },
): DashboardHostModules {
  return hostModules({ skills: { host: "local", library, decisions } });
}

function actions(
  backup: DashboardLibraryActions["backup"],
  archive: Extract<DashboardLibraryActions["archive"], { access: "available" }>["execute"],
  consolidate?: Extract<
    NonNullable<DashboardLibraryActions["consolidate"]>,
    { access: "available" }
  >["execute"],
  archiveMany?: Extract<
    NonNullable<DashboardLibraryActions["archiveMany"]>,
    { access: "available" }
  >["execute"],
): DashboardLibraryActions {
  return {
    updateCategory: { access: "available", execute: async () => undefined },
    openLocation: { access: "available", execute: async () => undefined },
    backup,
    previewSourceUpdate: { access: "unavailable", reason: "unused" },
    applySourceUpdate: { access: "unavailable", reason: "unused" },
    mergeConnections: [],
    prepareMerge: { access: "unavailable", reason: "unused" },
    applyMerge: { access: "unavailable", reason: "unused" },
    archive: { access: "available", execute: archive },
    archiveMany: archiveMany ? { access: "available", execute: archiveMany } : undefined,
    consolidate: consolidate ? { access: "available", execute: consolidate } : undefined,
    remove: { access: "unavailable", reason: "unused" },
    decideRemoval: { access: "unavailable", reason: "unused" },
    restore: { access: "unavailable", reason: "unused" },
    create: { access: "unavailable", reason: "unused" },
    primary: [],
  };
}

describe("Skills Library bulk actions", () => {
  it("sorts visible columns through accessible native controls with missing values last", () => {
    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: sortingInventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () => actions({ access: "unavailable", reason: "unused" }, vi.fn()),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    const table = screen.getByRole("table");
    const headerRow = within(table).getAllByRole("row")[0]!;
    const sortableLabels = [
      "Skill",
      "Category",
      "State",
      "Source",
      "Connections",
      "Triggers",
      "Last used",
      "Updated",
    ];

    for (const label of sortableLabels) {
      const button = within(headerRow).getByRole("button", { name: `Sort by ${label}` });
      expect(button.tagName).toBe("BUTTON");
      expect(button.closest("th")?.getAttribute("aria-sort")).toBe("none");
    }
    expect(
      within(headerRow).getByRole("checkbox", { name: "Select all visible skills" }),
    ).toBeTruthy();
    expect(
      within(headerRow).getByText("Actions").closest("th")?.querySelector("button"),
    ).toBeNull();

    const rowNames = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("aria-label"));

    const skillButton = () => within(headerRow).getByRole("button", { name: /^Sort by Skill/ });
    fireEvent.click(skillButton());
    expect(rowNames()).toEqual([
      "View alpha details",
      "View beta details",
      "View never-used details",
      "View zulu details",
    ]);
    expect(skillButton().getAttribute("aria-label")).toBe("Sort by Skill, currently ascending");
    expect(skillButton().closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(skillButton());
    expect(rowNames()).toEqual([
      "View zulu details",
      "View never-used details",
      "View beta details",
      "View alpha details",
    ]);
    expect(skillButton().closest("th")?.getAttribute("aria-sort")).toBe("descending");

    const lastUsedButton = () =>
      within(headerRow).getByRole("button", { name: /^Sort by Last used/ });
    fireEvent.click(lastUsedButton());
    expect(rowNames()).toEqual([
      "View zulu details",
      "View beta details",
      "View alpha details",
      "View never-used details",
    ]);
    expect(lastUsedButton().closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(skillButton().closest("th")?.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(lastUsedButton());
    expect(rowNames()).toEqual([
      "View alpha details",
      "View beta details",
      "View zulu details",
      "View never-used details",
    ]);
    expect(lastUsedButton().closest("th")?.getAttribute("aria-sort")).toBe("descending");

    const updatedButton = () => within(headerRow).getByRole("button", { name: /^Sort by Updated/ });
    fireEvent.click(updatedButton());
    expect(rowNames()).toEqual([
      "View zulu details",
      "View alpha details",
      "View beta details",
      "View never-used details",
    ]);
    expect(updatedButton().closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    const categoryButton = () =>
      within(headerRow).getByRole("button", { name: /^Sort by Category/ });
    fireEvent.click(categoryButton());
    expect(rowNames()).toEqual([
      "View alpha details",
      "View beta details",
      "View zulu details",
      "View never-used details",
    ]);

    const stateButton = () => within(headerRow).getByRole("button", { name: /^Sort by State/ });
    fireEvent.click(stateButton());
    expect(rowNames()).toEqual([
      "View beta details",
      "View zulu details",
      "View never-used details",
      "View alpha details",
    ]);

    const sourceButton = () => within(headerRow).getByRole("button", { name: /^Sort by Source/ });
    fireEvent.click(sourceButton());
    expect(rowNames()).toEqual([
      "View alpha details",
      "View beta details",
      "View zulu details",
      "View never-used details",
    ]);

    const connectionsButton = () =>
      within(headerRow).getByRole("button", { name: /^Sort by Connections/ });
    fireEvent.click(connectionsButton());
    expect(rowNames()).toEqual([
      "View alpha details",
      "View beta details",
      "View zulu details",
      "View never-used details",
    ]);

    const triggersButton = () =>
      within(headerRow).getByRole("button", { name: /^Sort by Triggers/ });
    fireEvent.click(triggersButton());
    expect(rowNames()).toEqual([
      "View alpha details",
      "View beta details",
      "View zulu details",
      "View never-used details",
    ]);
    fireEvent.click(triggersButton());
    expect(rowNames()).toEqual([
      "View zulu details",
      "View beta details",
      "View alpha details",
      "View never-used details",
    ]);
  });

  it("opens the recommendation review menu without leaving the library", async () => {
    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: inventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () => actions({ access: "unavailable", reason: "unused" }, vi.fn()),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review recommendations" }));

    expect(await screen.findByText("No meaningful recent use")).toBeTruthy();
    expect(screen.getByText("Multiple copies can be consolidated")).toBeTruthy();
  });

  it("defaults the state filter to active without a state parameter", async () => {
    window.history.replaceState(null, "", "/skills");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: archivedInventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () => actions({ access: "unavailable", reason: "unused" }, vi.fn()),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(
      (await screen.findByRole("combobox", { name: "Filter by state" })).textContent,
    ).toContain("Active");
    expect(screen.queryByText("archived-skill")).toBeNull();
  });

  it("opens restore links on the archived catalog", async () => {
    window.history.replaceState(null, "", "/skills?state=archived");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: archivedInventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () => actions({ access: "unavailable", reason: "unused" }, vi.fn()),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(await screen.findByText("archived-skill")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Filter by state" }).textContent).toContain(
      "Archived",
    );
  });

  it("opens an evidence-backed cleanup link with archive candidates preselected", async () => {
    const archive = vi.fn(async () => undefined);
    window.history.replaceState(null, "", "/skills?review=archive");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: inventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () => actions({ access: "unavailable", reason: "unused" }, archive),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(await screen.findByText("Archive candidates")).toBeTruthy();
    expect(await screen.findByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive 1" })).toBeTruthy();
  });

  it("selects visible rows and backs up the selected local skills", async () => {
    const backup = vi.fn(async () => ({ uploaded: 1, unchanged: 0, snapshotId: "snapshot-1" }));
    const archive = vi.fn(async () => undefined);
    const refresh = vi.fn();

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({ data: inventory, isLoading: false, error: null, refresh }),
          useActions: () => actions({ access: "available", execute: backup }, archive),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    fireEvent.click(screen.getByLabelText("Select agent-browser"));

    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back up 1" }));

    await waitFor(() => expect(backup).toHaveBeenCalledWith("agent-browser"));
    expect(await screen.findByText("Backed up 1 selected skill to Cloud.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Select agent-browser"));
    fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    expect(screen.getByText("No trusted use was observed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));

    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith({
        skillName: "agent-browser",
        skillPath: "/Users/test/.agents/skills/agent-browser/SKILL.md",
      }),
    );
  });

  it("closes the archive review after a successful batch when the following refresh fails", async () => {
    const archive = vi.fn(async () => {
      throw new Error("The per-skill archive path should not run.");
    });
    const archiveMany = vi.fn(async () => ({ succeeded: 2, failed: 0 }));
    const refresh = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    window.history.replaceState(null, "", "/skills?review=archive");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: bulkArchiveInventory,
            isLoading: false,
            error: null,
            refresh,
          }),
          useActions: () =>
            actions({ access: "unavailable", reason: "unused" }, archive, undefined, archiveMany),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(await screen.findByText("Archive candidates")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));

    await waitFor(() =>
      expect(archiveMany).toHaveBeenCalledWith([
        {
          skillName: "agent-browser",
          skillPath: "/Users/test/.agents/skills/agent-browser/SKILL.md",
        },
        {
          skillName: "never-used",
          skillPath: "/Users/test/.agents/skills/never-used/SKILL.md",
        },
      ]),
    );
    expect(archive).not.toHaveBeenCalled();
    expect(await screen.findByText("Archived 2 selected skills.")).toBeTruthy();
    expect(
      await screen.findByText(
        "The skills were archived, but the Library could not refresh. Reload to view the current state.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Archive 2 selected skills?")).toBeNull();
  });

  it("reviews duplicate installations before archiving copies and linking projects", async () => {
    const consolidationDecision: DashboardDecisionModel = {
      id: "consolidation-1",
      kind: "skill_consolidation",
      status: "approved",
      title: "Consolidate agent-browser",
      summary: "Applied",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      expiresAt: "2026-07-22T11:00:00.000Z",
      decidedAt: "2026-07-22T10:01:00.000Z",
      failure: null,
      audit: [],
      hasRecoveryReceipt: true,
      skillName: "agent-browser",
      canonicalContentHash: "abcdef1234567890",
      canonicalPackagePath: "/library/agent-browser/abcdef1234567890",
      targets: [],
      recoveryStatus: "applied",
    };
    const consolidate = vi.fn(async () => consolidationDecision);
    window.history.replaceState(null, "", "/skills?review=consolidate");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: inventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () =>
            actions({ access: "unavailable", reason: "unused" }, vi.fn(), consolidate),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(await screen.findByText("Duplicate installations")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Consolidate" }));

    expect(screen.getByText("Consolidate agent-browser installations?")).toBeTruthy();
    expect(screen.getByText("Source-confirmed current")).toBeTruthy();
    expect(screen.getByText("Archive, then link")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive copies & link projects" }));

    await waitFor(() => expect(consolidate).toHaveBeenCalledWith("agent-browser"));
  });

  it("bulk applies source-confirmed consolidations while holding ambiguous revisions for review", async () => {
    const consolidate = vi.fn(async (skillId: string) => consolidationDecisionFor(skillId));
    window.history.replaceState(null, "", "/skills?review=consolidate&bulk=1");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: bulkConsolidationInventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(),
          }),
          useActions: () =>
            actions({ access: "unavailable", reason: "unused" }, vi.fn(), consolidate),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(await screen.findByText("Review duplicate installations")).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", { name: "Consolidate agent-browser" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("checkbox", { name: "Consolidate research" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("2 skills selected")).toBeTruthy();
    expect(screen.getByText(/Archive 2 copies · create 2 project links/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply safe consolidations" }));

    await waitFor(() => expect(consolidate).toHaveBeenCalledTimes(2));
    expect(consolidate).toHaveBeenCalledWith("agent-browser");
    expect(consolidate).toHaveBeenCalledWith("playwright-cli");
    expect(await screen.findByText("Consolidation complete")).toBeTruthy();
    expect(screen.getByText("research still needs canonical review.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Decisions" }).getAttribute("href")).toBe(
      "/insights",
    );
  });

  it("confirms and undoes every applied consolidation from the current cleanup", async () => {
    const consolidate = vi.fn(async (skillId: string) => consolidationDecisionFor(skillId));
    const rollback = vi.fn(
      async (decisionId: string): Promise<DashboardDecisionModel> => ({
        ...consolidationDecisionFor(decisionId.replace("consolidation-", "")),
        recoveryStatus: "rolled_back",
      }),
    );
    window.history.replaceState(null, "", "/skills?review=consolidate&bulk=1");

    render(
      <DashboardHostProvider
        modules={adapter(
          {
            access: "available",
            useInventory: () => ({
              data: bulkConsolidationInventory,
              isLoading: false,
              error: null,
              refresh: vi.fn(),
            }),
            useActions: () =>
              actions({ access: "unavailable", reason: "unused" }, vi.fn(), consolidate),
          },
          {
            access: "available",
            useDecisions: () => ({
              data: [],
              isLoading: false,
              error: null,
              refresh: vi.fn(),
            }),
            useActions: () => ({
              decide: { access: "unavailable", reason: "unused" },
              rollback: { access: "available", execute: rollback },
            }),
          },
        )}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply safe consolidations" }));
    expect(await screen.findByText("Consolidation complete")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo all from this cleanup" }));
    expect(screen.getByText("Undo this cleanup?")).toBeTruthy();
    expect(screen.getByText(/restore the original archived copies for 2 skills/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo 2 consolidations" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(2));
    expect(rollback).toHaveBeenCalledWith("consolidation-agent-browser");
    expect(rollback).toHaveBeenCalledWith("consolidation-playwright-cli");
    expect(await screen.findByText("Cleanup undone")).toBeTruthy();
    expect(screen.getAllByText("Undone")).toHaveLength(2);
  });

  it("continues applying selected consolidations after an individual failure", async () => {
    const consolidate = vi.fn(async (skillId: string) => {
      if (skillId === "agent-browser") throw new Error("Archive destination unavailable");
      return consolidationDecisionFor(skillId);
    });
    window.history.replaceState(null, "", "/skills?review=consolidate&bulk=1");

    render(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: bulkConsolidationInventory,
            isLoading: false,
            error: null,
            refresh: vi.fn(async () => {
              throw new Error("Refresh failed");
            }),
          }),
          useActions: () =>
            actions({ access: "unavailable", reason: "unused" }, vi.fn(), consolidate),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply safe consolidations" }));

    await waitFor(() => expect(consolidate).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Consolidation complete")).toBeTruthy();
    expect(screen.getByText("Archive destination unavailable")).toBeTruthy();
    expect(screen.getByText("Archived and linked with a recoverable receipt.")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Applied")).toBeTruthy();
    expect(screen.getByText(/Library could not refresh: Refresh failed/)).toBeTruthy();
  });
});
