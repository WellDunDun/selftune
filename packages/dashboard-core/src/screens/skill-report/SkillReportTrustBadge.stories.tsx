import type { Meta, StoryObj } from "@storybook/react-vite";

import { SkillReportTrustBadge } from "./SkillReportTrustBadge";

const meta = {
  component: SkillReportTrustBadge,
  tags: ["ai-generated"],
  args: { state: "low_sample" },
} satisfies Meta<typeof SkillReportTrustBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LowSample: Story = {};
export const Observed: Story = { args: { state: "observed" } };
export const Watch: Story = { args: { state: "watch" } };
export const Validated: Story = { args: { state: "validated" } };
export const Deployed: Story = { args: { state: "deployed" } };
export const RolledBack: Story = { args: { state: "rolled_back" } };
