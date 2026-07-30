import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

function stringField(value: unknown, key: string): string {
  const result = field(value, key);
  if (typeof result !== "string") throw new TypeError(`Expected ${key} to be a string.`);
  return result;
}

async function request(
  handle: RemoteApiHandle,
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await handle.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        Origin: ORIGIN,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    }),
  );
  if (!response) throw new TypeError(`Self-host API did not handle ${path}.`);
  return response;
}

describe("self-hosted Remote Library API", () => {
  test("reports repository initialization failures as stable 503 responses", async () => {
    const parent = mkdtempSync(join(tmpdir(), "selftune-selfhost-invalid-"));
    temporaryDirectories.push(parent);
    const dataDir = join(parent, "not-a-directory");
    writeFileSync(dataDir, "blocks repository initialization");
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
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
      expect(field(await health.json(), "check")).toBe("liveness");

      const readiness = await request(handle, "/readyz");
      expect(readiness.status).toBe(503);
      expect(field(field(await readiness.json(), "error"), "code")).toBe(
        "RemoteLibraryUnavailable",
      );

      const api = await request(handle, "/api/v1/remote-library/capabilities", ADMIN_TOKEN);
      expect(api.status).toBe(503);
      expect(field(field(await api.json(), "error"), "code")).toBe("RemoteLibraryUnavailable");

      const preflight = await request(handle, "/api/v1/remote-library/objects/hash", undefined, {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(503);
      expect(field(field(await preflight.json(), "error"), "code")).toBe(
        "RemoteLibraryUnavailable",
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toEqual([]);
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
    expect(field(await initialReadiness.json(), "check")).toBe("readiness");

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
    expect(field(await capabilities.json(), "protocol")).toBe("selftune.remote-library.v1");

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
    const snapshotId = stringField(field(await commit.json(), "snapshot"), "id");

    const adminObjectPath = join(dataDir, "objects", ADMIN_ORG_ID, objectSha256);
    writeFileSync(adminObjectPath, "corrupt object bytes");
    const degradedDiagnostics = await request(
      handle,
      "/api/v1/remote-library/diagnostics",
      ADMIN_TOKEN,
    );
    expect(degradedDiagnostics.status).toBe(200);
    const degradedPayload = await degradedDiagnostics.json();
    expect(field(degradedPayload, "status")).toBe("degraded");
    expect(field(degradedPayload, "missing_objects")).toEqual([objectSha256]);

    const livenessWhileDegraded = await request(handle, "/healthz");
    expect(livenessWhileDegraded.status).toBe(200);
    expect(field(await livenessWhileDegraded.json(), "check")).toBe("liveness");
    const degradedReadiness = await request(handle, "/readyz");
    expect(degradedReadiness.status).toBe(503);
    expect(field(field(await degradedReadiness.json(), "error"), "code")).toBe(
      "RemoteLibraryIntegrityDegraded",
    );

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
    expect(field(field(await corruptCommit.json(), "error"), "code")).toBe(
      "RemoteLibraryHashMismatch",
    );

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
    expect(field(await repair.json(), "created")).toBe(false);
    expect(readdirSync(dirname(adminObjectPath)).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );

    const healthyDiagnostics = await request(
      handle,
      "/api/v1/remote-library/diagnostics",
      ADMIN_TOKEN,
    );
    expect(field(await healthyDiagnostics.json(), "status")).toBe("ok");
    const repairedReadiness = await request(handle, "/readyz");
    expect(repairedReadiness.status).toBe(200);
    expect(field(await repairedReadiness.json(), "check")).toBe("readiness");

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
    const conflictError = field(await conflict.json(), "error");
    expect(field(conflictError, "code")).toBe("RemoteLibraryHeadConflict");
    expect(field(conflictError, "current_head_id")).toBe(snapshotId);

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
    const shareId = stringField(field(await createShare.json(), "share"), "id");

    const accept = await request(
      handle,
      `/api/v1/remote-library/shares/${shareId}/accept`,
      MEMBER_TOKEN,
      { method: "POST" },
    );
    expect(accept.status).toBe(200);
    expect(field(field(await accept.json(), "share"), "status")).toBe("accepted");

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
    expect(field(field(await rejectedImport.json(), "error"), "code")).toBe(
      "RemoteLibraryHashMismatch",
    );

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
    expect(field(field(importedPayload, "share"), "status")).toBe("imported");
    expect(field(importedPayload, "snapshot")).not.toBeNull();

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
    expect(field(field(await crossTenantReadiness.json(), "error"), "code")).toBe(
      "RemoteLibraryIntegrityDegraded",
    );
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
    expect(stringField(field(await persistedHead.json(), "snapshot"), "id")).toBe(snapshotId);
  });
});
