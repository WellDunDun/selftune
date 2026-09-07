import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { OverviewOnboardingBanner } from "./OverviewOnboardingBanner";

const storageKey = "selftune-storybook-onboarding-dismissed";

const meta = {
  component: OverviewOnboardingBanner,
  tags: ["ai-generated"],
  args: { skillCount: 0, storageKey },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OverviewOnboardingBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalFirstRun: Story = {};

export const CloudFirstRun: Story = {
  args: { skillCount: 4, cloudSourceCount: 0 },
};

export const Dismissible: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss local dashboard guidance" }));
    await expect(canvas.queryByText("Local Dashboard")).not.toBeInTheDocument();
    await expect(localStorage.getItem(storageKey)).toBe("true");
  },
};
