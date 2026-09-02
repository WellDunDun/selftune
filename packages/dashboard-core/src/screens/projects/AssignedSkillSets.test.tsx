import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  DashboardAssignedSkillSetsActions,
  DashboardAssignedSkillSetsContribution,
} from "../../host";
import type { ProjectAssignedSkillSetModel } from "../../models";
import { AssignedSkillSets } from "./AssignedSkillSets";

const unavailableAction = {
  access: "unavailable",
  reason: "This device cannot perform that action.",
} as const;

const actions: DashboardAssignedSkillSetsActions = {
  previewInstall: unavailableAction,
  install: unavailableAction,
  rollback: unavailableAction,
};

const baseAssignment = {
  assignmentId: "assignment_4",
  requestId: "request_4",
  skillSetId: "research-team",
  releaseId: "release_4",
  releaseName: "Research team",
  description: "Shared research workflows",
  releaseSequence: 4,
  publisherName: "Ada Lovelace",
  assignedAt: "2026-08-31T09:00:00.000Z",
  skillSetRevisionSha256: "1".repeat(64),
  envelopeSha256: "2".repeat(64),
  syncStatus: "synced" as const,
} as const;

function contribution(
  assignments: readonly ProjectAssignedSkillSetModel[],
): DashboardAssignedSkillSetsContribution {
  return {
    access: "available",
    useAssignments: () => ({
      data: assignments,
      isLoading: false,
      error: null,
      refresh() {},
    }),
    useActions: () => actions,
  };
}

describe("assigned Skill Sets", () => {
  it("renders truthful receipt states and keeps identifiers collapsed", () => {
    const html = renderToStaticMarkup(
      <AssignedSkillSets
        contribution={contribution([
          {
            ...baseAssignment,
            assignmentId: "assignment_unknown",
            status: "unknown",
            receiptId: null,
            failure: null,
            canInstall: false,
            canRollback: false,
          },
          {
            ...baseAssignment,
            assignmentId: "assignment_current",
            syncStatus: "pending",
            status: "current",
            receiptId: "receipt_current",
            failure: null,
            canInstall: false,
            canRollback: false,
          },
          {
            ...baseAssignment,
            assignmentId: "assignment_failed",
            status: "failed",
            receiptId: "receipt_failed",
            failure: {
              code: "DESTINATION_CONFLICT",
              message: "One installed skill has local changes.",
              guidance: "Review the conflict, then try the install again.",
            },
            canInstall: false,
            canRollback: false,
          },
          {
            ...baseAssignment,
            assignmentId: "assignment_rolled_back",
            status: "rolled_back",
            receiptId: "receipt_rolled_back",
            failure: null,
            canInstall: false,
            canRollback: false,
          },
        ])}
      />,
    );

    expect(html).toContain("Assigned to this device");
    expect(html).toContain("Published by Ada Lovelace");
    expect(html).toContain("Release 4");
    expect(html).toContain("Unknown");
    expect(html).toContain("Current");
    expect(html).toContain("Failed");
    expect(html).toContain("Rolled back");
    expect(html).toContain("No installation receipt has been received from this device.");
    expect(html).toContain("One installed skill has local changes.");
    expect(html).toContain("Review the conflict, then try the install again.");
    expect(html).toContain("Installed locally; waiting to update Team status.");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("assignment_unknown");
    expect(html).toContain("request_4");
    expect(html).not.toContain("terminal");
  });

  it("fails closed when the host cannot provide assignments", () => {
    const html = renderToStaticMarkup(
      <AssignedSkillSets
        contribution={{
          access: "unavailable",
          reason: "Link this device before reviewing team assignments.",
        }}
      />,
    );

    expect(html).toContain("Assigned to this device");
    expect(html).toContain("Link this device before reviewing team assignments.");
    expect(html).not.toContain("Review install");
    expect(html).not.toContain("Undo install");
  });

  it("hides install controls when the host cannot perform them", () => {
    const html = renderToStaticMarkup(
      <AssignedSkillSets
        contribution={contribution([
          {
            ...baseAssignment,
            status: "unknown",
            receiptId: null,
            failure: null,
            canInstall: true,
            canRollback: false,
          },
        ])}
      />,
    );

    expect(html).toContain("Unknown");
    expect(html).not.toContain("Review install");
    expect(html).not.toContain("Undo install");
  });
});
