// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardApiError,
  deleteProjectSkillSet,
  exportProjectSkillSetPlugin,
  fetchCloudBillingStatus,
  fetchPlugins,
  installProjectSkillSetPlugin,
  managePlugin,
  previewProjectSkillSetPluginInstall,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard API response boundary", () => {
  it("turns a plain-text missing sidecar route into an actionable typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchCloudBillingStatus()).rejects.toMatchObject({
      name: "DashboardApiError",
      code: "ROUTE_NOT_FOUND",
      message: "The Desktop service is out of date. Restart SelfTune Desktop and try again.",
      status: 404,
    } satisfies Partial<DashboardApiError>);
  });

  it("requests a plugin archive for an exact Skill Set and target", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ filename: "research-agent-plugins-v1.zip", content_base64: "UEs=" }),
      );

    await expect(
      exportProjectSkillSetPlugin({ set_id: "research", target: "agent-plugins-v1" }),
    ).resolves.toEqual({ filename: "research-agent-plugins-v1.zip", content_base64: "UEs=" });
    expect(request).toHaveBeenCalledWith(
      "/api/v2/skill-sets/plugin-export",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ set_id: "research", target: "agent-plugins-v1" }),
      }),
    );
  });

  it("deletes an exact local Skill Set through the authenticated Desktop boundary", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ deleted: true }));

    await expect(deleteProjectSkillSet("research/project")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v2/skill-sets/research%2Fproject", {
      method: "DELETE",
    });
  });

  it("previews and confirms native host plugin installation as separate requests", async () => {
    const preview = {
      setId: "research",
      setName: "Research",
      revisionHash: "a".repeat(64),
      pluginName: "research",
      pluginVersion: "0.0.0-selftune.aaaaaaaaaaaa",
      marketplaceName: "selftune-market",
      skillNames: ["review"],
      hosts: [],
    };
    const receipt = { ...preview, installedAt: "2026-08-09T12:00:00.000Z", hosts: [] };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(Response.json(receipt));

    await expect(previewProjectSkillSetPluginInstall("research")).resolves.toEqual(preview);
    await expect(
      installProjectSkillSetPlugin({
        skillSetId: "research",
        expectedRevisionHash: preview.revisionHash,
        hosts: ["claude", "codex"],
      }),
    ).resolves.toEqual(receipt);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v2/skill-sets/plugin-install/preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ set_id: "research" }) }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v2/skill-sets/plugin-install",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          set_id: "research",
          expected_revision_hash: preview.revisionHash,
          hosts: ["claude", "codex"],
        }),
      }),
    );
  });

  it("loads the detected plugin inventory and sends an explicit management action", async () => {
    const inventory = {
      hosts: [],
      plugins: [],
      totalPlugins: 0,
      managedPlugins: 0,
      refreshedAt: "2026-08-11T09:30:00.000Z",
    };
    const receipt = {
      host: "claude",
      pluginId: "paper-desktop@paper",
      action: "disable",
      completedAt: "2026-08-11T09:31:00.000Z",
      inventory,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json(receipt));

    await expect(fetchPlugins()).resolves.toEqual(inventory);
    await expect(
      managePlugin({ host: "claude", pluginId: "paper-desktop@paper", action: "disable" }),
    ).resolves.toEqual(receipt);
    expect(request).toHaveBeenNthCalledWith(1, "/api/v2/plugins");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v2/plugins/manage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          host: "claude",
          plugin_id: "paper-desktop@paper",
          action: "disable",
        }),
      }),
    );
  });
});
