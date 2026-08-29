// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardProjectsAction } from "../../host";
import type { ProjectSkillSetPackModel } from "../../models";
import { SharedSkillSetPacks } from "./SharedSkillSetPacks";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pack: ProjectSkillSetPackModel = {
  packId: "pack-1",
  artifactId: "skill-set/review/revision",
  name: "Release review",
  description: "Pinned release review skills",
  mode: "reusable_unlisted",
  status: "active",
  packUrl: `https://cloud.selftune.dev/p/${"A".repeat(43)}`,
  expiresAt: "2026-09-07T10:00:00.000Z",
  createdAt: "2026-08-08T10:00:00.000Z",
  claimedAt: null,
  revokedAt: null,
  skillSetRevisionSha256: "b".repeat(64),
  objectSha256: "c".repeat(64),
  componentCount: 3,
};

describe("SharedSkillSetPacks", () => {
  it("copies an active managed link and confirms revocation", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execute = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const revoke = {
      access: "available" as const,
      execute,
    } satisfies DashboardProjectsAction<string, void>;

    render(
      <SharedSkillSetPacks
        query={{ data: [pack], isLoading: false, error: null, refresh }}
        revoke={revoke}
        onCreatePack={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(pack.packUrl));

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByText("Revoke Release review?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Pack" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(pack.packId));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("provides an actionable empty state", () => {
    const onCreatePack = vi.fn();
    render(
      <SharedSkillSetPacks
        query={{ data: [], isLoading: false, error: null, refresh: () => undefined }}
        revoke={undefined}
        onCreatePack={onCreatePack}
      />,
    );
    expect(screen.getByText("No shared Packs yet")).toBeTruthy();
    const [shareButton] = screen.getAllByRole("button", { name: "Share a Skill Set" });
    if (!shareButton) throw new TypeError("Expected Share a Skill Set button.");
    fireEvent.click(shareButton);
    expect(onCreatePack).toHaveBeenCalled();
  });
});
