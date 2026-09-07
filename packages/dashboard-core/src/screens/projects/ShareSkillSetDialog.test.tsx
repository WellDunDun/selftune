// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardProjectsActions } from "../../host";
import type { ProjectSkillSetModel } from "../../models";
import { ShareSkillSetDialog } from "./ShareSkillSetDialog";

const VALID_SKILL_PATCH =
  "diff --git a/SKILL.md b/SKILL.md\nindex 1111111..2222222 100644\n--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1,2 @@\n # Reviewer\n+license: LicenseRef-Ithraa-Center-Proprietary";
const VALID_LICENSE_PATCH =
  "diff --git a/LICENSE b/LICENSE\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/LICENSE\n@@ -0,0 +1 @@\n+Internal use only.";

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

function action(
  execute: Extract<
    NonNullable<DashboardProjectsActions["share"]>,
    { access: "available" }
  >["execute"],
) {
  return {
    access: "available" as const,
    execute,
  } satisfies Extract<NonNullable<DashboardProjectsActions["share"]>, { access: "available" }>;
}

function managedCloudAction(
  execute: Extract<
    NonNullable<DashboardProjectsActions["share"]>,
    { access: "available" }
  >["execute"],
): Extract<NonNullable<DashboardProjectsActions["share"]>, { access: "available" }> {
  return {
    access: "available",
    execute,
    capabilities: {
      linkModes: ["private_single_claim"],
      deliveries: ["copy_link"],
    },
  };
}

describe("ShareSkillSetDialog", () => {
  it("offers only a truthful one-time link when that is all the host supports", async () => {
    const execute = vi.fn(async () => ({
      shareId: "share-cloud-1",
      mode: "private_single_claim" as const,
      delivery: "copy_link" as const,
      shareUrl: "https://cloud.selftune.dev/share/token",
      expiresAt: "2026-09-01T00:00:00.000Z",
    }));
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={managedCloudAction(execute)}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /People & workspace/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Unlisted/ })).toBeNull();
    expect(screen.getByText(/This link can be used once/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        skillSetId: skillSet.id,
        mode: "private_single_claim",
        delivery: "copy_link",
      }),
    );
  });

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
        { path: "SKILL.md" as const, patch: VALID_SKILL_PATCH },
        { path: "LICENSE" as const, patch: VALID_LICENSE_PATCH },
      ],
    }));
    const apply = vi.fn(async () => preview());
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={action(execute)}
        previewLicenseAction={{ access: "available", execute: preview }}
        applyLicenseAction={{ access: "available", execute: apply }}
        DiffReview={({ files }) => (
          <div data-testid="pierre-review">{files.map((file) => file.path).join(", ")}</div>
        )}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft missing license" }));
    expect(screen.getByLabelText("Skill needing a license")).toHaveProperty("value", "reviewer");
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
          skillId: "reviewer",
          skillSetId: "review-set",
          previewId: "preview-1",
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
  });
  it("shows draft failures and lets the user retry without leaving the draft", async () => {
    const preview = vi.fn(async () => {
      throw new Error("This skill already bundles a LICENSE file.");
    });
    render(
      <ShareSkillSetDialog
        skillSet={skillSet}
        action={action(
          vi.fn(async () => {
            throw new Error("Missing license");
          }),
        )}
        previewLicenseAction={{ access: "available", execute: preview }}
        applyLicenseAction={{ access: "available", execute: vi.fn() }}
        open
        onOpenChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft missing license" }));
    fireEvent.change(screen.getByLabelText("Copyright holder"), {
      target: { value: "Daniel Petro" },
    });
    fireEvent.change(screen.getByLabelText("Licensed organization"), {
      target: { value: "Ithraa Center" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This skill already bundles a LICENSE file.",
    );
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "reviewer", skillSetId: "review-set" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  });
  it.each(["different Set", "new revision"])(
    "uses the current skill after selecting a %s",
    async (change) => {
      const preview = vi.fn(async () => {
        throw new Error("Preview captured");
      });
      const props = {
        action: action(
          vi.fn(async () => {
            throw new Error("Missing license");
          }),
        ),
        previewLicenseAction: { access: "available" as const, execute: preview },
        applyLicenseAction: { access: "available" as const, execute: vi.fn() },
        onOpenChange: () => {},
      };
      const { rerender } = render(
        <ShareSkillSetDialog {...props} skillSet={skillSet} open={false} />,
      );
      const ithraa = {
        ...skillSet,
        id: change === "different Set" ? "ithraa-skills" : skillSet.id,
        revisionHash: "d".repeat(64),
        name: "Ithraa Skills",
        skills: [
          {
            name: "marketing-social",
            packagePath: "/library/marketing-social",
            contentHash: "c".repeat(64),
          },
        ],
      };
      rerender(<ShareSkillSetDialog {...props} skillSet={ithraa} open />);
      fireEvent.click(screen.getByRole("button", { name: "Create link" }));
      fireEvent.click(await screen.findByRole("button", { name: "Draft missing license" }));
      fireEvent.change(screen.getByLabelText("Copyright holder"), {
        target: { value: "Daniel Petro" },
      });
      fireEvent.change(screen.getByLabelText("Licensed organization"), {
        target: { value: "Ithraa Center" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
      await waitFor(() =>
        expect(preview).toHaveBeenCalledWith(
          expect.objectContaining({ skillId: "marketing-social", skillSetId: ithraa.id }),
        ),
      );
    },
  );
});
