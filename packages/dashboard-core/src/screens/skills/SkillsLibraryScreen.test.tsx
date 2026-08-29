import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DashboardHostProvider,
  type DashboardHostModules,
  type DashboardLibraryActions,
} from "../../host";
import type { LibraryInventoryModel } from "../../models";
import { hostModules } from "../../test/host-modules";
import { SkillDetail, SkillsLibraryScreen } from "./SkillsLibraryScreen";

const inventory: LibraryInventoryModel = {
  categoryOptions: [{ id: "agent_tooling", label: "Agent Tooling" }],
  summary: { ready: 1, snapshots: 1, pendingActions: 1 },
  note: {
    title: "Cloud skills versus observed skills",
    description: "This Library shows skills uploaded to Cloud.",
    link: { label: "View observed skills", href: "/insights" },
  },
  skills: [
    {
      id: "agent-browser",
      name: "agent-browser",
      lifecycle: "active",
      category: {
        id: "agent_tooling",
        label: "Agent Tooling",
        inferredId: "agent_tooling",
        source: "inferred",
        confidence: 0.94,
        reason: "Agent workflow terms matched.",
        matchedTerms: ["agent"],
      },
      status: "Ready",
      statusBadge: { label: "Healthy", tone: "healthy" },
      updateStatus: "available",
      sources: [
        {
          kind: "github",
          label: "vercel-labs/agent-browser",
          href: "https://github.com/vercel-labs/agent-browser",
        },
      ],
      locations: [
        {
          id: "global",
          label: "Global",
          path: "/Users/test/.agents/skills/agent-browser",
          connection: "Codex",
          connectionIcon: {
            src: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
            fit: "contain",
            inset: "sm",
          },
          sourceKind: "installed",
          lastUsedAt: "2026-07-15T12:00:00.000Z",
          modifiedAt: "2026-07-14T12:00:00.000Z",
          removable: true,
        },
      ],
      revisionHashes: ["abcdef123456"],
      modifiedAt: "2026-07-14T12:00:00.000Z",
      lastUsedAt: "2026-07-15T12:00:00.000Z",
      triggerTrend: [
        { date: "2026-07-13", count: 2 },
        { date: "2026-07-14", count: 0 },
        { date: "2026-07-15", count: 5 },
      ],
      lifetimeTriggerCount: 47,
      detailHref: "/skills/agent-browser",
      restoreId: "restore-agent-browser",
      archiveRecommendation: {
        classification: "inactive_candidate",
        reason: "No trusted use was observed during the inactive window.",
        skillPath: "/Users/test/.agents/skills/agent-browser/SKILL.md",
        packagePath: "/Users/test/.agents/skills/agent-browser",
      },
    },
  ],
};

function adapter(library: DashboardHostModules["skills"]["library"]): DashboardHostModules {
  return hostModules({
    skills: { host: "local", library, decisions: { access: "unavailable", reason: "unused" } },
  });
}

describe("shared Skills Library", () => {
  it("renders adapter-owned inventory, search, filters, sources, and actions", () => {
    const html = renderToStaticMarkup(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: inventory,
            isLoading: false,
            error: null,
            refresh() {},
          }),
          useActions: () => ({
            updateCategory: {
              access: "available",
              execute: async () => undefined,
            },
            openLocation: {
              access: "available",
              execute: async () => undefined,
            },
            backup: {
              access: "available",
              execute: async () => ({
                uploaded: 1,
                unchanged: 0,
                snapshotId: "snapshot-1",
              }),
            },
            installTargets: [{ id: "codex", label: "Codex" }],
            install: {
              access: "available",
              execute: async ({ skillId, targetAgent }) => ({
                skillId,
                targetAgent,
                targetPath: `/tmp/${skillId}`,
              }),
            },
            previewSourceUpdate: {
              access: "available",
              execute: async () => ({
                status: "current",
                conflicts: 0,
                locations: [],
                diffs: [],
              }),
            },
            applySourceUpdate: {
              access: "available",
              execute: async () => ({
                installedVersion: "abcdef1234",
                receiptId: "receipt1",
              }),
            },
            mergeConnections: [{ id: "codex", label: "Codex", supportsModelOverride: true }],
            prepareMerge: { access: "upgrade", href: "/upgrade/merge" },
            applyMerge: { access: "upgrade", href: "/upgrade/merge" },
            archive: { access: "available", execute: async () => undefined },
            remove: {
              access: "unavailable",
              reason: "Removal is managed by an administrator.",
            },
            decideRemoval: {
              access: "unavailable",
              reason: "Removal is managed by an administrator.",
            },
            restore: { access: "available", execute: async () => undefined },
            create: {
              access: "available",
              Component: () => <div>Upload folder or connect repo</div>,
            },
            primary: [],
          }),
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Skills Library");
    expect(html).toContain("Triggers");
    expect(html).toContain("agent-browser trigger history");
    expect(html).not.toContain(">5 triggers<");
    expect(html).toContain("Search skills or locations");
    expect(html).not.toContain("All states");
    expect(html).toContain("All categories");
    expect(html).toContain("All connections");
    expect(html).toContain("Healthy");
    expect(html).toContain("Updated");
    expect(html).toContain("agent-browser");
    expect(html).toContain("vercel-labs/agent-browser");
    expect(html).toContain('href="https://github.com/vercel-labs/agent-browser"');
    expect(html).toContain('aria-label="Update agent-browser"');
    expect(html).toContain('aria-label="View agent-browser details"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="More actions for agent-browser"');
    expect(html).toContain("Pending proposals");
    expect(html).toContain("Cloud skills versus observed skills");
    expect(html).toContain('href="/insights"');
    expect(html).toContain("Upload folder or connect repo");
  });

  it("renders deliberate unavailable and upgrade states", () => {
    const unavailable = renderToStaticMarkup(
      <DashboardHostProvider
        modules={adapter({
          access: "unavailable",
          reason: "Library data is disabled here.",
        })}
      >
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );
    const upgrade = renderToStaticMarkup(
      <DashboardHostProvider modules={adapter({ access: "upgrade", href: "/upgrade/library" })}>
        <SkillsLibraryScreen />
      </DashboardHostProvider>,
    );

    expect(unavailable).toContain("Library data is disabled here.");
    expect(upgrade).toContain('href="/upgrade/library"');
    expect(upgrade).toContain("Upgrade to use the Skills Library");
  });

  it("renders explicit connection and model controls for agent-assisted merges", () => {
    const actions = {
      updateCategory: { access: "unavailable", reason: "Not classified here." },
      openLocation: { access: "unavailable", reason: "No local filesystem." },
      backup: {
        access: "available",
        execute: async () => ({
          uploaded: 1,
          unchanged: 0,
          snapshotId: "snapshot-1",
        }),
      },
      installTargets: [{ id: "codex", label: "Codex" }],
      install: {
        access: "available",
        execute: async ({ skillId, targetAgent }) => ({
          skillId,
          targetAgent,
          targetPath: `/tmp/${skillId}`,
        }),
      },
      previewSourceUpdate: {
        access: "unavailable",
        reason: "Already previewed.",
      },
      applySourceUpdate: {
        access: "available",
        execute: async () => ({
          installedVersion: "abcdef1234",
          receiptId: "receipt1",
        }),
      },
      mergeConnections: [
        {
          id: "codex",
          label: "Codex",
          supportsModelOverride: true,
          icon: inventory.skills[0]?.locations[0]?.connectionIcon,
        },
      ],
      prepareMerge: {
        access: "available",
        execute: async () => ({
          mergeId: "merge-1",
          summary: "Ready",
          diffs: [],
        }),
      },
      applyMerge: {
        access: "available",
        execute: async () => ({
          installedVersion: "abcdef1234",
          receiptId: "receipt1",
        }),
      },
      archive: { access: "available", execute: async () => undefined },
      remove: { access: "unavailable", reason: "Protected." },
      decideRemoval: { access: "unavailable", reason: "Protected." },
      restore: { access: "available", execute: async () => undefined },
      create: { access: "unavailable", reason: "Not here." },
      primary: [],
    } satisfies DashboardLibraryActions;

    const html = renderToStaticMarkup(
      <SkillDetail
        skill={{
          ...inventory.skills[0]!,
          locations: [
            ...inventory.skills[0]!.locations,
            {
              ...inventory.skills[0]!.locations[0]!,
              id: "global-claude",
              connection: "Claude Code",
            },
            {
              id: "cached",
              label: "Library",
              path: "/tmp/library/agent-browser",
              sourceKind: "cached",
              removable: false,
            },
          ],
        }}
        sourceUpdate={{
          status: "available",
          conflicts: 1,
          locations: [
            {
              path: "/Users/test/.agents/skills/agent-browser",
              canonicalTarget: "agent-browser",
              localState: "modified",
              reason: "Local files differ from the recorded base.",
            },
          ],
          diffs: [],
        }}
        updateReceipt={{
          installedVersion: "abcdef1234",
          receiptId: "receipt1",
        }}
        merge={null}
        actionError={null}
        onPreviewUpdate={() => undefined}
        onApplyUpdate={() => undefined}
        onPrepareMerge={() => undefined}
        onApplyMerge={() => undefined}
        onRemove={() => undefined}
        onRestore={() => undefined}
        removalDecision={null}
        onDecideRemoval={() => undefined}
        actions={actions}
      />,
    );

    expect(html).toContain("Merge connection");
    expect(html).toContain("Codex");
    expect(html).toContain("Model (optional)");
    expect(html).toContain("Prepare merge");
    expect(html).toContain("Back up to Cloud");
    expect(html).toContain("Install for agent");
    expect(html).toContain("Restore skill");
    expect(html).toContain("Connected agents");
    expect(html).toContain("2 agents");
    expect(html).toContain('aria-label="Codex"');
    expect(html).toContain('aria-label="Claude Code"');
    expect(html).toContain("Local changes were found in 1 location");
    expect(html).toContain("Backup receipt receipt1 retained");
  });
});
