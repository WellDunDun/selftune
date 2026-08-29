// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardHostProvider, type DashboardHostModules } from "../../host";
import type { PluginInventoryModel } from "../../models";
import { hostModules } from "../../test/host-modules";
import { PluginsScreen } from "./PluginsScreen";

afterEach(cleanup);

const inventory: PluginInventoryModel = {
  hosts: [
    { host: "claude", label: "Claude", status: "available", installedCount: 1, message: null },
    { host: "codex", label: "Codex", status: "available", installedCount: 1, message: null },
  ],
  plugins: [
    {
      pluginId: "paper-desktop@paper",
      name: "paper-desktop",
      marketplaceName: "paper",
      managedBySelfTune: false,
      versionDrift: true,
      installations: [
        {
          host: "claude",
          hostLabel: "Claude",
          pluginId: "paper-desktop@paper",
          version: "0.1.0",
          enabled: true,
          scope: "user",
          sourceType: "marketplace",
          sourceLabel: "paper",
          managedBySelfTune: false,
          availableActions: ["update", "disable", "remove"],
        },
        {
          host: "codex",
          hostLabel: "Codex",
          pluginId: "paper-desktop@paper",
          version: "0.2.0",
          enabled: true,
          scope: null,
          sourceType: "marketplace",
          sourceLabel: "paper",
          managedBySelfTune: false,
          availableActions: ["remove"],
        },
      ],
    },
  ],
  totalPlugins: 1,
  managedPlugins: 0,
  refreshedAt: "2026-08-11T09:30:00.000Z",
};

function makeModules(execute = vi.fn()): DashboardHostModules {
  return hostModules({
    plugins: {
      plugins: {
        access: "available",
        useInventory: () => ({ data: inventory, isLoading: false, error: null, refresh() {} }),
        useActions: () => ({
          manage: { access: "available", execute },
        }),
      },
    },
  });
}

describe("PluginsScreen", () => {
  it("groups one plugin across hosts and exposes only supported actions", () => {
    render(
      <DashboardHostProvider modules={makeModules()}>
        <PluginsScreen />
      </DashboardHostProvider>,
    );

    expect(screen.getByRole("heading", { name: "paper-desktop" })).toBeTruthy();
    expect(screen.getByText("Versions differ")).toBeTruthy();
    expect(screen.getByText("Installed in Claude").previousElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Installed in Codex").previousElementSibling?.textContent).toBe("1");
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });

  it("requires confirmation before removing and explains Claude data retention", async () => {
    const execute = vi.fn().mockResolvedValue({ inventory });
    render(
      <DashboardHostProvider modules={makeModules(execute)}>
        <PluginsScreen />
      </DashboardHostProvider>,
    );

    const card = screen.getByTestId("plugin-card-paper-desktop@paper");
    const claudeRow = within(card).getByText("Claude").closest(".rounded-lg");
    if (!(claudeRow instanceof HTMLElement)) throw new Error("Claude installation row not found");
    fireEvent.click(within(claudeRow).getByRole("button", { name: "Remove" }));

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByText(/Claude plugin data will be kept/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove from Claude" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        host: "claude",
        pluginId: "paper-desktop@paper",
        action: "remove",
      }),
    );
  });
});
