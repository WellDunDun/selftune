// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabsContent } from "@selftune/ui/primitives";

import { SettingsShell } from "./SettingsShell";

afterEach(cleanup);

const sections = [
  { id: "account", label: "Account" },
  { id: "billing", label: "Billing" },
] as const;

describe("SettingsShell", () => {
  it("renders the desktop settings header, labels, and selected content", () => {
    render(
      <SettingsShell
        sections={sections}
        activeSection="account"
        description="Manage your workspace settings."
        onSectionChange={() => {}}
      >
        <TabsContent value="account">
          <section aria-label="Account settings">Account content</section>
        </TabsContent>
        <TabsContent value="billing">Billing content</TabsContent>
      </SettingsShell>,
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Manage your workspace settings.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Account" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Billing" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByRole("region", { name: "Account settings" }).textContent).toContain(
      "Account content",
    );
  });

  it("reports the selected section when a settings tab is clicked", () => {
    const onSectionChange = vi.fn();
    render(
      <SettingsShell sections={sections} activeSection="account" onSectionChange={onSectionChange}>
        <TabsContent value="account">Account content</TabsContent>
        <TabsContent value="billing">Billing content</TabsContent>
      </SettingsShell>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Billing" }));

    expect(onSectionChange).toHaveBeenCalledTimes(1);
    expect(onSectionChange).toHaveBeenCalledWith("billing");
  });

  it("keeps the responsive left rail and tab-panel structure", () => {
    const { container } = render(
      <SettingsShell sections={sections} activeSection="account" onSectionChange={() => {}}>
        <TabsContent value="account">Account content</TabsContent>
        <TabsContent value="billing">Billing content</TabsContent>
      </SettingsShell>,
    );

    const rail = container.querySelector('[data-slot="settings-shell-rail"]');
    const content = container.querySelector('[data-slot="settings-shell-content"]');
    expect(rail?.className).toContain("border-b");
    expect(rail?.className).toContain("lg:border-r");
    expect(rail?.className).toContain("lg:border-b-0");
    expect(content?.getAttribute("role")).toBeNull();
    expect(container.querySelectorAll('[role="tabpanel"]').length).toBe(1);
    expect(screen.getByRole("tablist")).toBeTruthy();
  });
});
