import type { Meta, StoryObj } from "@storybook/react-vite";

import { StatusBadge } from "./StatusBadge";

const meta = {
  component: StatusBadge,
  tags: ["ai-generated"],
  args: { tone: "healthy", children: "Healthy" },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {};
export const Warning: Story = { args: { tone: "warning", children: "Needs attention" } };
export const Critical: Story = { args: { tone: "critical", children: "Blocked" } };
export const Pending: Story = { args: { tone: "pending", children: "Pending review" } };
export const Soft: Story = { args: { appearance: "soft", children: "Qualified" } };
export const Text: Story = { args: { appearance: "text", children: "Evidence verified" } };
