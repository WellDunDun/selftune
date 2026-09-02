// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DashboardAssignedSkillSetsActions,
  DashboardAssignedSkillSetsContribution,
} from "../../host";
import type {
  ProjectAssignedSkillSetInstallPreviewModel,
  ProjectAssignedSkillSetModel,
} from "../../models";
import { AssignedSkillSets } from "./AssignedSkillSets";

afterEach(cleanup);

const unavailableAction = { access: "unavailable", reason: "unused" } as const;
const revisionSha256 = "1".repeat(64);
const envelopeSha256 = "2".repeat(64);

const baseAssignment = {
  assignmentId: "assignment_4",
  requestId: "assignment-request_4",
  skillSetId: "research-team",
  releaseId: "release_4",
  releaseName: "Research team",
  description: "Shared research workflows",
  releaseSequence: 4,
  publisherName: "Ada Lovelace",
  assignedAt: "2026-08-31T09:00:00.000Z",
  skillSetRevisionSha256: revisionSha256,
  envelopeSha256,
  canInstall: true,
  canRollback: false,
  syncStatus: "synced",
  status: "unknown",
  receiptId: null,
  failure: null,
} satisfies ProjectAssignedSkillSetModel;

const preview: ProjectAssignedSkillSetInstallPreviewModel = {
  assignmentId: baseAssignment.assignmentId,
  requestId: "install-request_4",
  releaseId: baseAssignment.releaseId,
  releaseName: baseAssignment.releaseName,
  releaseSequence: baseAssignment.releaseSequence,
  publisherName: baseAssignment.publisherName,
  skillSetRevisionSha256: revisionSha256,
  envelopeSha256,
  scope: "global",
  skills: [
    {
      name: "research",
      licenseExpression: "MIT",
      revisionSha256: "3".repeat(64),
      packagePaths: ["skills/research/SKILL.md"],
    },
  ],
  tools: ["codex", "claude_code"],
  checks: [
    {
      id: "package_integrity",
      status: "passed",
      title: "Package integrity passed",
      detail: "The release matches the publisher's package hash.",
    },
  ],
  conflicts: [
    {
      code: "EXISTING_COPY",
      title: "Existing copy will be replaced",
      detail: "The existing copy matches a previous team release.",
      packagePath: "skills/research/SKILL.md",
      blocking: false,
    },
  ],
};

function contribution({
  assignments = [baseAssignment],
  actions,
  refresh = vi.fn(),
}: {
  assignments?: readonly ProjectAssignedSkillSetModel[];
  actions: DashboardAssignedSkillSetsActions;
  refresh?: ReturnType<typeof vi.fn>;
}): DashboardAssignedSkillSetsContribution {
  return {
    access: "available",
    useAssignments: () => ({ data: assignments, isLoading: false, error: null, refresh }),
    useActions: () => actions,
  };
}

describe("assigned Skill Set installation", () => {
  it("requires review and a separate explicit install confirmation", async () => {
    const refresh = vi.fn();
    const previewInstall = vi.fn().mockResolvedValue(preview);
    const install = vi.fn().mockResolvedValue({
      assignmentId: preview.assignmentId,
      requestId: preview.requestId,
      releaseId: preview.releaseId,
      receiptId: "receipt_4",
      installedAt: "2026-08-31T10:00:00.000Z",
      status: "current",
    });

    render(
      <AssignedSkillSets
        contribution={contribution({
          refresh,
          actions: {
            previewInstall: { access: "available", execute: previewInstall },
            install: { access: "available", execute: install },
            rollback: unavailableAction,
          },
        })}
      />,
    );

    expect(install).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review install" }));

    await waitFor(() => expect(previewInstall).toHaveBeenCalledWith("assignment_4"));
    expect(install).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Review Research team")).toBeTruthy();
    expect(within(dialog).getByText("research")).toBeTruthy();
    expect(within(dialog).getByText("MIT license")).toBeTruthy();
    expect(within(dialog).getByText("Codex")).toBeTruthy();
    expect(within(dialog).getByText("Claude Code")).toBeTruthy();
    expect(within(dialog).getByText("Package integrity passed")).toBeTruthy();
    expect(within(dialog).getByText("Existing copy will be replaced")).toBeTruthy();
    expect(within(dialog).getByText("This installs only on this device.")).toBeTruthy();
    expect(within(dialog).getByText("Destination: All projects on this computer")).toBeTruthy();

    const technicalDetails = within(dialog).getByText("Technical details").closest("details");
    if (!technicalDetails) throw new Error("Expected collapsed install details.");
    expect(within(technicalDetails).getByText("skills/research/SKILL.md")).toBeTruthy();
    expect(within(technicalDetails).getByText(revisionSha256)).toBeTruthy();
    expect(within(technicalDetails).getByText(envelopeSha256)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({
        assignmentId: "assignment_4",
        requestId: "install-request_4",
        expectedReleaseId: "release_4",
        expectedSkillSetRevisionSha256: revisionSha256,
        expectedEnvelopeSha256: envelopeSha256,
        confirmInstall: true,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("blocks installation when the reviewed preview has a blocking conflict", async () => {
    const install = vi.fn();
    render(
      <AssignedSkillSets
        contribution={contribution({
          actions: {
            previewInstall: {
              access: "available",
              execute: vi.fn().mockResolvedValue({
                ...preview,
                conflicts: [
                  {
                    ...preview.conflicts[0]!,
                    title: "Local changes need review",
                    blocking: true,
                  },
                ],
              }),
            },
            install: { access: "available", execute: install },
            rollback: unavailableAction,
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review install" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Local changes need review")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("requires confirmation before the host-owned rollback runs", async () => {
    const refresh = vi.fn();
    const rollback = vi.fn().mockResolvedValue({
      assignmentId: "assignment_4",
      requestId: "rollback-request_4",
      releaseId: "release_4",
      receiptId: "receipt_4",
      rolledBackAt: "2026-08-31T11:00:00.000Z",
      status: "rolled_back",
    });
    const current = {
      ...baseAssignment,
      canInstall: false,
      canRollback: true,
      status: "current",
      receiptId: "receipt_4",
      failure: null,
    } satisfies ProjectAssignedSkillSetModel;

    render(
      <AssignedSkillSets
        contribution={contribution({
          assignments: [current],
          refresh,
          actions: {
            previewInstall: unavailableAction,
            install: unavailableAction,
            rollback: { access: "available", execute: rollback },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo install" }));
    expect(rollback).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Undo this install?")).toBeTruthy();
    expect(
      within(dialog).getByText("The team assignment stays in place. Only this device is restored."),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Undo install" }));
    await waitFor(() =>
      expect(rollback).toHaveBeenCalledWith({
        assignmentId: "assignment_4",
        receiptId: "receipt_4",
        confirmRollback: true,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });
});
