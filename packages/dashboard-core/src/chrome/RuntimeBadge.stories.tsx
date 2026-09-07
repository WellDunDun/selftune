import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { RuntimeBadge } from "./RuntimeBadge";

const meta = {
  component: RuntimeBadge,
  tags: ["ai-generated"],
  args: {
    href: "/settings/runtime",
    label: "Local runtime",
    detail: "Connected",
    renderLink: ({ href, className, children, onClick }) => (
      <a href={href} className={className} onClick={onClick}>
        {children}
      </a>
    ),
  },
} satisfies Meta<typeof RuntimeBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("link", { name: /local runtime.*connected/i })).toHaveAttribute(
      "href",
      "/settings/runtime",
    );
  },
};

export const Warning: Story = {
  args: { tone: "warning", detail: "Attention needed" },
};

export const Critical: Story = {
  args: { tone: "critical", detail: "Disconnected" },
};
