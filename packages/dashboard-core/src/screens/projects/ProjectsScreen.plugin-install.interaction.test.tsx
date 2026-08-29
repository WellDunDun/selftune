// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardHostProvider,
  type DashboardHostModules,
  type DashboardProjectsActions,
} from "../../host";
import type {
  ProjectSkillSetPluginInstallPreviewModel,
  ProjectsInventoryModel,
} from "../../models";
import { hostModules } from "../../test/host-modules";
import { ProjectsScreen } from "./ProjectsScreen";

afterEach(cleanup);

const inventory: ProjectsInventoryModel = {
  skillSets: [
    {
      id: "research-team",
      name: "Research team",
      description: "Shared research workflows",
      connections: ["claude_code", "codex"],
      skills: [{ name: "research", packagePath: "/skills/research", contentHash: "hash" }],
      revision: 1,
      revisionHash: "a".repeat(64),
      updatedAt: "2026-08-09T12:00:00.000Z",
    },
  ],
  availableSkills: [],
  receipts: [],
  captureCandidates: [],
  connectedHarnesses: [
    {
      id: "claude_code",
      name: "Claude Code",
      icon: { src: "/claude.svg", fit: "contain", inset: "sm" },
    },
    {
      id: "codex",
      name: "Codex",
      icon: { src: "/codex.svg", fit: "contain", inset: "sm" },
    },
  ],
};

const unavailable = {
  access: "unavailable",
  reason: "unused",
} as const;

function adapter(actions: DashboardProjectsActions): DashboardHostModules {
  return hostModules({
    skillSets: {
      library: unavailable,
      projects: {
        access: "available",
        useInventory: () => ({ data: inventory, isLoading: false, error: null, refresh() {} }),
        useIntelligence: () => unavailable,
        useActions: () => actions,
      },
    },
  });
}

describe("Skill Set plugin installation", () => {
  it("reviews the exact revision and installs in both detected hosts from one confirmation", async () => {
    const preview: ProjectSkillSetPluginInstallPreviewModel = {
      setId: "research-team",
      setName: "Research team",
      revisionHash: "a".repeat(64),
      pluginName: "research-team",
      pluginVersion: "0.0.0-selftune.aaaaaaaaaaaa",
      marketplaceName: "selftune-test",
      skillNames: ["research"],
      hosts: [
        {
          host: "claude",
          label: "Claude",
          available: true,
          installedVersion: null,
          status: "ready",
          activation: "Run /reload-plugins or start a new Claude session.",
        },
        {
          host: "codex",
          label: "Codex",
          available: true,
          installedVersion: null,
          status: "ready",
          activation: "Start a new Codex session.",
        },
      ],
    };
    const previewInstall = vi.fn().mockResolvedValue(preview);
    const install = vi.fn().mockResolvedValue({
      ...preview,
      installedAt: "2026-08-09T12:00:00.000Z",
      hosts: [
        {
          host: "claude",
          pluginId: "research-team@selftune-test",
          result: "installed",
          activation: preview.hosts[0].activation,
        },
        {
          host: "codex",
          pluginId: "research-team@selftune-test",
          result: "installed",
          activation: preview.hosts[1].activation,
        },
      ],
    });
    const actions: DashboardProjectsActions = {
      create: unavailable,
      update: unavailable,
      derive: unavailable,
      export: unavailable,
      installPlugin: {
        preview: { access: "available", execute: previewInstall },
        execute: { access: "available", execute: install },
      },
      remove: unavailable,
      plan: unavailable,
      apply: unavailable,
      resolveConflict: unavailable,
      decideConflict: unavailable,
      rollbackConflict: unavailable,
      rollback: unavailable,
      reviewSuggestion: unavailable,
    };

    render(
      <DashboardHostProvider modules={adapter(actions)}>
        <ProjectsScreen />
      </DashboardHostProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    expect(await screen.findByText("Codex")).toBeTruthy();
    const destinations = screen.getByRole("group", { name: "Plugin destinations" });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(destinations).getByTitle("Claude")).toBeTruthy();
    expect(within(destinations).getByTitle("Codex")).toBeTruthy();
    const destinationButtons = within(destinations).getAllByRole("button");
    expect(destinationButtons).toHaveLength(2);
    expect(
      destinationButtons.every((button) => button.getAttribute("aria-pressed") === "true"),
    ).toBe(true);
    expect(within(destinations).queryByText("Selected")).toBeNull();
    expect(screen.getByText("Revision " + preview.revisionHash)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install in both" }));

    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({
        skillSetId: "research-team",
        expectedRevisionHash: preview.revisionHash,
        hosts: ["claude", "codex"],
      }),
    );
  });
});
