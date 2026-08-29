import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";

import type { ProjectSkillSetPackModel } from "../../models";
import { SharedSkillSetPacks } from "./SharedSkillSetPacks";

const refresh = fn();
const onCreatePack = fn();

const activePack: ProjectSkillSetPackModel = {
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

const meta = {
  component: SharedSkillSetPacks,
  tags: ["ai-generated"],
  args: {
    query: { data: [], isLoading: false, error: null, refresh },
    revoke: undefined,
    onCreatePack,
  },
} satisfies Meta<typeof SharedSkillSetPacks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { query: { data: null, isLoading: true, error: null, refresh } },
};

export const Empty: Story = {
  play: async ({ canvas, userEvent }) => {
    const buttons = canvas.getAllByRole("button", { name: "Share a Skill Set" });
    const emptyStateButton = buttons.at(-1);
    if (!emptyStateButton) throw new TypeError("Expected an empty-state share button.");
    await userEvent.click(emptyStateButton);
    await expect(onCreatePack).toHaveBeenCalled();
  },
};

export const Error: Story = {
  args: {
    query: {
      data: null,
      isLoading: false,
      error: "The shared Pack registry is unavailable.",
      refresh,
    },
  },
};

export const ActivePack: Story = {
  args: {
    query: { data: [activePack], isLoading: false, error: null, refresh },
  },
};
