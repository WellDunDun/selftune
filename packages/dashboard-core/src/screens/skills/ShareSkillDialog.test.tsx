// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardLibraryActions } from "../../host";
import type { LibrarySkillModel } from "../../models";
import { ShareSkillDialog } from "./ShareSkillDialog";

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

  it("hides email delivery when the host only supports copy links", () => {
    const execute = vi.fn();
    render(
      <ShareSkillDialog
        skill={skill}
        action={{
          ...action(execute),
          supportedDeliveryMethods: ["copy_link"],
          supportedShareModes: ["reusable_unlisted"],
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByRole("tab", { name: /Copy link/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Email invite/ })).toBeNull();
    expect(screen.queryByLabelText("Recipient email")).toBeNull();
    expect(screen.queryByLabelText("Who can use this link?")).toBeNull();
  });
});
