import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardHostProvider, type DashboardProjectsActions } from "../../host";
import type { ProjectsInventoryModel } from "../../models";
import { hostModules } from "../../test/host-modules";
import { ProjectsScreen } from "./ProjectsScreen";

const unavailable = { access: "unavailable", reason: "unused" } as const;
const inventory: ProjectsInventoryModel = {
  skillSets: [],
  availableSkills: [],
  receipts: [],
};
const projectActions: DashboardProjectsActions = {
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
};

describe("Projects assignment composition", () => {
  it("keeps team assignments separate from publishing and local project installs", () => {
    const html = renderToStaticMarkup(
      <DashboardHostProvider
        modules={hostModules({
          skillSets: {
            library: unavailable,
            projects: {
              access: "available",
              useInventory: () => ({
                data: inventory,
                isLoading: false,
                error: null,
                refresh() {},
              }),
              useIntelligence: () => unavailable,
              useActions: () => projectActions,
            },
            assignments: {
              access: "available",
              useAssignments: () => ({
                data: [
                  {
                    assignmentId: "assignment_1",
                    requestId: null,
                    skillSetId: "software-development",
                    releaseId: "release_3",
                    releaseName: "Engineering standards",
                    description: "The team's reviewed engineering workflow.",
                    releaseSequence: 3,
                    publisherName: "Platform team",
                    assignedAt: "2026-08-31T09:00:00.000Z",
                    skillSetRevisionSha256: "1".repeat(64),
                    envelopeSha256: "2".repeat(64),
                    status: "unknown",
                    receiptId: null,
                    failure: null,
                    canInstall: true,
                    canRollback: false,
                    syncStatus: "synced",
                  },
                ],
                isLoading: false,
                error: null,
                refresh() {},
              }),
              useActions: () => ({
                previewInstall: {
                  access: "available",
                  execute: async () => {
                    throw new Error("not called during render");
                  },
                },
                install: {
                  access: "available",
                  execute: async () => {
                    throw new Error("not called during render");
                  },
                },
                rollback: unavailable,
              }),
            },
          },
        })}
      >
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(html).toContain("Assigned to this device");
    expect(html).toContain("Engineering standards");
    expect(html).toContain("Review install");
    expect(html).toContain("Publishing, sharing, and assigning do not install them.");
  });
});
