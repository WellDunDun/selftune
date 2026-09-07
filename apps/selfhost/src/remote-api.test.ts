import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  encodeCanonicalSkillSetSourceManifest,
  encodePortablePackageBundle,
  encodePortableSkillSetEnvelope,
} from "@selftune/control-plane";

import type { SelfHostConfig } from "./config.js";
import type { RemoteApiHandle } from "./remote-api.js";
import { makeRemoteApi } from "./remote-api.js";

const ADMIN_TOKEN = "ADMIN_TOKEN_PLACEHOLDER";
const MEMBER_TOKEN = "MEMBER_TOKEN_PLACEHOLDER";
const ADMIN_ORG_ID = "018f6e32-8f5d-7a30-9f7f-74de38d82200";
const MEMBER_ORG_ID = "018f6e32-8f5d-7a30-9f7f-74de38d82201";
const ORIGIN = "https://selftune.example.com";

const temporaryDirectories: string[] = [];
const handles: RemoteApiHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function config(dataDir: string): SelfHostConfig {
  return {
    accounts: [
      {
        email: "admin@example.com",
        name: "Admin",
        orgId: ADMIN_ORG_ID,
        orgName: "Admin Org",
        role: "admin",
        token: ADMIN_TOKEN,
      },
      {
        email: "member@example.com",
        name: "Member",
        orgId: MEMBER_ORG_ID,
        orgName: "Member Org",
        role: "member",
        token: MEMBER_TOKEN,
      },
    ],
    adminToken: ADMIN_TOKEN,
    allowedOrigins: [ORIGIN],
    dataDir,
    host: "127.0.0.1",
    maxObjectBytes: 1024 * 1024,
    port: 8787,
    publicUrl: ORIGIN,
    spaDir: undefined,
  };
}

const SnapshotReceipt = Schema.Struct({ snapshot: Schema.Struct({ id: Schema.String }) });
const PackReceipt = Schema.Struct({ packId: Schema.String, packUrl: Schema.String });
const ShareReceipt = Schema.Struct({ share: Schema.Struct({ id: Schema.String }) });

async function request(
  handle: RemoteApiHandle,
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers({ Origin: ORIGIN });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const response = await handle.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers,
    }),
  );
  if (!response) throw new TypeError(`Self-host API did not handle ${path}.`);
  return response;
}

describe("self-hosted Remote Library API", () => {
  test("supports the same Desktop state and privacy-safe manifest journey as managed Cloud", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "selftune-selfhost-manifest-"));
    temporaryDirectories.push(dataDir);
    const handle = makeRemoteApi(config(dataDir));
    handles.push(handle);
    const state = await request(handle, "/api/v1/desktop/state", ADMIN_TOKEN);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      workspaceId: ADMIN_ORG_ID,
      plan: "free",
      status: "none",
      currentPeriodEnd: null,
    });
    const manifest = {
      revision: "sha256:manifest",
      device_name: "Daniel's Mac",
      platform: "darwin-arm64",
      skills: [
        {
          identity: "research",
          revision_hash: "sha256:skill",
          scope: "global",
          connections: ["codex"],
          update_status: "current",
          usage_status: "none",
        },
      ],
    };
    const publish = () =>
      request(handle, "/api/v1/desktop/manifest", ADMIN_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      });
    expect(await (await publish()).json()).toEqual({ uploaded: 1, unchanged: 0 });
    expect(await (await publish()).json()).toEqual({ uploaded: 0, unchanged: 1 });
  });

  test("relays only bounded contributor signals and deduplicates creator aggregates", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "selftune-selfhost-signals-"));
    temporaryDirectories.push(dataDir);
    const handle = makeRemoteApi(config(dataDir));
    handles.push(handle);
    const payload = {
      version: 1,
      signal_type: "skill_session",
      source_key: "0123456789abcdef",
      relay_destination: ADMIN_ORG_ID,
      skill_hash: "sk_sha256_123456abcdef",
      user_cohort: "uc_sha256_123456abcdef",
      signals: { triggered: true, execution_grade: "A" },
      timestamp_bucket: "2026-W35",
      client_version: "0.4.0",
    };
    const relay = () =>
      request(handle, "/api/v1/contributions/relay", MEMBER_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect(await (await relay()).json()).toMatchObject({ status: "accepted" });
    expect(await (await relay()).json()).toMatchObject({ status: "duplicate" });
    const aggregate = await request(
      handle,
      `/api/v1/contributions/aggregates/${payload.skill_hash}`,
      ADMIN_TOKEN,
    );
    expect(aggregate.status).toBe(200);
    expect(await aggregate.json()).toEqual({
      observations: 1,
      cohorts: 1,
      triggered: 1,
      missed: 0,
      grades: { A: 1, B: 0, C: 0, F: 0 },
    });
  });

  test("issues branded, revocable Pack URLs for one immutable Skill Set envelope", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "selftune-selfhost-pack-"));
    temporaryDirectories.push(dataDir);
    const handle = makeRemoteApi(config(dataDir));
    handles.push(handle);

    const packageBytes = await Effect.runPromise(
      encodePortablePackageBundle({
        files: [
          {
            path: "SKILL.md",
            content: new TextEncoder().encode(
              "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
            ),
          },
        ],
      }),
    );
    const source = await Effect.runPromise(
      encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "Pinned engineering skills",
        harnesses: ["codex"],
        components: [
          {
            ordinal: 0,
            logicalSkillId: "review",
            sourceRevisionSha256: "1".repeat(64),
            sourcePackageObjectSha256: createHash("sha256").update(packageBytes).digest("hex"),
          },
        ],
      }),
    );
    const pack = await Effect.runPromise(
      encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        components: [
          {
            ordinal: 0,
            logicalSkillId: "review",
            sourceRevisionSha256: "1".repeat(64),
            sourcePackageObjectSha256: createHash("sha256").update(packageBytes).digest("hex"),
            sealedPackageBytes: packageBytes,
            terms: { licenseExpression: "MIT", noticePaths: [] },
          },
        ],
      }),
    );
    const objectSha256 = createHash("sha256").update(pack.bytes).digest("hex");
    expect(
      (
        await request(handle, `/api/v1/remote-library/objects/${objectSha256}`, ADMIN_TOKEN, {
          method: "PUT",
          headers: { "Content-Type": "application/vnd.selftune.portable-skill-set+json;version=1" },
          body: new Blob([pack.bytes]),
        })
      ).status,
    ).toBe(201);
    const artifactId = `skill-set/engineering/${pack.envelope.skillSetRevisionSha256}`;
    const committed = await request(handle, "/api/v1/remote-library/snapshots", ADMIN_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "selftune.remote-library.snapshot.v1",
        expected_parent_id: null,
        artifacts: [
          {
            artifact_id: artifactId,
            artifact_type: "skill_set",
            object_sha256: objectSha256,
            revision: pack.envelope.skillSetRevisionSha256,
            metadata: { name: "Engineering" },
          },
        ],
      }),
    });
    const {
      snapshot: { id: snapshotId },
    } = Schema.decodeUnknownSync(SnapshotReceipt)(await committed.json());
    const issued = await request(handle, "/api/v1/remote-library/packs", ADMIN_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot_id: snapshotId,
        artifact_id: artifactId,
        mode: "reusable_unlisted",
      }),
    });
    expect(issued.status).toBe(201);
    const issuedBody = Schema.decodeUnknownSync(PackReceipt)(await issued.json());
    const packId = issuedBody.packId;
    const packUrl = new URL(issuedBody.packUrl);
    expect(packUrl.origin).toBe(ORIGIN);
    expect(packUrl.pathname).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
    const token = packUrl.pathname.split("/").at(-1)!;

    const landing = await request(handle, `/p/${token}`);
    expect(landing.status).toBe(200);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain("Engineering");
    expect(landingHtml).toContain("Open in SelfTune Desktop");
    expect(landingHtml).toContain("review");

    const listed = await request(handle, "/api/v1/remote-library/packs", ADMIN_TOKEN);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ packs: [{ packUrl: packUrl.href }] });

    const preview = await request(handle, `/api/v1/public/packs/${token}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ objectSha256 });
    const content = await request(handle, `/api/v1/public/packs/${token}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("x-selftune-content-sha256")).toBe(objectSha256);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(pack.bytes);

    expect(
      (
        await request(handle, `/api/v1/remote-library/packs/${packId}`, ADMIN_TOKEN, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect((await request(handle, `/api/v1/public/packs/${token}`)).status).toBe(404);
  });

  test("reports repository initialization failures as stable 503 responses", async () => {
    const parent = mkdtempSync(join(tmpdir(), "selftune-selfhost-invalid-"));
    temporaryDirectories.push(parent);
    const dataDir = join(parent, "not-a-directory");
    writeFileSync(dataDir, "blocks repository initialization");
    let unhandledRejectionCount = 0;
    const recordUnhandledRejection = (): void => {
      unhandledRejectionCount++;
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      const handle = makeRemoteApi(config(dataDir));
      handles.push(handle);

      let readinessFailed = false;
      try {
        await handle.ready;
      } catch {
        readinessFailed = true;
      }
      expect(readinessFailed).toBe(true);

      const health = await request(handle, "/healthz");
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ check: "liveness" });

      const readiness = await request(handle, "/readyz");
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toMatchObject({ error: { code: "RemoteLibraryUnavailable" } });

      const api = await request(handle, "/api/v1/remote-library/capabilities", ADMIN_TOKEN);
      expect(api.status).toBe(503);
      expect(await api.json()).toMatchObject({ error: { code: "RemoteLibraryUnavailable" } });

      const preflight = await request(handle, "/api/v1/remote-library/objects/hash", undefined, {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(await preflight.text()).toBe("");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejectionCount).toBe(0);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
    }
  });

  test("persists snapshots and imports private shares across isolated organizations", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "selftune-selfhost-"));
    temporaryDirectories.push(dataDir);
    const handle = makeRemoteApi(config(dataDir));
    handles.push(handle);

    const initialReadiness = await request(handle, "/readyz");
    expect(initialReadiness.status).toBe(200);
    expect(await initialReadiness.json()).toMatchObject({ check: "readiness" });

    const unauthenticated = await request(handle, "/api/v1/remote-library/capabilities");
    expect(unauthenticated.status).toBe(401);

    const preflight = await request(handle, "/api/v1/remote-library/objects/hash", undefined, {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "PUT" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");

    const capabilities = await request(handle, "/api/v1/remote-library/capabilities", ADMIN_TOKEN);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({ protocol: "selftune.remote-library.v1" });

    const bytes = new TextEncoder().encode("name: durable-skill\nversion: 1\n");
    const objectSha256 = createHash("sha256").update(bytes).digest("hex");
    const put = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      ADMIN_TOKEN,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: new Blob([bytes]),
      },
    );
    expect(put.status).toBe(201);

    const memberCannotPush = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      MEMBER_TOKEN,
      { method: "PUT", body: new Blob([bytes]) },
    );
    expect(memberCannotPush.status).toBe(403);

    const headObject = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      ADMIN_TOKEN,
      { method: "HEAD" },
    );
    expect(headObject.status).toBe(200);
    expect(headObject.headers.get("etag")).toBe(`"${objectSha256}"`);

    const artifact = {
      artifact_id: "skill:durable-skill",
      artifact_type: "skill_revision",
      object_sha256: objectSha256,
      revision: objectSha256,
      metadata: {},
    };
    const commit = await request(handle, "/api/v1/remote-library/snapshots", ADMIN_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "selftune.remote-library.snapshot.v1",
        expected_parent_id: null,
        artifacts: [artifact],
      }),
    });
    expect(commit.status).toBe(201);
    const {
      snapshot: { id: snapshotId },
    } = Schema.decodeUnknownSync(SnapshotReceipt)(await commit.json());

    const adminObjectPath = join(dataDir, "objects", ADMIN_ORG_ID, objectSha256);
    writeFileSync(adminObjectPath, "corrupt object bytes");
    const degradedDiagnostics = await request(
      handle,
      "/api/v1/remote-library/diagnostics",
      ADMIN_TOKEN,
    );
    expect(degradedDiagnostics.status).toBe(200);
    const degradedPayload = await degradedDiagnostics.json();
    expect(degradedPayload).toMatchObject({ status: "degraded", missing_objects: [objectSha256] });

    const livenessWhileDegraded = await request(handle, "/healthz");
    expect(livenessWhileDegraded.status).toBe(200);
    expect(await livenessWhileDegraded.json()).toMatchObject({ check: "liveness" });
    const degradedReadiness = await request(handle, "/readyz");
    expect(degradedReadiness.status).toBe(503);
    expect(await degradedReadiness.json()).toMatchObject({
      error: { code: "RemoteLibraryIntegrityDegraded" },
    });

    const corruptCommit = await request(handle, "/api/v1/remote-library/snapshots", ADMIN_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "selftune.remote-library.snapshot.v1",
        expected_parent_id: snapshotId,
        artifacts: [artifact],
      }),
    });
    expect(corruptCommit.status).toBe(422);
    expect(await corruptCommit.json()).toMatchObject({
      error: { code: "RemoteLibraryHashMismatch" },
    });

    const repair = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      ADMIN_TOKEN,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: new Blob([bytes]),
      },
    );
    expect(repair.status).toBe(200);
    expect(await repair.json()).toMatchObject({ created: false });
    expect(readdirSync(dirname(adminObjectPath)).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );

    const healthyDiagnostics = await request(
      handle,
      "/api/v1/remote-library/diagnostics",
      ADMIN_TOKEN,
    );
    expect(await healthyDiagnostics.json()).toMatchObject({ status: "ok" });
    const repairedReadiness = await request(handle, "/readyz");
    expect(repairedReadiness.status).toBe(200);
    expect(await repairedReadiness.json()).toMatchObject({ check: "readiness" });

    const conflict = await request(handle, "/api/v1/remote-library/snapshots", ADMIN_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "selftune.remote-library.snapshot.v1",
        expected_parent_id: null,
        artifacts: [artifact],
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "RemoteLibraryHeadConflict", current_head_id: snapshotId },
    });

    const memberObjectBeforeImport = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      MEMBER_TOKEN,
    );
    expect(memberObjectBeforeImport.status).toBe(404);

    const createShare = await request(handle, "/api/v1/remote-library/shares", ADMIN_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot_id: snapshotId,
        artifact_id: artifact.artifact_id,
        recipient_email: "member@example.com",
      }),
    });
    expect(createShare.status).toBe(201);
    const {
      share: { id: shareId },
    } = Schema.decodeUnknownSync(ShareReceipt)(await createShare.json());

    const accept = await request(
      handle,
      `/api/v1/remote-library/shares/${shareId}/accept`,
      MEMBER_TOKEN,
      { method: "POST" },
    );
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ share: { status: "accepted" } });

    writeFileSync(adminObjectPath, "corrupt before import");
    const memberObjectPath = join(dataDir, "objects", MEMBER_ORG_ID, objectSha256);
    mkdirSync(dirname(memberObjectPath), { recursive: true });
    writeFileSync(memberObjectPath, "corrupt target bytes");

    const rejectedImport = await request(
      handle,
      `/api/v1/remote-library/shares/${shareId}/import`,
      MEMBER_TOKEN,
      { method: "POST" },
    );
    expect(rejectedImport.status).toBe(422);
    expect(await rejectedImport.json()).toMatchObject({
      error: { code: "RemoteLibraryHashMismatch" },
    });

    const repairBeforeImport = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      ADMIN_TOKEN,
      { method: "PUT", body: new Blob([bytes]) },
    );
    expect(repairBeforeImport.status).toBe(200);

    const imported = await request(
      handle,
      `/api/v1/remote-library/shares/${shareId}/import`,
      MEMBER_TOKEN,
      { method: "POST" },
    );
    expect(imported.status).toBe(200);
    const importedPayload = await imported.json();
    expect(importedPayload).toMatchObject({
      share: { status: "imported" },
      snapshot: { id: expect.any(String) },
    });

    const memberObjectAfterImport = await request(
      handle,
      `/api/v1/remote-library/objects/${objectSha256}`,
      MEMBER_TOKEN,
    );
    expect(memberObjectAfterImport.status).toBe(200);
    expect(await memberObjectAfterImport.text()).toBe(new TextDecoder().decode(bytes));

    writeFileSync(memberObjectPath, "corrupt member organization object");
    const crossTenantReadiness = await request(handle, "/readyz");
    expect(crossTenantReadiness.status).toBe(503);
    expect(await crossTenantReadiness.json()).toMatchObject({
      error: { code: "RemoteLibraryIntegrityDegraded" },
    });
    writeFileSync(memberObjectPath, bytes);
    expect((await request(handle, "/readyz")).status).toBe(200);

    await handle.dispose();
    handles.splice(handles.indexOf(handle), 1);
    const restarted = makeRemoteApi(config(dataDir));
    handles.push(restarted);
    const persistedHead = await request(
      restarted,
      "/api/v1/remote-library/snapshots/head",
      ADMIN_TOKEN,
    );
    expect(persistedHead.status).toBe(200);
    expect(await persistedHead.json()).toMatchObject({ snapshot: { id: snapshotId } });
  });
});
