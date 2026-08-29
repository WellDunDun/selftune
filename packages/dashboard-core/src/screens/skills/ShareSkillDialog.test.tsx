// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardLibraryActions } from "../../host";
import type { LibrarySkillModel } from "../../models";
import { ShareSkillDialog } from "./ShareSkillDialog";

vi.mock("@selftune/ui/components", () => ({
  PierreDiffReview: ({ files }: { files: Array<{ path: string }> }) => (
    <div data-testid="pierre-review">{files.map((file) => file.path).join(", ")}</div>
  ),
}));

afterEach(cleanup);

const skill: LibrarySkillModel = {
  id: "adversarial-reviewer",
  name: "adversarial-reviewer",
  lifecycle: "active",
  status: "Ready",
  updateStatus: "current",
  sources: [],
  locations: [],
  revisionHashes: ["a".repeat(64)],
};

function action(execute: ReturnType<typeof vi.fn>): NonNullable<DashboardLibraryActions["share"]> {
  return { access: "available", execute };
}

describe("ShareSkillDialog", () => {
  it("creates a reusable link by default", async () => {
    const execute = vi.fn(async () => ({
      shareId: "share-1",
      mode: "reusable_unlisted" as const,
      delivery: "copy_link" as const,
      shareUrl: "https://cloud.selftune.dev/s/token",
      expiresAt: "2026-08-01T00:00:00.000Z",
    }));
    render(
      <ShareSkillDialog skill={skill} action={action(execute)} open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        skillId: skill.id,
        mode: "reusable_unlisted",
        delivery: "copy_link",
      }),
    );
    expect(screen.getByDisplayValue("https://cloud.selftune.dev/s/token")).toBeTruthy();
  });

  it("sends an email-bound private invitation", async () => {
    const execute = vi.fn(async () => ({
      shareId: "share-2",
      mode: "private_single_claim" as const,
      delivery: "email" as const,
      expiresAt: "2026-08-01T00:00:00.000Z",
    }));
    render(
      <ShareSkillDialog skill={skill} action={action(execute)} open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Email invite/ }));
    fireEvent.change(screen.getByLabelText("Recipient email"), {
      target: { value: " Person@Example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        skillId: skill.id,
        mode: "private_single_claim",
        delivery: "email",
        recipientEmail: "person@example.com",
      }),
    );
    expect(screen.getByText("Invitation sent to person@example.com.")).toBeTruthy();
  });

  it("recovers from a missing license through reviewed Pierre diff approval", async () => {
    const share = vi.fn(async () => {
      throw new Error("Add a license field to SKILL.md or bundle a LICENSE file before sharing.");
    });
    const preview = vi.fn(async () => ({
      previewId: "preview-1",
      skillPath: "/skills/adversarial-reviewer",
      licenseExpression: "LicenseRef-Ithraa-Center-Proprietary",
      files: [
        { path: "SKILL.md" as const, patch: "skill patch" },
        { path: "LICENSE" as const, patch: "license patch" },
      ],
    }));
    const apply = vi.fn(async (input) => ({
      ...(await preview()),
      previewId: input.previewId,
    }));
    render(
      <ShareSkillDialog
        skill={skill}
        action={action(share)}
        previewLicenseAction={{ access: "available", execute: preview }}
        applyLicenseAction={{ access: "available", execute: apply }}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByRole("button", { name: "Draft a license" });
    fireEvent.click(screen.getByRole("button", { name: "Draft a license" }));
    fireEvent.change(screen.getByLabelText("Copyright holder"), {
      target: { value: "Daniel Petro" },
    });
    fireEvent.change(screen.getByLabelText("Licensed organization"), {
      target: { value: "Ithraa Center" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));

    expect((await screen.findByTestId("pierre-review")).textContent).toBe("SKILL.md, LICENSE");
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed license" }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: skill.id,
          previewId: "preview-1",
          terms: expect.objectContaining({
            copyrightHolder: "Daniel Petro",
            licensedOrganization: "Ithraa Center",
          }),
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
  });
});
