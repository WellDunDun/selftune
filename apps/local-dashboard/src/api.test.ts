// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillSetDependencyResolution,
  SkillSetDependencyResolutionInput,
} from "@selftune/control-plane";

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
import { previewProjectSkillSetPublish, publishProjectSkillSet } from "./skill-set-publish-api";

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

  it("previews and confirms a team release with both reviewed hashes", async () => {
    const revisionSha256 = "1".repeat(64);
    const envelopeSha256 = "2".repeat(64);
    const previewResponse = {
      skillSetId: "research",
      name: "Research",
      description: "Shared research workflows",
      harnesses: ["codex"],
      skillSetRevisionSha256: revisionSha256,
      envelopeSha256,
      byteLength: 4_096,
      contents: [{ name: "review", revisionSha256: "3".repeat(64), license: "MIT" }],
      dependencies: {
        lock: {
          entries: [
            {
              package_id: "review",
              version: "1.0.0",
              revision_sha256: "3".repeat(64),
              dependency_kind: "root",
            },
          ],
        },
        impact: { added: ["review@1.0.0"], changed: [], removed: [], unchanged: [] },
      } satisfies SkillSetDependencyResolution,
      dependencyInput: {
        roots: ["review"],
        available_packages: [
          {
            package_id: "review",
            version: "1.0.0",
            revision_sha256: "3".repeat(64),
            dependencies: { requires: [], optional: [], conflicts: [] },
            compatibility: { harnesses: ["codex"], required_capabilities: [] },
            provides: [],
          },
        ],
        environment: { harness: "codex", capabilities: [] },
        current_lock: [],
      } satisfies SkillSetDependencyResolutionInput,
      checks: [],
      confirmation: {
        required: true,
        title: "Publish Research to your team?",
        detail: "Review this exact release.",
      },
    };
    const releaseResponse = {
      release_id: "release_123",
      skill_set_id: "research",
      sequence: 2,
      skill_set_revision_sha256: revisionSha256,
      envelope_sha256: envelopeSha256,
      published_at: Date.parse("2026-08-31T10:00:00.000Z"),
      idempotent: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(previewResponse))
      .mockResolvedValueOnce(Response.json(releaseResponse));

    await expect(
      previewProjectSkillSetPublish({
        skillSetId: "research",
        dependencyResolution: previewResponse.dependencyInput,
      }),
    ).resolves.toMatchObject({
      skillSetId: "research",
      connections: ["codex"],
      skillSetRevisionSha256: revisionSha256,
      envelopeSha256,
    });
    await expect(
      publishProjectSkillSet({
        skillSetId: "research",
        expectedSkillSetRevisionSha256: revisionSha256,
        expectedEnvelopeSha256: envelopeSha256,
        dependencyResolution: previewResponse.dependencyInput,
        expectedDependencyLock: previewResponse.dependencies.lock,
        confirmPublish: true,
      }),
    ).resolves.toEqual({
      releaseId: "release_123",
      skillSetId: "research",
      sequence: 2,
      skillSetRevisionSha256: revisionSha256,
      envelopeSha256,
      publishedAt: "2026-08-31T10:00:00.000Z",
      idempotent: false,
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v2/skill-sets/publish/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          set_id: "research",
          dependency_resolution: previewResponse.dependencyInput,
        }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v2/skill-sets/publish",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          set_id: "research",
          expected_skill_set_revision_sha256: revisionSha256,
          expected_envelope_sha256: envelopeSha256,
          dependency_resolution: previewResponse.dependencyInput,
          expected_dependency_lock: previewResponse.dependencies.lock,
          confirm_publish: true,
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
