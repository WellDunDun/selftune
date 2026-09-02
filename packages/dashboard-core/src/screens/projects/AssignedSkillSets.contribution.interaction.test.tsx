// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardAssignedSkillSetsContribution } from "../../host";
import type { ProjectAssignedSkillSetModel } from "../../models";
import { AssignedSkillSets } from "./AssignedSkillSets";

afterEach(cleanup);

const unavailableAction = { access: "unavailable", reason: "offline" } as const;
const assignment = {
  assignmentId: "assignment-1",
  requestId: "assign-request-1",
  skillSetId: "engineering",
  releaseId: "release-1",
  releaseName: "Engineering",
  description: "Reviewed engineering workflows",
  releaseSequence: 1,
  publisherName: "Nadine Khalaf",
  assignedAt: "2026-08-31T09:00:00.000Z",
  skillSetRevisionSha256: "1".repeat(64),
  envelopeSha256: "2".repeat(64),
  canInstall: false,
  canRollback: false,
  syncStatus: "synced",
  status: "current",
  receiptId: "receipt-1",
  failure: null,
  contribution: {
    status: "local_only" as const,
    summary: "Local edits are ready to preview.",
  },
} satisfies ProjectAssignedSkillSetModel;

const preview = {
  assignmentId: "assignment-1",
  requestId: "contribute:assignment-1:1",
  skillSetId: "engineering",
  baseReleaseId: "release-1",
  baseReleaseSequence: 1,
  title: "Clarify incident handoff",
  message: "Please review the updated escalation instructions.",
  proposedSkillSetRevisionSha256: "3".repeat(64),
  proposedEnvelopeSha256: "4".repeat(64),
  proposedByteLength: 4_096,
  changes: [
    {
      componentName: "incident-handoff",
      filePath: "skills/incident-handoff/SKILL.md",
      changeType: "modified" as const,
      summary: "Clarifies when to escalate.",
      exactDiff: "- Escalate when needed\n+ Escalate after two failed attempts",
    },
  ],
};

function contribution(
  value: ProjectAssignedSkillSetModel,
  contributionActions: NonNullable<
    ReturnType<
      Extract<DashboardAssignedSkillSetsContribution, { access: "available" }>["useActions"]
    >["contribute"]
  >,
  refresh = vi.fn(),
): DashboardAssignedSkillSetsContribution {
  return {
    access: "available",
    useAssignments: () => ({ data: [value], isLoading: false, error: null, refresh }),
    useActions: () => ({
      previewInstall: unavailableAction,
      install: unavailableAction,
      rollback: unavailableAction,
      contribute: contributionActions,
    }),
  };
}

describe("assigned Skill Set contributions", () => {
  it("previews locally before a separate confirmation sends bytes for review", async () => {
    const refresh = vi.fn();
    const previewContribution = vi.fn().mockResolvedValue(preview);
    const send = vi.fn().mockResolvedValue({
      contributionId: "contribution-1",
      requestId: preview.requestId,
      status: "pending",
    });
    render(
      <AssignedSkillSets
        contribution={contribution(
          assignment,
          {
            preview: { access: "available", execute: previewContribution },
            send: { access: "available", execute: send },
          },
          refresh,
        )}
      />,
    );

    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview contribution" }));
    await waitFor(() => expect(previewContribution).toHaveBeenCalledWith("assignment-1"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Nothing has left this device.")).toBeTruthy();
    expect(
      within(dialog).getByText(/Send for review uploads the proposed Skill Set package/),
    ).toBeTruthy();
    expect(within(dialog).getByText("skills/incident-handoff/SKILL.md")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    const details = within(dialog).getByText("Technical details").closest("details");
    if (!details) throw new Error("Expected collapsed contribution details.");
    expect(details.hasAttribute("open")).toBe(false);
    expect(within(details).getByText(/Escalate after two failed attempts/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Send for review" }));
    const confirmation = screen.getAllByRole("dialog").at(-1);
    if (!confirmation) throw new Error("Expected send confirmation.");
    expect(within(confirmation).getByText("Send this contribution for review?")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Send package" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        assignmentId: "assignment-1",
        requestId: preview.requestId,
        expectedBaseReleaseId: "release-1",
        expectedSkillSetRevisionSha256: "3".repeat(64),
        expectedEnvelopeSha256: "4".repeat(64),
        confirmShare: true,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it.each([
    ["offline" as const, "Saved locally. Reconnect to send it for review."],
    ["pending" as const, "Waiting to send this contribution for review."],
    ["failed" as const, "This contribution could not be sent."],
  ])("explains the %s state without automatic submission", (status, message) => {
    render(
      <AssignedSkillSets
        contribution={contribution(
          {
            ...assignment,
            contribution: { status, summary: message },
          },
          { preview: unavailableAction, send: unavailableAction },
        )}
      />,
    );

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByText("SelfTune never submits local changes automatically.")).toBeTruthy();
  });
});
