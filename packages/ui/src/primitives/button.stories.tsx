import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Button } from "./button";

const meta = {
  component: Button,
  tags: ["ai-generated"],
  args: { children: "Improve skill" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: "secondary", children: "Review evidence" } };
export const Destructive: Story = { args: { variant: "destructive", children: "Discard draft" } };
export const Disabled: Story = { args: { disabled: true, children: "Improving" } };

export const CssCheck: Story = {
  args: { children: "Verify styling" },
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: "Verify styling" });
    await expect(getComputedStyle(button).backgroundColor).not.toBe("transparent");
  },
};
