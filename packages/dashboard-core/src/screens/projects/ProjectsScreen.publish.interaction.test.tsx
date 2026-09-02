// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardHostProvider,
  type DashboardHostModules,
  type DashboardProjectsActions,
} from "../../host";
import type { ProjectSkillSetPublishPreviewModel, ProjectsInventoryModel } from "../../models";
import { hostModules } from "../../test/host-modules";
import { ProjectsScreen } from "./ProjectsScreen";

afterEach(cleanup);

const revisionSha256 = "1".repeat(64);
const envelopeSha256 = "2".repeat(64);
const inventory: ProjectsInventoryModel = {
  skillSets: [
    {
      id: "research-team",
      name: "Research team",
      description: "Shared research workflows",
      connections: ["codex"],
      skills: [
        {
          name: "research",
          packagePath: "/private/skills/research",
          contentHash: "3".repeat(64),
        },
      ],
      revision: 1,
      revisionHash: "local-revision-hash",
      updatedAt: "2026-08-31T09:00:00.000Z",
    },
  ],
  availableSkills: [],
  receipts: [],
};

const unavailable = { access: "unavailable", reason: "unused" } satisfies {
  readonly access: "unavailable";
  readonly reason: string;
};

function adapter(actions: DashboardProjectsActions): DashboardHostModules {
  return hostModules({
    skillSets: {
      library: unavailable,
      projects: {
        access: "available",
        useInventory: () => ({ data: inventory, isLoading: false, error: null, refresh() {} }),
        useIntelligence: () => unavailable,
        useActions: () => actions,
      },
    },
  });
}

describe("Skill Set team publishing", () => {
  it("reviews plain-language contents and binds explicit confirmation to both release hashes", async () => {
    const preview: ProjectSkillSetPublishPreviewModel = {
      skillSetId: "research-team",
      name: "Research team",
      description: "Shared research workflows",
      connections: ["codex"],
      skillSetRevisionSha256: revisionSha256,
      envelopeSha256,
      byteLength: 4_096,
      contents: [
        {
          name: "research",
          revisionSha256: "3".repeat(64),
          license: "MIT",
        },
      ],
      dependencies: {
        lock: {
          entries: [
            {
              package_id: "research",
              version: "1.0.0",
              revision_sha256: "3".repeat(64),
              dependency_kind: "root",
            },
          ],
        },
        impact: { added: ["research@1.0.0"], changed: [], removed: [], unchanged: [] },
      },
      dependencyInput: {
        roots: ["research"],
        available_packages: [
          {
            package_id: "research",
            version: "1.0.0",
            revision_sha256: "3".repeat(64),
            dependencies: { requires: [], optional: [], conflicts: [] },
            compatibility: { harnesses: ["codex"], required_capabilities: [] },
            provides: [],
          },
        ],
        environment: { harness: "codex", capabilities: [] },
        current_lock: [],
      },
      checks: [
        {
          id: "portable_envelope",
          status: "passed",
          title: "Portable release is valid",
          detail: "SelfTune can verify this exact release before installation.",
        },
        {
          id: "distribution_terms",
          status: "passed",
          title: "Distribution terms are included",
          detail: "Every skill in this release includes license information.",
        },
      ],
      confirmation: {
        required: true,
        title: "Publish Research team to your team?",
        detail: "This uploads only the reviewed portable release shown above.",
      },
    };
    const receipt = {
      releaseId: "release_123",
      skillSetId: "research-team",
      sequence: 3,
      skillSetRevisionSha256: revisionSha256,
      envelopeSha256,
      publishedAt: "2026-08-31T10:00:00.000Z",
      idempotent: false,
    };
    const previewPublish = vi.fn().mockResolvedValue(preview);
    const publish = vi.fn().mockResolvedValue(receipt);
    const actions: DashboardProjectsActions = {
      create: unavailable,
      update: unavailable,
      derive: unavailable,
      export: unavailable,
      publishRelease: {
        preview: { access: "available", execute: previewPublish },
        execute: { access: "available", execute: publish },
      },
      share: {
        access: "available",
        capabilities: { linkModes: ["private_single_claim"], deliveries: ["copy_link"] },
        execute: vi.fn(),
      },
      remove: unavailable,
      plan: unavailable,
      apply: unavailable,
      resolveConflict: unavailable,
      decideConflict: unavailable,
      rollbackConflict: unavailable,
      rollback: unavailable,
      reviewSuggestion: unavailable,
    };

    render(
      <DashboardHostProvider modules={adapter(actions)}>
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    expect(screen.getByRole("button", { name: "Send a link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish to team" }));

    await waitFor(() =>
      expect(previewPublish).toHaveBeenCalledWith({
        skillSetId: "research-team",
        dependencyResolution: preview.dependencyInput,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Publish Research team to your team?")).toBeTruthy();
    expect(within(dialog).getAllByText("research")).toHaveLength(2);
    expect(within(dialog).getByText("MIT license")).toBeTruthy();
    expect(within(dialog).getByText("Portable release is valid")).toBeTruthy();
    expect(within(dialog).getByText("Distribution terms are included")).toBeTruthy();
    expect(within(dialog).getByText("1 package added")).toBeTruthy();
    expect(within(dialog).getByText("research@1.0.0")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This creates a team release. It does not send a link or install it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("/private/skills/research")).toBeNull();
    const technicalDetails = within(dialog).getByText("Technical details").closest("details");
    if (!technicalDetails) throw new Error("Expected technical release details.");
    expect(within(technicalDetails).getByText(revisionSha256)).toBeTruthy();
    expect(within(technicalDetails).getByText(envelopeSha256)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Publish to team" }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith({
        skillSetId: "research-team",
        expectedSkillSetRevisionSha256: revisionSha256,
        expectedEnvelopeSha256: envelopeSha256,
        dependencyResolution: preview.dependencyInput,
        expectedDependencyLock: preview.dependencies.lock,
        confirmPublish: true,
      }),
    );
    expect(await within(dialog).findByText("Published to team")).toBeTruthy();
    expect(within(dialog).getByText("Release 3 is ready.")).toBeTruthy();
    expect(within(dialog).getByText("release_123")).toBeTruthy();
  });

  it("keeps the review open and explains when a release cannot be prepared", async () => {
    const previewPublish = vi
      .fn()
      .mockRejectedValue(new Error("An active Team plan is required to publish."));
    const actions: DashboardProjectsActions = {
      create: unavailable,
      update: unavailable,
      derive: unavailable,
      export: unavailable,
      publishRelease: {
        preview: { access: "available", execute: previewPublish },
        execute: { access: "available", execute: vi.fn() },
      },
      remove: unavailable,
      plan: unavailable,
      apply: unavailable,
      resolveConflict: unavailable,
      decideConflict: unavailable,
      rollbackConflict: unavailable,
      rollback: unavailable,
      reviewSuggestion: unavailable,
    };

    render(
      <DashboardHostProvider modules={adapter(actions)}>
        <ProjectsScreen />
      </DashboardHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish to team" }));

    const dialog = await screen.findByRole("dialog");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("An active Team plan is required to publish.");
    expect(within(dialog).queryByRole("button", { name: "Publish to team" })).toBeNull();
  });
});
