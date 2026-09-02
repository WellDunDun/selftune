import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSkillSet } from "@selftune/library";
import type { SkillSetManifest } from "@selftune/library";
import type { SkillSetDependencyResolutionInput } from "@selftune/control-plane";
import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { makeHostedStateOperations } from "../src/hosted-state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

function releaseDependencies(set: SkillSetManifest): SkillSetDependencyResolutionInput {
  return {
    roots: set.skills.map((skill) => skill.name),
    available_packages: set.skills.map((skill) => ({
      package_id: skill.name,
      version: "1.0.0",
      revision_sha256: skill.content_hash,
      dependencies: { requires: [], optional: [], conflicts: [] },
      compatibility: { harnesses: [...set.harnesses], required_capabilities: [] },
      provides: [],
    })),
    environment: { harness: set.harnesses[0] ?? "codex", capabilities: [] },
    current_lock: [],
  };
}

describe("Desktop hosted-state adapter", () => {
  test("uploads and finalizes an exact contribution with linked-device authorization", async () => {
    const requests: Request[] = [];
    const sha = "a".repeat(64);
    const operations = makeHostedStateOperations("/config", () => library, {
      loadConfig: () => ({
        version: 2,
        url: "https://cloud.selftune.dev",
        apiKey: "device_secret",
        preferences: {
          releasedSkills: true,
          drafts: false,
          skillSets: true,
          metadata: true,
          decisionHistory: false,
        },
        credentialProvider: "file",
      }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/upload-intent"))
          return Response.json({
            request_id: "request_01",
            upload_url: "https://upload.example/contribution",
            expires_at: Date.now() + 60_000,
          });
        if (request.url === "https://upload.example/contribution")
          return Response.json({ storageId: "storage_01" });
        return Response.json({
          proposal: {
            contribution_id: "contribution_01",
            request_id: "request_01",
            skill_set_id: "engineering",
            base_release_id: "release_01",
            proposed_skill_set_revision_sha256: sha,
            proposed_envelope_sha256: sha,
            proposed_byte_length: 3,
            title: "Improve review",
            message: "",
            submitted_by_member_id: "member_01",
            submitted_by_name: "Daniel",
            submitted_at: Date.now(),
            change_manifest: {
              base_skill_set_revision_sha256: "b".repeat(64),
              proposed_skill_set_revision_sha256: sha,
              added_files: 0,
              modified_files: 1,
              removed_files: 0,
              changes: [],
            },
            readiness: {
              status: "ready",
              checked_components: 1,
              blocked_components: 0,
              summary: "Ready",
            },
            review_diff: "diff",
          },
          idempotent: false,
        });
      },
    });
    await expect(
      operations.uploadContribution(
        {
          request_id: "request_01",
          skill_set_id: "engineering",
          base_release_id: "release_01",
          proposed_skill_set_revision_sha256: sha,
          proposed_envelope_sha256: sha,
          proposed_byte_length: 3,
          title: "Improve review",
          message: "",
        },
        new Uint8Array([1, 2, 3]),
      ),
    ).resolves.toEqual({
      contribution_id: "contribution_01",
      request_id: "request_01",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://cloud.selftune.dev/api/v1/desktop/contributions/upload-intent",
      "https://upload.example/contribution",
      "https://cloud.selftune.dev/api/v1/desktop/contributions/finalize",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer device_secret");
    expect(await requests[2]?.json()).toMatchObject({
      package_storage_id: "storage_01",
    });
  });

  test("previews the exact portable Skill Set release in plain language without publishing", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-release-preview-"));
    temporaryDirectories.push(root);
    const configRoot = join(root, "config");
    const skillRoot = join(root, "review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
    );
    const set = createSkillSet(
      {
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot },
    );
    const operations = makeHostedStateOperations(configRoot, () => library);

    const preview = await operations.previewSkillSetPublish(set.set_id, {
      roots: ["review"],
      available_packages: [
        {
          package_id: "review",
          version: "1.0.0",
          revision_sha256: set.skills[0]?.content_hash,
          dependencies: { requires: [], optional: [], conflicts: [] },
          compatibility: { harnesses: ["codex"], required_capabilities: [] },
          provides: [],
        },
      ],
      environment: { harness: "codex", capabilities: [] },
      current_lock: [],
    });

    expect(preview).toMatchObject({
      skillSetId: set.set_id,
      name: "Engineering",
      description: "Pinned engineering workflow",
      harnesses: ["codex"],
      contents: [
        {
          name: "review",
          license: "MIT",
        },
      ],
      checks: [
        {
          id: "portable_envelope",
          status: "passed",
          title: "Portable release is valid",
        },
        {
          id: "pinned_revisions",
          status: "passed",
          title: "1 skill revision is pinned",
        },
        {
          id: "distribution_terms",
          status: "passed",
          title: "Distribution terms are included",
        },
      ],
      confirmation: {
        required: true,
        title: "Publish Engineering to your team?",
      },
      dependencies: {
        lock: {
          entries: [
            {
              package_id: "review",
              version: "1.0.0",
              dependency_kind: "root",
            },
          ],
        },
        impact: {
          added: ["review@1.0.0"],
          changed: [],
          removed: [],
          unchanged: [],
        },
      },
    });
    expect(preview.skillSetRevisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.envelopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.byteLength).toBeGreaterThan(0);
    expect(preview.contents[0]?.revisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(preview)).not.toContain(skillRoot);
  });

  test("blocks preview when explicit dependency metadata requires a component outside the release", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-release-dependency-block-"));
    temporaryDirectories.push(root);
    const configRoot = join(root, "config");
    const skillRoot = join(root, "review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
    );
    const set = createSkillSet(
      {
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot },
    );
    const operations = makeHostedStateOperations(configRoot, () => library);

    await expect(
      operations.previewSkillSetPublish(set.set_id, {
        roots: ["review"],
        available_packages: [
          {
            package_id: "review",
            version: "1.0.0",
            revision_sha256: set.skills[0]?.content_hash,
            dependencies: {
              requires: [{ package_id: "policy", version_range: ">=1.0.0 <2.0.0" }],
              optional: [],
              conflicts: [],
            },
            compatibility: { harnesses: ["codex"], required_capabilities: [] },
            provides: [],
          },
          {
            package_id: "policy",
            version: "1.0.0",
            revision_sha256: "a".repeat(64),
            dependencies: { requires: [], optional: [], conflicts: [] },
            compatibility: { harnesses: ["codex"], required_capabilities: [] },
            provides: [],
          },
        ],
        environment: { harness: "codex", capabilities: [] },
        current_lock: [],
      }),
    ).rejects.toThrow("Resolved package policy is not included in this Skill Set release");
  });

  test("refuses to publish until the reviewed release is explicitly confirmed", async () => {
    let fetchCalled = false;
    const operations = makeHostedStateOperations("/config", () => library, {
      fetch: async () => {
        fetchCalled = true;
        return Response.json({});
      },
    });

    await expect(
      operations.publishSkillSet({
        setId: "engineering",
        expectedSkillSetRevisionSha256: "1".repeat(64),
        expectedEnvelopeSha256: "2".repeat(64),
        dependencyResolution: {
          roots: ["review"],
          available_packages: [],
          environment: { harness: "codex", capabilities: [] },
          current_lock: [],
        },
        expectedDependencyLock: { entries: [] },
        confirmPublish: false,
      }),
    ).rejects.toThrow("Confirm publishing this exact Skill Set release before continuing.");
    expect(fetchCalled).toBe(false);
  });

  test("uploads the exact reviewed envelope and returns its immutable release receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-release-publish-"));
    temporaryDirectories.push(root);
    const configRoot = join(root, "config");
    const skillRoot = join(root, "review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
    );
    const set = createSkillSet(
      {
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot },
    );
    const requests: Request[] = [];
    let intentBody: unknown;
    let finalizeBody: unknown;
    let uploadedBytes = new Uint8Array();
    let preview: Awaited<
      ReturnType<ReturnType<typeof makeHostedStateOperations>["previewSkillSetPublish"]>
    >;
    const operations = makeHostedStateOperations(configRoot, () => library, {
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
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (request.url.endsWith("/releases/publish-intent")) {
          intentBody = await request.json();
          return Response.json({
            publish_intent_id: "intent_123",
            upload_url: "https://upload.example/releases/intent_123",
            expires_at: Date.parse("2026-09-01T10:00:00.000Z"),
          });
        }
        if (request.url === "https://upload.example/releases/intent_123") {
          uploadedBytes = new Uint8Array(await request.arrayBuffer());
          return Response.json({ storageId: "storage_123" });
        }
        finalizeBody = await request.json();
        return Response.json({
          release_id: "release_123",
          skill_set_id: set.set_id,
          sequence: 1,
          skill_set_revision_sha256: preview.skillSetRevisionSha256,
          envelope_sha256: preview.envelopeSha256,
          published_at: Date.parse("2026-08-31T10:00:00.000Z"),
          idempotent: false,
        });
      },
    });
    const dependencies = releaseDependencies(set);
    preview = await operations.previewSkillSetPublish(set.set_id, dependencies);

    await expect(
      operations.publishSkillSet({
        setId: set.set_id,
        expectedSkillSetRevisionSha256: preview.skillSetRevisionSha256,
        expectedEnvelopeSha256: preview.envelopeSha256,
        dependencyResolution: dependencies,
        expectedDependencyLock: preview.dependencies.lock,
        confirmPublish: true,
      }),
    ).resolves.toEqual({
      release_id: "release_123",
      skill_set_id: set.set_id,
      sequence: 1,
      skill_set_revision_sha256: preview.skillSetRevisionSha256,
      envelope_sha256: preview.envelopeSha256,
      published_at: Date.parse("2026-08-31T10:00:00.000Z"),
      idempotent: false,
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://cloud.selftune.dev/api/v1/desktop/releases/publish-intent",
      "https://upload.example/releases/intent_123",
      "https://cloud.selftune.dev/api/v1/desktop/releases/finalize",
    ]);
    expect(intentBody).toEqual({
      skill_set_id: set.set_id,
      skill_set_revision_sha256: preview.skillSetRevisionSha256,
      envelope_sha256: preview.envelopeSha256,
      byte_length: preview.byteLength,
    });
    expect(finalizeBody).toEqual({
      publish_intent_id: "intent_123",
      storage_id: "storage_123",
    });
    expect(uploadedBytes.byteLength).toBe(preview.byteLength);
    expect(createHash("sha256").update(uploadedBytes).digest("hex")).toBe(preview.envelopeSha256);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer st_live_secret");
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer st_live_secret");
    expect(JSON.stringify(intentBody)).not.toContain(skillRoot);
  });

  test("rejects local package drift after preview before requesting an upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-release-drift-"));
    temporaryDirectories.push(root);
    const configRoot = join(root, "config");
    const skillRoot = join(root, "review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
    );
    writeFileSync(join(skillRoot, "reference.md"), "Reviewed guidance\n");
    const set = createSkillSet(
      {
        name: "Engineering",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot },
    );
    let fetchCalled = false;
    const operations = makeHostedStateOperations(configRoot, () => library, {
      fetch: async () => {
        fetchCalled = true;
        return Response.json({});
      },
    });
    const dependencies = releaseDependencies(set);
    const preview = await operations.previewSkillSetPublish(set.set_id, dependencies);
    writeFileSync(
      join(set.skills[0]!.library_package_path, "reference.md"),
      "Changed after review\n",
    );

    await expect(
      operations.publishSkillSet({
        setId: set.set_id,
        expectedSkillSetRevisionSha256: preview.skillSetRevisionSha256,
        expectedEnvelopeSha256: preview.envelopeSha256,
        dependencyResolution: dependencies,
        expectedDependencyLock: preview.dependencies.lock,
        confirmPublish: true,
      }),
    ).rejects.toThrow("The Skill Set release changed after it was reviewed.");
    expect(fetchCalled).toBe(false);
  });

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
