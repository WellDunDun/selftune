import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DashboardHostProvider,
  type DashboardHostModules,
  type DashboardProjectsActions,
  type DashboardProjectsIntelligenceQueryState,
} from "../../host";
import type { ProjectSkillSetIntelligenceModel, ProjectsInventoryModel } from "../../models";
import { hostModules } from "../../test/host-modules";
import {
  PlanReview,
  ProjectActionNotice,
  ProjectsScreen,
  SkillSetSkillPicker,
  projectActionFailure,
  suggestionEditedFields,
} from "./ProjectsScreen";
import { ProjectCaptureCandidates } from "./ProjectCaptureCandidates";
import { SkillSetIntelligencePanels } from "./SkillSetIntelligencePanels";

const inventory: ProjectsInventoryModel = {
  skillSets: [
    {
      id: "software-development",
      name: "Software Development",
      description: "Reusable engineering workflow",
      connections: ["codex"],
      skills: [
        {
          name: "tdd",
          packagePath: "/skills/tdd",
          contentHash: "abcdef123456",
        },
      ],
      revision: 2,
      revisionHash: "revision-2",
      updatedAt: "2026-07-16T10:00:00.000Z",
    },
  ],
  availableSkills: [
    {
      id: "tdd:abcdef123456",
      name: "tdd",
      packagePath: "/skills/tdd",
      contentHash: "abcdef123456",
      lifecycle: "active",
    },
    {
      id: "shadcn:123456abcdef",
      name: "shadcn",
      packagePath: "/skills/shadcn",
      contentHash: "123456abcdef",
      lifecycle: "active",
    },
  ],
  receipts: [],
  captureCandidates: [
    {
      projectRoot: "/projects/mobile-app",
      name: "Mobile App",
      connections: ["codex", "pi"],
      skillCount: 4,
      lastUsedAt: "2026-07-16T09:00:00.000Z",
    },
  ],
};

const unavailableAction = {
  access: "unavailable",
  reason: "Not available in this host.",
} as const;

const actions: DashboardProjectsActions = {
  create: unavailableAction,
  update: unavailableAction,
  derive: unavailableAction,
  export: unavailableAction,
  remove: unavailableAction,
  plan: unavailableAction,
  apply: unavailableAction,
  resolveConflict: unavailableAction,
  decideConflict: unavailableAction,
  rollbackConflict: unavailableAction,
  rollback: unavailableAction,
  reviewSuggestion: unavailableAction,
};

const unavailableIntelligence = (): DashboardProjectsIntelligenceQueryState => ({
  access: "unavailable",
  reason: "Skill Set intelligence is unavailable in this host.",
});

const intelligence: ProjectSkillSetIntelligenceModel = {
  validation: { ready: true, discoverySessions: 12, heldOutSessions: 4 },
  calibration: {
    status: "calibrated",
    minimumLabeledReviews: 20,
    labeledReviews: 24,
    appliedMinEvidenceScore: 0.72,
  },
  suggestions: [
    {
      id: "co-usage-set-1",
      evidenceFingerprint: "evidence-1",
      name: "Cloud UI Debugging",
      description: "An overlapping skill community.",
      pattern: "co_usage",
      skills: [
        {
          name: "cloudflare",
          packagePath: "/skills/cloudflare",
          role: "Provides the application platform and deployment architecture.",
          sourceId: "cloudflare/skills",
          membershipScore: 0.94,
        },
        {
          name: "wrangler",
          packagePath: "/skills/wrangler",
          role: "Runs the local development and deployment workflow.",
          sourceId: "cloudflare/skills",
          membershipScore: 0.92,
        },
        {
          name: "shadcn",
          packagePath: "/skills/shadcn",
          role: "Builds the shared interface component layer.",
          sourceId: "vercel-labs/agent-skills",
          membershipScore: 0.88,
        },
        {
          name: "react-best-practices",
          packagePath: "/skills/react-best-practices",
          role: "Keeps the React implementation efficient and maintainable.",
          sourceId: "vercel-labs/agent-skills",
          membershipScore: 0.86,
        },
        {
          name: "diagnose",
          packagePath: "/skills/diagnose",
          role: "Provides the debugging workflow for this Cloudflare set.",
          sourceId: "mattpocock/skills",
          membershipScore: 0.84,
        },
      ],
      connections: ["codex"],
      projectRoot: null,
      evidenceState: "validated",
      confidence: 0.91,
      discoveryOccurrenceCount: 8,
      heldOutOccurrenceCount: 3,
      discoveryEdgeCoverage: 0.9,
      heldOutEdgeCoverage: 0.75,
      reason: "The skills recur as an overlapping set in held-out sessions.",
    },
    {
      id: "review-set-1",
      evidenceFingerprint: "evidence-2",
      name: "High-Rigor Review",
      description: "A reusable review and failure-analysis workflow.",
      pattern: "workflow",
      skills: [
        {
          name: "thermonuclear-review",
          packagePath: "/skills/thermonuclear-review",
          role: "Performs the exhaustive review pass.",
          sourceId: "mattpocock/skills",
          membershipScore: 0.93,
        },
        {
          name: "diagnose",
          packagePath: "/skills/diagnose",
          role: "Provides failure analysis for issues found during review.",
          sourceId: "mattpocock/skills",
          membershipScore: 0.89,
        },
        {
          name: "tdd",
          packagePath: "/skills/tdd",
          role: "Turns findings into reproducible regression tests.",
          sourceId: "mattpocock/skills",
          membershipScore: 0.85,
        },
        {
          name: "codebase-design",
          packagePath: "/skills/codebase-design",
          role: "Assesses structural changes after correctness is established.",
          sourceId: null,
          membershipScore: 0.81,
        },
      ],
      connections: ["codex"],
      projectRoot: null,
      evidenceState: "supported",
      confidence: 0.86,
      discoveryOccurrenceCount: 6,
      heldOutOccurrenceCount: 2,
      discoveryEdgeCoverage: null,
      heldOutEdgeCoverage: null,
      reason: "The review workflow recurred across older and newer sessions.",
    },
  ],
  catalogExpansions: [
    {
      id: "catalog-mobile-1",
      profileId: "mobile",
      name: "Mobile Engineering",
      description: "Mobile implementation and simulator workflow.",
      evidenceState: "exploratory",
      evidenceBasis: "project_context_and_catalog",
      projectRoot: null,
      contextScore: 0.9,
      matchedSignalCount: 1,
      matchedSignals: ["flutter app"],
      connections: ["codex"],
      skills: [
        {
          name: "flutter-apply-architecture-best-practices",
          capability: "mobile_framework",
          role: "Provides the cross-platform mobile application framework.",
          whyIncluded: "It is already installed.",
          provenance: "installed",
          source: "flutter/skills",
          catalogId: null,
          installSpec: null,
          downloadUrl: null,
          packagePath: "/skills/flutter-apply-architecture-best-practices",
        },
        {
          name: "serve-sim",
          capability: "simulator_tooling",
          role: "Runs and inspects the app in mobile simulators.",
          whyIncluded: "It is already installed.",
          provenance: "installed",
          source: "evanbacon/serve-sim",
          catalogId: null,
          installSpec: null,
          downloadUrl: null,
          packagePath: "/skills/serve-sim",
        },
        {
          name: "dart-run-static-analysis",
          capability: "language",
          role: "Provides language-specific implementation guidance.",
          whyIncluded: "It is already installed.",
          provenance: "installed",
          source: "dart-lang/skills",
          catalogId: null,
          installSpec: null,
          downloadUrl: null,
          packagePath: "/skills/dart-run-static-analysis",
        },
      ],
      reason: "Suggested from portfolio and workspace history.",
    },
  ],
  outcomes: [
    {
      id: "outcome-1",
      skillSetId: "software-development",
      status: "improved",
      reason: "Completion and trigger coverage improved after activation.",
      beforeSessionCount: 5,
      afterSessionCount: 6,
      metrics: {
        completionQuality: { before: 0.62, after: 0.84 },
        errorRate: { before: 3, after: 1 },
        triggerCoverage: { before: 0.55, after: 0.8 },
        tokenCost: { before: 1200, after: 1100 },
        grading: { before: 0.66, after: 0.86 },
      },
    },
  ],
  traceSignals: [],
  executionPatterns: [],
};

function adapter(projects: DashboardHostModules["skillSets"]["projects"]): DashboardHostModules {
  const unavailable = { access: "unavailable", reason: "unused" } as const;
  return hostModules({
    skillSets: { projects, library: unavailable },
  });
}

describe("shared Projects screen", () => {
  it("renders adapter-owned Skill Sets and explicit action availability", () => {
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
          useIntelligence: unavailableIntelligence,
          useActions: () => actions,
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Skill Sets");
    expect(html).not.toContain(">Projects<");
    expect(html).toContain("Software Development");
    expect(html).toContain("Reusable engineering workflow");
    expect(html).not.toContain("Not available in this host.");
  });

  it("renders compact evidence-backed suggestions and measured outcomes", () => {
    const html = renderToStaticMarkup(
      <>
        <SkillSetIntelligencePanels
          intelligence={{
            access: "available",
            data: intelligence,
            isLoading: false,
            error: null,
            refresh() {},
          }}
          reviewAction={{ access: "available", execute: async () => undefined }}
          view="suggestions"
          onReview={() => undefined}
          onReviewExpansion={() => undefined}
        />
        <SkillSetIntelligencePanels
          intelligence={{
            access: "available",
            data: { ...intelligence, catalogExpansions: [] },
            isLoading: false,
            error: null,
            refresh() {},
          }}
          reviewAction={{ access: "available", execute: async () => undefined }}
          view="suggestions"
          onReview={() => undefined}
          onReviewExpansion={() => undefined}
        />
        <SkillSetIntelligencePanels
          intelligence={{
            access: "available",
            data: intelligence,
            isLoading: false,
            error: null,
            refresh() {},
          }}
          reviewAction={{ access: "available", execute: async () => undefined }}
          view="outcomes"
          onReview={() => undefined}
          onReviewExpansion={() => undefined}
        />
      </>,
    );

    expect(html).toContain("Suggested Skill Sets");
    expect(html).toContain("Context-Backed Skill Sets");
    expect(html).toContain("Mobile Engineering");
    expect(html).toContain("serve-sim");
    expect(html).toContain('aria-label="Review and create Mobile Engineering"');
    expect(html).toContain("Cloud UI Debugging");
    expect(html).toContain("High-Rigor Review");
    expect(html).toContain("91% evidence score");
    expect(html).toContain(
      "90% of member relationships appeared in older sessions; 75% held up in newer sessions.",
    );
    expect(html).toContain("Provides the debugging workflow for this Cloudflare set.");
    expect(html).toContain("Source: cloudflare/skills");
    expect(html).toContain("94%");
    expect(html).toContain("Selected suggestion details");
    expect(html).not.toContain('class="rounded-lg border p-3"');
    expect(html).toContain('aria-label="Review Cloud UI Debugging"');
    expect(html).toContain('aria-label="Dismiss Cloud UI Debugging"');
    expect(html).toContain("Measured Outcomes");
    expect(html).toContain("software-development");
    expect(html).toContain("Completion and trigger coverage improved after activation.");
  });

  it("records whether an accepted suggestion was changed before creation", () => {
    const suggestion = intelligence.suggestions[0];
    if (!suggestion) throw new Error("Expected a suggestion fixture.");
    const exact = {
      name: suggestion.name,
      description: suggestion.description,
      connections: suggestion.connections,
      skills: suggestion.skills,
    };

    expect(suggestionEditedFields(suggestion, exact)).toEqual([]);
    expect(
      suggestionEditedFields(suggestion, {
        ...exact,
        name: "Cloud UI Toolkit",
        connections: ["claude_code"],
        skills: exact.skills.slice(0, 2),
      }),
    ).toEqual(["name", "connections", "skills"]);
  });

  it("renders searchable skill selection in the shared editor", () => {
    const html = renderToStaticMarkup(
      <SkillSetSkillPicker
        skills={inventory.availableSkills}
        selectedPaths={["/skills/tdd"]}
        onValueChange={() => undefined}
      />,
    );

    expect(html).toContain('data-slot="combobox-chips"');
    expect(html).toContain("Search and add skills…");
    expect(html).toContain("tdd");
  });

  it("shows one skill result with an explicit selector for divergent installed revisions", () => {
    const html = renderToStaticMarkup(
      <SkillSetSkillPicker
        skills={[
          {
            ...inventory.availableSkills[0]!,
            revisionChoices: [
              {
                contentHash: "abcdef123456",
                packagePath: "/skills/tdd",
                sourceKind: "installed",
                connection: "codex",
                scope: "global",
                projectRoot: null,
                active: true,
                modifiedAt: "2026-07-18T10:00:00.000Z",
                lastUsedAt: "2026-07-18T10:00:00.000Z",
                originLabel: null,
              },
              {
                contentHash: "fedcba654321",
                packagePath: "/project/skills/tdd",
                sourceKind: "installed",
                connection: "claude_code",
                scope: "project",
                projectRoot: "/projects/moscow",
                active: true,
                modifiedAt: "2026-07-17T10:00:00.000Z",
                lastUsedAt: null,
                originLabel: "selftune-dev/tdd",
              },
            ],
          },
        ]}
        selectedPaths={["/skills/tdd"]}
        onValueChange={() => undefined}
      />,
    );

    expect(html).toContain("tdd copy");
    expect(html).toContain('aria-label="tdd copy"');
    expect(html).toContain("Global · Codex");
    expect(html).toContain("/skills/tdd");
    expect(html).not.toContain("abcdef123");
  });

  it("offers both creation paths from the empty Skill Sets state", () => {
    const html = renderToStaticMarkup(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: { ...inventory, skillSets: [] },
            isLoading: false,
            error: null,
            refresh() {},
          }),
          useIntelligence: unavailableIntelligence,
          useActions: () => ({
            ...actions,
            create: {
              access: "available",
              execute: async () => inventory.skillSets[0]!,
            },
            derive: {
              access: "available",
              execute: async () => inventory.skillSets[0]!,
            },
          }),
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("No Skill Sets yet");
    expect(html).toContain("Create Skill Set");
    expect(html).not.toContain("Suggestions");
    expect(html).not.toContain("Outcomes");
    expect(html).not.toContain(">Projects<");
    expect(html).not.toContain("Detected Projects");
  });

  it("keeps detected project capture in its focused project surface", () => {
    const candidate = inventory.captureCandidates[0];
    if (!candidate) throw new Error("Expected a capture candidate fixture.");
    const html = renderToStaticMarkup(
      <ProjectCaptureCandidates
        candidates={[candidate]}
        selectedProjectRoot=""
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("Detected projects");
    expect(html).toContain("Mobile App");
    expect(html).toContain("4 skills");
    expect(html).toContain('aria-label="Use Mobile App"');
  });

  it("shows the selected Skill Set's installed projects instead of an inline installer", () => {
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
          useIntelligence: unavailableIntelligence,
          useActions: () => ({
            ...actions,
            plan: {
              access: "available",
              execute: async () => ({
                skillSetId: "software-development",
                skillSetName: "Software Development",
                projectRoot: "/projects/mobile-app",
                creates: 1,
                unchanged: 0,
                conflicts: 0,
                missingDependencies: 0,
                operations: [],
              }),
            },
          }),
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Installed projects");
    expect(html).toContain("This Skill Set has not been installed in a project yet.");
    expect(html).not.toContain("Install in a project");
    expect(html).not.toContain("Enter a different folder");
  });

  it("turns unavailable hosted sharing into a SelfTune Cloud conversion action", () => {
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
          useIntelligence: unavailableIntelligence,
          useActions: () => ({
            ...actions,
            share: { access: "upgrade", href: "/settings?section=remote-library" },
            shareGatePreview: {
              href: "/projects?preview=cloud-sharing-gate",
              label: "Preview Cloud gate",
            },
          }),
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Share with Cloud");
    expect(html).not.toContain('href="/settings?section=remote-library"');
    expect(html).toContain("Preview Cloud gate");
    expect(html).toContain('href="/projects?preview=cloud-sharing-gate"');
  });

  it("renders hosted export and delete without asking Cloud for a project folder", () => {
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
          useIntelligence: unavailableIntelligence,
          useActions: () => ({
            ...actions,
            export: {
              access: "available",
              label: "Export Skill Set",
              requiresProjectRoot: false,
              execute: async () => ({
                outputPath: "software-development.json",
              }),
            },
            remove: { access: "available", execute: async () => undefined },
          }),
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Export Skill Set");
    expect(html).toContain('aria-label="Delete Skill Set"');
    expect(html).toContain("Delete</button>");
    expect(html).not.toContain("Project folder");
  });

  it("offers native plugin installation only when the host supplies the reviewed installer", () => {
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
          useIntelligence: unavailableIntelligence,
          useActions: () => ({
            ...actions,
            installPlugin: {
              preview: {
                access: "available",
                execute: async () => ({
                  setId: "software-development",
                  setName: "Software Development",
                  revisionHash: "revision-2",
                  pluginName: "software-development",
                  pluginVersion: "0.0.0-selftune.revision2",
                  marketplaceName: "selftune-test",
                  skillNames: ["tdd"],
                  hosts: [],
                }),
              },
              execute: {
                access: "available",
                execute: async () => ({
                  setId: "software-development",
                  setName: "Software Development",
                  revisionHash: "revision-2",
                  pluginName: "software-development",
                  pluginVersion: "0.0.0-selftune.revision2",
                  marketplaceName: "selftune-test",
                  installedAt: "2026-08-09T12:00:00.000Z",
                  hosts: [],
                }),
              },
            },
          }),
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Install plugin");
  });

  it("presents hosted Skill Sets without desktop-only controls or intelligence tabs", () => {
    const html = renderToStaticMarkup(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: { ...inventory, skillSets: [] },
            isLoading: false,
            error: null,
            refresh() {},
          }),
          useIntelligence: unavailableIntelligence,
          useActions: () => ({
            ...actions,
            create: {
              access: "available",
              execute: async () => inventory.skillSets[0]!,
            },
            update: {
              access: "available",
              execute: async () => inventory.skillSets[0]!,
            },
            export: {
              access: "available",
              label: "Download Skill Set",
              execute: async () => ({
                outputPath: "software-development.json",
              }),
            },
            remove: { access: "available", execute: async () => undefined },
          }),
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Create and share reusable collections of skills and connections.");
    expect(html).toContain(
      "Create a reusable collection of skills and connections for your workspace.",
    );
    expect(html).not.toContain("local filesystem");
    expect(html).not.toContain("Suggestions");
    expect(html).not.toContain("Outcomes");
    expect(html).not.toContain("active installs");
    expect(html).not.toContain(">Create</button>");
  });

  it("presents conflict review and host-owned resolution before apply", () => {
    const resolveConflict = {
      access: "available",
      execute: async () => ({
        skillSetId: "software-development",
        skillSetName: "Software Development",
        projectRoot: "/projects/app",
        creates: 1,
        unchanged: 0,
        conflicts: 0,
        missingDependencies: 0,
        operations: [],
      }),
    } as const;
    const html = renderToStaticMarkup(
      <PlanReview
        plan={{
          skillSetId: "software-development",
          skillSetName: "Software Development",
          projectRoot: "/projects/app",
          creates: 0,
          unchanged: 0,
          conflicts: 1,
          missingDependencies: 0,
          operations: [
            {
              connection: "codex",
              skillName: "tdd",
              targetPath: "/projects/app/.agents/skills/tdd",
              action: "conflict",
              reason: "Destination differs",
            },
          ],
        }}
        actions={{ ...actions, resolveConflict }}
        onApply={() => undefined}
        onResolve={() => undefined}
      />,
    );

    expect(html).toContain("Installation preview");
    expect(html).toContain("1 conflicts");
    expect(html).toContain("Resolve");
    expect(html).toContain("Apply Skill Set");
    expect(html).toContain("disabled");
  });

  it("shows dependency verification progress while a remote apply is pending", () => {
    const html = renderToStaticMarkup(
      <PlanReview
        plan={{
          skillSetId: "software-development",
          skillSetName: "Software Development",
          projectRoot: "/projects/app",
          creates: 1,
          unchanged: 0,
          conflicts: 0,
          missingDependencies: 2,
          operations: [],
        }}
        actions={{
          ...actions,
          apply: {
            access: "available",
            isPending: true,
            execute: async () => ({
              id: "receipt-1",
              skillSetId: "software-development",
              skillSetName: "Software Development",
              projectRoot: "/projects/app",
              status: "applied",
              operationCount: 1,
              dependenciesDownloaded: 2,
            }),
          },
        }}
        onApply={() => undefined}
        onResolve={() => undefined}
      />,
    );

    expect(html).toContain("Downloading and verifying 2 skills");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });

  it("renders classified Sync & Backup failures with actionable retry guidance", () => {
    const failure = projectActionFailure({
      code: "API_ERROR",
      message: "Sync & Backup could not be reached.",
      suggestion: "Check the connection and retry the same apply.",
      retryable: true,
    });
    const html = renderToStaticMarkup(<ProjectActionNotice failure={failure} />);

    expect(html).toContain("Sync &amp; Backup is offline");
    expect(html).toContain("Sync &amp; Backup could not be reached.");
    expect(html).toContain("Check the connection and retry the same apply.");
    expect(html).toContain("You can retry without changing the project.");
  });

  it.each([
    [
      "AUTH_MISSING",
      "Sync & Backup credentials were rejected.",
      "Sync & Backup authentication required",
    ],
    ["FILE_NOT_FOUND", "Pinned revision is unavailable.", "Pinned skill unavailable"],
    [
      "OPERATION_FAILED",
      "Downloaded revision failed package verification.",
      "Skill verification failed",
    ],
  ])("classifies %s apply failures", (code, message, title) => {
    expect(projectActionFailure({ code, message, retryable: false }).title).toBe(title);
  });

  it("renders retryable errors and deliberate unavailable and upgrade states", () => {
    const error = renderToStaticMarkup(
      <DashboardHostProvider
        modules={adapter({
          access: "available",
          useInventory: () => ({
            data: null,
            isLoading: false,
            error: "Local server is offline.",
            refresh() {},
          }),
          useIntelligence: unavailableIntelligence,
          useActions: () => actions,
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );
    const unavailable = renderToStaticMarkup(
      <DashboardHostProvider
        modules={adapter({
          access: "unavailable",
          reason: "Projects are disabled.",
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );
    const upgrade = renderToStaticMarkup(
      <DashboardHostProvider modules={adapter({ access: "upgrade", href: "/upgrade/projects" })}>
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(error).toContain("Skill Sets could not be loaded");
    expect(error).toContain("Retry");
    expect(unavailable).toContain("Projects are disabled.");
    expect(upgrade).toContain('href="/upgrade/projects"');
  });
});
