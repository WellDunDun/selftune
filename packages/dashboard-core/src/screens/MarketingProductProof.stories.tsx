import type { Meta, StoryObj } from "@storybook/react-vite";

import { DashboardHostProvider, type DashboardHostModules } from "../host";
import type { LibraryInventoryModel, ProjectsInventoryModel } from "../models";
import { hostModules } from "../test/host-modules";
import { ProjectsScreen } from "./projects";
import { SkillsLibraryScreen } from "./skills";

const unavailable = { access: "unavailable", reason: "Not used in this demo." } as const;

const locations = {
  global: {
    id: "global",
    label: "Global",
    path: "/Users/demo/.agents/skills/research",
    connection: "Codex",
    sourceKind: "installed" as const,
    lastUsedAt: "2026-08-24T12:00:00.000Z",
    modifiedAt: "2026-08-23T12:00:00.000Z",
    removable: true,
  },
  project: {
    id: "project",
    label: "Launch site",
    path: "/Projects/launch/.claude/skills/research",
    connection: "Claude",
    sourceKind: "installed" as const,
    lastUsedAt: "2026-08-22T12:00:00.000Z",
    modifiedAt: "2026-08-18T12:00:00.000Z",
    removable: true,
  },
};

function demoUpdateStatus(value: string): "current" | "available" | "untracked" {
  if (value === "current" || value === "available" || value === "untracked") return value;
  throw new Error(`Unsupported demo update status: ${value}`);
}

const libraryInventory: LibraryInventoryModel = {
  categoryOptions: [
    { id: "agent_tooling", label: "Agent Tooling" },
    { id: "research", label: "Research" },
    { id: "software_development", label: "Software Development" },
  ],
  skills: [
    {
      id: "research",
      name: "research",
      lifecycle: "active",
      category: null,
      status: "Ready",
      updateStatus: "available",
      sources: [{ kind: "github", label: "selftune-dev/research-skills" }],
      locations: [locations.global, locations.project],
      revisionHashes: ["research-current", "research-old"],
      modifiedAt: "2026-08-23T12:00:00.000Z",
      lastUsedAt: "2026-08-24T12:00:00.000Z",
      triggerTrend: [],
      lifetimeTriggerCount: 34,
      detailHref: "/skills/research",
      restoreId: null,
      consolidationRecommendation: {
        installedCount: 2,
        projectCount: 1,
        duplicateCount: 0,
        divergentCount: 1,
        reason: "One project install can use the managed Library revision.",
        canonical: {
          contentHash: "research-current",
          packagePath: locations.global.path,
          confidence: "source_current",
        },
        targets: [
          {
            packagePath: locations.project.path,
            contentHash: "research-old",
            action: "archive_copy",
            projectRoot: "/Projects/launch",
            connection: "claude_code",
          },
        ],
      },
    },
    ...[
      ["agent-browser", "Agent Tooling", "current", "Codex", 21],
      ["frontend-design", "Software Development", "current", "Claude", 18],
      ["release-checklist", "Software Development", "available", "Codex", 9],
      ["customer-research", "Research", "untracked", "Pi", 4],
    ].map(([name, category, updateStatus, connection, triggers], index) => ({
      id: String(name),
      name: String(name),
      lifecycle: "active" as const,
      category: {
        id:
          category === "Research"
            ? "research"
            : category === "Agent Tooling"
              ? "agent_tooling"
              : "software_development",
        label: String(category),
        inferredId: "agent_tooling",
        source: "inferred" as const,
        confidence: 0.91,
        reason: "Demo classification.",
        matchedTerms: [],
      },
      status: "Ready",
      updateStatus: demoUpdateStatus(String(updateStatus)),
      sources: [{ kind: "local" as const, label: "Local package" }],
      locations: [
        {
          ...locations.global,
          id: `location-${index}`,
          path: `/Users/demo/.agents/skills/${String(name)}`,
          connection: String(connection),
        },
      ],
      revisionHashes: [`revision-${index}`],
      modifiedAt: "2026-08-23T12:00:00.000Z",
      lastUsedAt: "2026-08-24T12:00:00.000Z",
      triggerTrend: [],
      lifetimeTriggerCount: Number(triggers),
      detailHref: `/skills/${String(name)}`,
      restoreId: null,
    })),
  ],
};

const projectsInventory: ProjectsInventoryModel = {
  skillSets: [
    {
      id: "product-launch",
      name: "Product launch",
      description:
        "The focused toolkit for researching, building, checking, and shipping the launch site.",
      connections: ["codex", "claude_code"],
      skills: ["research", "agent-browser", "frontend-design", "release-checklist"].map(
        (name, index) => ({
          name,
          packagePath: `/Users/demo/.agents/skills/${name}`,
          contentHash: `revision-${index}`,
        }),
      ),
      revision: 3,
      revisionHash: "product-launch-v3",
      updatedAt: "2026-08-24T12:00:00.000Z",
      ownerScope: "personal",
    },
  ],
  availableSkills: [],
  receipts: [
    {
      id: "receipt-launch",
      skillSetId: "product-launch",
      skillSetName: "Product launch",
      projectRoot: "/Projects/launch-site",
      status: "applied",
      operationCount: 8,
      dependenciesDownloaded: 0,
    },
  ],
  captureCandidates: [],
};

const libraryActions = {
  updateCategory: unavailable,
  openLocation: unavailable,
  backup: unavailable,
  installTargets: [],
  install: unavailable,
  previewSourceUpdate: unavailable,
  applySourceUpdate: unavailable,
  mergeConnections: [],
  prepareMerge: unavailable,
  applyMerge: unavailable,
  archive: unavailable,
  remove: unavailable,
  decideRemoval: unavailable,
  restore: unavailable,
  create: unavailable,
  primary: [],
} as const;

function libraryModules(): DashboardHostModules {
  return hostModules({
    skills: {
      host: "local",
      decisions: unavailable,
      library: {
        access: "available",
        useInventory: () => ({
          data: libraryInventory,
          isLoading: false,
          error: null,
          refresh() {},
        }),
        useActions: () => libraryActions,
      },
    },
  });
}

function projectModules(): DashboardHostModules {
  return hostModules({
    skillSets: {
      library: unavailable,
      projects: {
        access: "available",
        useInventory: () => ({
          data: projectsInventory,
          isLoading: false,
          error: null,
          refresh() {},
        }),
        useIntelligence: () => ({ access: "unavailable", reason: "Not used in this demo." }),
        useActions: () => ({
          create: unavailable,
          update: unavailable,
          derive: unavailable,
          export: unavailable,
          remove: unavailable,
          plan: unavailable,
          apply: unavailable,
          resolveConflict: unavailable,
          decideConflict: unavailable,
          rollbackConflict: unavailable,
          rollback: unavailable,
          reviewSuggestion: unavailable,
        }),
      },
    },
  });
}

const meta = {
  title: "Marketing/Product proof",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SkillSprawl: Story = {
  render: () => (
    <DashboardHostProvider modules={libraryModules()}>
      <SkillsLibraryScreen />
    </DashboardHostProvider>
  ),
};

export const ProjectScopedSkillSet: Story = {
  render: () => (
    <div className="pl-8">
      <DashboardHostProvider modules={projectModules()}>
        <ProjectsScreen />
      </DashboardHostProvider>
    </div>
  ),
};
