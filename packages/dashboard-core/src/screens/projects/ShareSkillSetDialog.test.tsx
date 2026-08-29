// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardProjectsActions } from "../../host";
import type { ProjectSkillSetModel } from "../../models";
import { ShareSkillSetDialog } from "./ShareSkillSetDialog";

vi.mock("@selftune/ui/components", () => ({
  PierreDiffReview: ({ files }: { files: Array<{ path: string }> }) => (
    <div data-testid="pierre-review">{files.map((file) => file.path).join(", ")}</div>
  ),
}));

afterEach(cleanup);

const skillSet: ProjectSkillSetModel = {
  id: "review-set",
  name: "Review Set",
  description: "Review workflow",
  connections: ["codex"],
  skills: [{ name: "reviewer", packagePath: "/skills/reviewer", contentHash: "a".repeat(64) }],
  revision: 1,
  revisionHash: "b".repeat(64),
  updatedAt: "2026-07-22T00:00:00.000Z",
};

function action(execute: ReturnType<typeof vi.fn>) {
  return {
    access: "available" as const,
    execute,
  } satisfies Extract<NonNullable<DashboardProjectsActions["share"]>, { access: "available" }>;
}

describe("ShareSkillSetDialog", () => {
  it("shares the entire Skill Set with a reusable link", async () => {
    const execute = vi.fn(async () => ({
      shareId: "share-1",
      mode: "reusable_unlisted" as const,
      delivery: "copy_link" as const,
      shareUrl: "https://cloud.selftune.dev/shared/token",
      expiresAt: "2026-08-22T00:00:00.000Z",
    }));
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={action(execute)}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        skillSetId: skillSet.id,
        mode: "reusable_unlisted",
        delivery: "copy_link",
      }),
    );
    expect(screen.getByDisplayValue("https://cloud.selftune.dev/shared/token")).toBeTruthy();
  });

  it("sends a private email invitation", async () => {
    const execute = vi.fn(async () => ({
      shareId: "share-2",
      mode: "private_single_claim" as const,
      delivery: "email" as const,
      expiresAt: "2026-08-22T00:00:00.000Z",
    }));
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={action(execute)}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /People & workspace/ }));
    const recipient = screen.getByRole("combobox", { name: "Share with" });
    fireEvent.change(recipient, {
      target: { value: " Person@Example.com " },
    });
    expect(recipient.getAttribute("aria-expanded")).not.toBeNull();
    fireEvent.click(within(recipient.closest('[role="group"]')!).getByRole("button"));
    fireEvent.click(screen.getByRole("option", { name: "person@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        skillSetId: skillSet.id,
        mode: "private_single_claim",
        delivery: "email",
        recipientEmail: "person@example.com",
      }),
    );
  });

  it("shares with the entire workspace from the recipient combobox", async () => {
    const execute = vi.fn();
    const shareWithWorkspace = vi.fn(async () => undefined);
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={action(execute)}
        recipients={[{ email: "member@example.com", name: "Workspace Member" }]}
        workspaceAction={{ access: "available", execute: shareWithWorkspace }}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /People & workspace/ }));
    const recipient = screen.getByRole("combobox", { name: "Share with" });
    fireEvent.click(within(recipient.closest('[role="group"]')!).getByRole("button"));
    expect(screen.getByRole("option", { name: /Workspace Member/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Entire workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Share with workspace" }));

    await waitFor(() => expect(shareWithWorkspace).toHaveBeenCalledWith(skillSet.id));
    expect(execute).not.toHaveBeenCalled();
  });

  it("drafts and applies a missing license before retrying Skill Set sharing", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Every included skill needs distributable license evidence.");
    });
    const preview = vi.fn(async () => ({
      previewId: "preview-1",
      skillPath: "/skills/reviewer",
      licenseExpression: "LicenseRef-Ithraa-Center-Proprietary",
      files: [
        { path: "SKILL.md" as const, patch: "skill patch" },
        { path: "LICENSE" as const, patch: "license patch" },
      ],
    }));
    const apply = vi.fn(async () => preview());
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={action(execute)}
        previewLicenseAction={{ access: "available", execute: preview }}
        applyLicenseAction={{ access: "available", execute: apply }}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft missing license" }));
    expect((screen.getByLabelText("Skill needing a license") as HTMLSelectElement).value).toBe(
      "reviewer",
    );
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
        expect.objectContaining({ skillId: "reviewer", previewId: "preview-1" }),
      ),
    );
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
  });
});
