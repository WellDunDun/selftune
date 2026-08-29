import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Badge } from "./badge";

const meta = {
  component: Badge,
  tags: ["ai-generated"],
  args: { children: "Qualified" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Secondary: Story = { args: { variant: "secondary", children: "Candidate" } };
export const Warning: Story = { args: { variant: "warning", children: "Needs review" } };
export const Destructive: Story = { args: { variant: "destructive", children: "Failed" } };
export const Outline: Story = { args: { variant: "outline", children: "No winner" } };
