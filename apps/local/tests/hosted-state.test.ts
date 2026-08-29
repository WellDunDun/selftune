import { describe, expect, test } from "bun:test";

import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { makeHostedStateOperations } from "../src/hosted-state.js";

const library: LibrarySnapshot = {
  generatedAt: "2026-08-26T10:00:00.000Z",
  counts: { total: 1, active: 1, library: 0, draft: 0, archived: 0 },
  skills: [
    {
      skillId: "research",
      name: "Research",
      lifecycle: "active",
      revisions: [{ contentHash: "sha256:revision", locations: [] }],
      locations: [
        {
          sourceKind: "installed",
          packagePath: "/private/skills/research",
          skillPath: "/private/skills/research/SKILL.md",
          harness: "codex",
          scope: "project",
          projectRoot: "/private/project",
          active: true,
          modifiedAt: "2026-08-26T10:00:00.000Z",
          lastUsedAt: null,
          origin: null,
          updateStatus: "available",
        },
      ],
      lastUsedAt: null,
      lastModifiedAt: "2026-08-26T10:00:00.000Z",
      origins: [],
      updateStatus: "available",
    },
  ],
};

describe("Desktop hosted-state adapter", () => {
  test("publishes only a privacy-safe manifest through the linked device credential", async () => {
    let request: Request | null = null;
    const operations = makeHostedStateOperations("/config", () => library, {
      loadConfig: () => ({
        version: 2,
        url: "https://cloud.selftune.dev",
        apiKey: "st_live_secret",
        preferences: {
          releasedSkills: true,
          drafts: false,
          skillSets: true,
          metadata: true,
          decisionHistory: false,
        },
        credentialProvider: "file",
      }),
      deviceName: () => "Daniel's Mac",
      platform: () => "darwin",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ uploaded: 1, unchanged: 0 });
      },
    });

    await expect(operations.sync()).resolves.toEqual({
      uploaded: 1,
      unchanged: 0,
    });
    expect(request).not.toBeNull();
    if (request === null) throw new Error("Expected hosted-state request");
    expect(request.url).toBe("https://cloud.selftune.dev/api/v1/desktop/manifest");
    expect(request.headers.get("authorization")).toBe("Bearer st_live_secret");
    const body = await request.json();
    expect(body.skills).toEqual([
      {
        identity: "research",
        revision_hash: "sha256:revision",
        scope: "project",
        connections: ["codex"],
        update_status: "available",
        usage_status: "none",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("/private/");
    expect(JSON.stringify(body)).not.toContain("SKILL.md");
  });

  test("uploads an explicit package and returns a secure Cloud link", async () => {
    const requests: Request[] = [];
    const operations = makeHostedStateOperations("/config", () => library, {
      loadConfig: () => ({
        version: 2,
        url: "https://cloud.selftune.dev",
        apiKey: "st_live_secret",
        preferences: {
          releasedSkills: false,
          drafts: false,
          skillSets: false,
          metadata: false,
          decisionHistory: false,
        },
        credentialProvider: "file",
      }),
      packageForShare: async () => ({
        bytes: new TextEncoder().encode("portable skill package"),
        label: "research",
      }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/share/upload"))
          return Response.json({
            upload_url: "https://upload.example/package",
          });
        if (request.url === "https://upload.example/package")
          return Response.json({ storageId: "storage_123" });
        return Response.json({
          share_id: "share_123",
          share_url: "https://cloud.selftune.dev/share/claim_token",
          expires_at: Date.parse("2026-08-27T10:00:00.000Z"),
        });
      },
    });

    await expect(
      operations.share({
        skillId: "research",
        snapshotId: "local",
        artifactId: "research",
        mode: "private_single_claim",
        delivery: "copy_link",
      }),
    ).resolves.toEqual({
      shareId: "share_123",
      mode: "private_single_claim",
      delivery: "copy_link",
      shareUrl: "https://cloud.selftune.dev/share/claim_token",
      expiresAt: "2026-08-27T10:00:00.000Z",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://cloud.selftune.dev/api/v1/desktop/share/upload",
      "https://upload.example/package",
      "https://cloud.selftune.dev/api/v1/desktop/share/issue",
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer st_live_secret");
  });
});
