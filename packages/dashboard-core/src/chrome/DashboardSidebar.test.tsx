// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DownloadIcon } from "lucide-react";
import { DashboardSidebar } from "./DashboardSidebar";

afterEach(cleanup);

it("renders an accessible icon update action and invokes it on click", () => {
  const onClick = vi.fn();
  render(
    <DashboardSidebar
      brand={{
        name: "selftune",
        href: "/",
        footerLabel: "v0.4.11",
        footerAction: {
          label: "Update",
          ariaLabel: "Update SelfTune — restart required",
          icon: <DownloadIcon />,
          onClick,
        },
      }}
      navItems={[]}
      renderLink={({ children, href }) => <a href={href}>{children}</a>}
      onOpenCommands={() => undefined}
      mobileOpen={false}
      onMobileOpenChange={() => undefined}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Update SelfTune — restart required",
  });
  expect(button.querySelector("svg")).not.toBeNull();
  expect(button.textContent).toBe("Update");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});
