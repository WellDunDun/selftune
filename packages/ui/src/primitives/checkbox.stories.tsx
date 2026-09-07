import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Checkbox } from "./checkbox";

const meta = {
  component: Checkbox,
  tags: ["ai-generated"],
  args: { "aria-label": "Use sealed holdout" },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = {
  args: { defaultChecked: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("checkbox", { name: "Use sealed holdout" })).toBeChecked();
  },
};
export const Disabled: Story = { args: { disabled: true } };
