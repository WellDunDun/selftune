import type { Meta, StoryObj } from "@storybook/react-vite";
import { DownloadIcon } from "lucide-react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DashboardSidebar } from "./DashboardSidebar";

const meta = {
  title: "Chrome/Sidebar update",
  component: DashboardSidebar,
  parameters: { layout: "fullscreen" },
  args: {
    brand: {
      name: "selftune",
      href: "/",
      footerLabel: "selftune v0.4.11",
      footerAction: {
        label: "Update",
        ariaLabel: "Update SelfTune — restart required",
        icon: <DownloadIcon className="size-4" />,
        onClick: () => undefined,
      },
    },
    navItems: [],
    renderLink: ({ children, href }) => <a href={href}>{children}</a>,
    onOpenCommands: () => undefined,
    mobileOpen: true,
    onMobileOpenChange: () => undefined,
  },
} satisfies Meta<typeof DashboardSidebar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UpdateReady: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", {
      name: "Update SelfTune — restart required",
    });
    const [icon, label] = button.querySelectorAll("span[aria-hidden]");
    await expect(icon).toHaveStyle({ opacity: "1" });
    await expect(label).toHaveStyle({ opacity: "0" });
    await userEvent.hover(button);
    button.focus();
    await waitFor(() => expect(label).toHaveStyle({ opacity: "1" }));
    await expect(icon).toHaveStyle({ opacity: "0" });
    await userEvent.unhover(button);
  },
};
