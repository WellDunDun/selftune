import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ShareSkillSetDialog } from "./ShareSkillSetDialog";

const lines = Array.from(
  { length: 180 },
  (_, index) =>
    `+Line ${index}: Review the bundled instructions, scripts, references, and campaign assets before sharing.`,
);
const patch = [
  "diff --git a/SKILL.md b/SKILL.md",
  "--- /dev/null",
  "+++ b/SKILL.md",
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines,
].join("\n");

const meta = {
  component: ShareSkillSetDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    skillSet: {
      id: "ithraa",
      name: "Ithraa Skills",
      description: "License review",
      connections: ["codex"],
      revision: 1,
      revisionHash: "a".repeat(64),
      updatedAt: "2026-09-03T00:00:00Z",
      skills: [
        {
          name: "marketing-social",
          packagePath: "/library/marketing-social",
          contentHash: "b".repeat(64),
        },
      ],
    },
    action: {
      access: "available",
      execute: async () => {
        throw new Error("Missing license");
      },
    },
    previewLicenseAction: {
      access: "available",
      execute: async () => ({
        previewId: "draft",
        skillPath: "/library/marketing-social",
        licenseExpression: "LicenseRef-Ithraa-Proprietary",
        files: [{ path: "SKILL.md", patch }],
      }),
    },
    applyLicenseAction: {
      access: "available",
      execute: async () => {
        throw new Error("Story does not apply licenses");
      },
    },
  },
} satisfies Meta<typeof ShareSkillSetDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LongLicenseDiff: Story = {
  play: async () => {
    const screen = within(document.body);
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Draft missing license" }));
    await userEvent.type(screen.getByLabelText("Copyright holder"), "Daniel Petro");
    await userEvent.type(screen.getByLabelText("Licensed organization"), "Ithraa Center");
    await userEvent.click(screen.getByRole("button", { name: "Review draft" }));
    const apply = await screen.findByRole("button", { name: "Apply reviewed license" });
    const diff = screen.getByLabelText("License file diff");

    await waitFor(() => expect(diff.scrollHeight).toBeGreaterThan(diff.clientHeight), {
      timeout: 10000,
    });
    const dialog = screen.getByRole("dialog").getBoundingClientRect();
    expect(dialog.top).toBeGreaterThanOrEqual(0);
    expect(dialog.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(window.innerWidth);
    expect(apply.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    diff.scrollTop = diff.scrollHeight;
    expect(diff.scrollTop).toBeGreaterThan(0);
    expect(apply.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  },
};
