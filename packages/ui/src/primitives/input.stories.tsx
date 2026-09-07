import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Input } from "./input";

const meta = {
  component: Input,
  tags: ["ai-generated"],
  args: { "aria-label": "Skill name", placeholder: "Enter a skill name" },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Populated: Story = { args: { defaultValue: "skill-audit" } };
export const Disabled: Story = { args: { disabled: true, defaultValue: "Read only" } };
export const Invalid: Story = {
  args: { "aria-invalid": true, defaultValue: "Invalid name" },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("Skill name")).toHaveAttribute("aria-invalid", "true");
  },
};
