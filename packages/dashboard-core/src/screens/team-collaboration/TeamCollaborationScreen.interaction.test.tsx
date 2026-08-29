// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardHostProvider,
  type DashboardHostModules,
  type DashboardTeamCollaborationActions,
} from "../../host";
import type { TeamCollaborationSnapshotModel } from "../../models";
import { hostModules } from "../../test/host-modules";
import { TeamCollaborationScreen } from "./TeamCollaborationScreen";

afterEach(cleanup);

const unavailableAction = {
  access: "unavailable",
  reason: "Workspace admin permission required.",
} as const;

const snapshot: TeamCollaborationSnapshotModel = {
  entries: [
    {
      id: "skill-tdd",
      name: "tdd",
      rolloutPolicy: "automatic",
      currentVersion: "2.4.0",
      pendingContributions: 1,
      installations: 2,
      conflicts: 1,
    },
  ],
  contributions: [
    {
      id: "candidate-pending",
      entryId: "skill-tdd",
      entryName: "tdd",
      baseVersionId: "version-240",
      baseVersion: "2.4.0",
      candidateVersion: "2.4.1",
      candidateContentHash: "c9b0d91adfa27f1b9baea5028e78d3fe8eb612ec099547d3a77d6b741f54db0a",
      files: [],
      changes: [
        {
          path: "SKILL.md",
          kind: "modified",
          baseHash: "aae2fcbb8193b721ed4acc474b29d4f81f76d798186832b03238a47bc16c3b97",
          candidateHash: "9ea539d95f66f41e6ce6ed729ef8dd67074d6e3de8d95ca881319c551067a48b",
        },
        {
          path: "references/checklist.md",
          kind: "added",
          baseHash: null,
          candidateHash: "397f08c4fab8500c93b744eb647961a448d66ea852e69bec516fa56c2dc30f9b",
        },
      ],
      summary: "Add a deterministic red-green-refactor checklist.",
      submittedBy: "member-1",
      submittedByName: "Mira Haddad",
      status: "pending",
      reviewedBy: null,
      adoptedVersionId: null,
      createdAt: "2026-07-31T08:14:00.000Z",
      reviewedAt: null,
    },
    {
      id: "candidate-adopted",
      entryId: "skill-tdd",
      entryName: "tdd",
      baseVersionId: "version-230",
      baseVersion: "2.3.0",
      candidateVersion: "2.4.0",
      candidateContentHash: "39f5aa99dfa27f1b9baea5028e78d3fe8eb612ec099547d3a77d6b741f54af25",
      files: [],
      changes: [],
      efficacyEvidence: {
        summary: "Passed the attached refund-routing evaluation without a measured regression.",
        evaluatedCases: 24,
        passedCases: 22,
        regressionCount: 0,
      },
      summary: "Clarify the regression gate.",
      submittedBy: "member-2",
      submittedByName: "Rami Odeh",
      status: "adopted",
      reviewedBy: "admin-1",
      adoptedVersionId: "version-240",
      createdAt: "2026-07-30T08:14:00.000Z",
      reviewedAt: "2026-07-30T09:00:00.000Z",
    },
  ],
  installations: [
    {
      id: "installation-1",
      entryId: "skill-tdd",
      entryName: "tdd",
      deviceId: "design-macbook",
      installedVersion: "2.3.0",
      installedContentHash: "31ec68004ea5a707977d61e987a57209768585c11066990f9497877ef122f900",
      latestVersion: "2.4.0",
      latestContentHash: "be0c095b6a3430afde8cbbacb21b2220e256ff1598cc1a5e9c4cff60bbdc9443",
      rolloutPolicy: "automatic",
      updateStatus: "conflict",
      lastSyncedAt: "2026-07-31T08:20:00.000Z",
      lastConflictAt: "2026-07-31T08:20:00.000Z",
      lastReceiptId: "71b94453-76bb-4a43-91b3-d3ff8433a49d",
    },
  ],
};

function makeModules(
  actions: DashboardTeamCollaborationActions,
  refresh = vi.fn(async () => undefined),
): DashboardHostModules {
  return hostModules({
    capability: { host: "cloud", plan: "team", features: {} },
    teamCollaboration: {
      collaboration: {
        access: "available",
        useSnapshot: () => ({
          data: snapshot,
          isLoading: false,
          error: null,
          refresh,
        }),
        useActions: () => actions,
      },
    },
  });
}

describe("TeamCollaborationScreen", () => {
  it("leads with teammate updates and keeps technical identifiers behind details", () => {
    render(
      <DashboardHostProvider
        modules={makeModules({
          updateRolloutPolicy: unavailableAction,
          adoptContribution: unavailableAction,
          rejectContribution: unavailableAction,
          rollbackContribution: unavailableAction,
        })}
      >
        <TeamCollaborationScreen />
      </DashboardHostProvider>,
    );

    expect(screen.getByText(/About privacy and sharing/i)).toBeTruthy();
    expect(screen.getByText(/information is included in a team update/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Review path" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Updates from your team" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skill" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(
      screen.getByText(/Raw prompts, transcripts, and usage content are not included/i),
    ).toBeTruthy();
    expect(screen.getByText(/Optional usage signals are separate/i)).toBeTruthy();
    expect(screen.getAllByText("SKILL.md")).toHaveLength(2);
    expect(screen.getAllByText("references/checklist.md")).toHaveLength(2);
    const packageHash = screen.getByText(snapshot.contributions[0]!.candidateContentHash);
    expect(packageHash.closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("member-1")).toBeTruthy();
    expect(screen.getByText("version-240")).toBeTruthy();
    expect(screen.getByText("Not tested")).toBeTruthy();
    expect(screen.getByText(/No test results were included/i)).toBeTruthy();
    expect(screen.getByText("Tested")).toBeTruthy();
    expect(screen.getByText(/Passed the attached refund-routing evaluation/i)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Update setting for tdd" }).textContent).toContain(
      "Update automatically",
    );
    expect(screen.getByText("Needs attention")).toBeTruthy();
    const receipt = screen.getByText(/71b94453-76/);
    expect(receipt.closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("adopts, rejects, and rolls back through review-before-mutation actions", async () => {
    const adopt = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    render(
      <DashboardHostProvider
        modules={makeModules(
          {
            updateRolloutPolicy: unavailableAction,
            adoptContribution: { access: "available", execute: adopt },
            rejectContribution: { access: "available", execute: reject },
            rollbackContribution: { access: "available", execute: rollback },
          },
          refresh,
        )}
      >
        <TeamCollaborationScreen />
      </DashboardHostProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept update" }));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith("candidate-pending"));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith("candidate-pending"));

    expect(screen.getByText(/Team copies set to update automatically receive/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo update" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("candidate-adopted"));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a host has no collaboration contribution", () => {
    render(
      <DashboardHostProvider modules={hostModules()}>
        <TeamCollaborationScreen />
      </DashboardHostProvider>,
    );

    expect(screen.getByText("Team collaboration unavailable")).toBeTruthy();
    expect(screen.getByText(/has not connected team collaboration yet/i)).toBeTruthy();
  });
});
