import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDashboardServer } from "@selftune/local/dashboard-server";

import type { SelfHostConfig } from "./config.js";
import { makeRemoteDashboardLoaders } from "./remote-dashboard.js";
import type { RemoteApiHandle } from "./remote-api.js";
import { makeRemoteApi } from "./remote-api.js";

const ADMIN_TOKEN = "ADMIN_TOKEN_PLACEHOLDER";
const OTHER_ADMIN_TOKEN = "other-ADMIN_TOKEN_PLACEHOLDER";
const ADMIN_ORG_ID = "018f6e32-8f5d-7a30-9f7f-74de38d82200";
const OTHER_ORG_ID = "018f6e32-8f5d-7a30-9f7f-74de38d82201";
const PUBLIC_URL = "https://selftune.example.com";

const temporaryDirectories: string[] = [];
const remoteHandles: RemoteApiHandle[] = [];
const dashboardHandles: Array<{ readonly stop: () => void }> = [];

afterEach(async () => {
  for (const dashboard of dashboardHandles.splice(0)) dashboard.stop();
  await Promise.all(remoteHandles.splice(0).map((handle) => handle.dispose()));
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
        email: "other-admin@example.com",
        name: "Other Admin",
        orgId: OTHER_ORG_ID,
        orgName: "Other Org",
        role: "admin",
        token: OTHER_ADMIN_TOKEN,
      },
    ],
    adminToken: ADMIN_TOKEN,
    allowedOrigins: [PUBLIC_URL],
    dataDir,
    host: "127.0.0.1",
    maxObjectBytes: 1024 * 1024,
    port: 8787,
    publicUrl: PUBLIC_URL,
    spaDir: undefined,
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageBytes(name: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "SKILL.md",
          contentBase64: Buffer.from(`---\nname: ${name}\n---\n`).toString("base64"),
        },
      ],
    }),
  );
}

async function apiRequest(
  handle: RemoteApiHandle,
  path: string,
  init: RequestInit = {},
  token = ADMIN_TOKEN,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await handle.handle(
    new Request(`http://selftune.internal${path}`, {
      ...init,
      headers,
    }),
  );
  if (!response) throw new TypeError(`Self-host API did not handle ${path}.`);
  return response;
}

async function putObject(
  handle: RemoteApiHandle,
  bytes: Uint8Array,
  token = ADMIN_TOKEN,
): Promise<string> {
  const objectSha256 = sha256(bytes);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const response = await apiRequest(
    handle,
    `/api/v1/remote-library/objects/${objectSha256}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    },
    token,
  );
  expect(response.status).toBe(201);
  return objectSha256;
}

function createHandle() {
  const dataDir = mkdtempSync(join(tmpdir(), "selftune-remote-dashboard-"));
  temporaryDirectories.push(dataDir);
  const hostConfig = config(dataDir);
  const handle = makeRemoteApi(hostConfig);
  remoteHandles.push(handle);
  return { config: hostConfig, handle };
}

describe("self-hosted remote dashboard read model", () => {
  test.each(["not JSON", '{"snapshot":{"id":42}}'])(
    "rejects malformed snapshot responses: %s",
    async (body) => {
      const loaders = makeRemoteDashboardLoaders(config("unused"), {
        handle: async () => new Response(body),
        dispose: async () => {},
        ready: Promise.resolve(),
      });
      await expect(loaders.libraryLoader()).rejects.toMatchObject({
        operation: "decode_head",
        status: 502,
      });
    },
  );
  test.each(["not JSON", '{"schema_version":1,"skills":42}'])(
    "rejects malformed stored Skill Set bytes: %s",
    async (body) => {
      const { config: hostConfig, handle } = createHandle();
      const objectSha256 = await putObject(handle, new TextEncoder().encode(body));
      const commit = await apiRequest(handle, "/api/v1/remote-library/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: "selftune.remote-library.snapshot.v1",
          expected_parent_id: null,
          artifacts: [
            {
              artifact_id: "skill-set/broken/v1",
              artifact_type: "skill_set",
              object_sha256: objectSha256,
              revision: sha256("broken-v1"),
              metadata: {},
            },
          ],
        }),
      });
      expect(commit.status).toBe(201);
      await expect(
        makeRemoteDashboardLoaders(hostConfig, handle).skillSetsLoader(),
      ).rejects.toMatchObject({
        operation: "decode_skill_set",
        status: 422,
      });
    },
  );
  test("returns canonical empty Library and Skill Set views before the first backup", async () => {
    const { config: hostConfig, handle } = createHandle();
    const hiddenBytes = packageBytes("other-org-skill");
    const hiddenObject = await putObject(handle, hiddenBytes, OTHER_ADMIN_TOKEN);
    const hiddenRevision = sha256("other-org-skill-v1");
    const hiddenCommit = await apiRequest(
      handle,
      "/api/v1/remote-library/snapshots",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: "selftune.remote-library.snapshot.v1",
          expected_parent_id: null,
          artifacts: [
            {
              artifact_id: `skill/other-org-skill/${hiddenRevision}`,
              artifact_type: "skill_revision",
              object_sha256: hiddenObject,
              revision: hiddenRevision,
              metadata: {},
            },
          ],
        }),
      },
      OTHER_ADMIN_TOKEN,
    );
    expect(hiddenCommit.status).toBe(201);
    const loaders = makeRemoteDashboardLoaders(hostConfig, handle);

    expect(await loaders.libraryLoader()).toEqual({
      generatedAt: "1970-01-01T00:00:00.000Z",
      skills: [],
      counts: { total: 0, active: 0, library: 0, draft: 0, archived: 0 },
    });
    expect(await loaders.skillSetsLoader()).toEqual({ sets: [], receipts: [] });
  });

  test("serves uploaded skill revisions and Skill Sets without local materialization", async () => {
    const { config: hostConfig, handle } = createHandle();
    const releasedBytes = packageBytes("science-workflow");
    const draftBytes = packageBytes("science-workflow-draft");
    const draftOnlyBytes = packageBytes("draft-only");
    const releasedObject = await putObject(handle, releasedBytes);
    const draftObject = await putObject(handle, draftBytes);
    const draftOnlyObject = await putObject(handle, draftOnlyBytes);
    const releasedRevision = sha256("science-workflow-v1");
    const draftRevision = sha256("science-workflow-v2-draft");
    const draftOnlyRevision = sha256("draft-only-v1");
    const setRevision = sha256("science-set-v1");
    const setBytes = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        set_id: "science-stack",
        name: "Science Stack",
        description: "Skills used for a measured improvement workflow.",
        harnesses: ["codex", "claude_code"],
        skills: [{ name: "science-workflow", content_hash: releasedRevision }],
        revision: 1,
        revision_hash: setRevision,
        parent_revision_hash: null,
        created_at: "2026-07-14T10:00:00.000Z",
        updated_at: "2026-07-14T10:00:00.000Z",
      }),
    );
    const setObject = await putObject(handle, setBytes);

    const commit = await apiRequest(handle, "/api/v1/remote-library/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "selftune.remote-library.snapshot.v1",
        expected_parent_id: null,
        artifacts: [
          {
            artifact_id: `skill/science-workflow/${releasedRevision}`,
            artifact_type: "skill_revision",
            object_sha256: releasedObject,
            revision: releasedRevision,
            metadata: { skill_name: 42, updated_at: "2026-07-13T10:00:00.000Z" },
          },
          {
            artifact_id: `draft/science-workflow/${draftRevision}`,
            artifact_type: "draft_revision",
            object_sha256: draftObject,
            revision: draftRevision,
            metadata: { skill_name: "  ", updated_at: "2026-07-14T09:00:00.000Z" },
          },
          {
            artifact_id: `draft/draft-only/${draftOnlyRevision}`,
            artifact_type: "draft_revision",
            object_sha256: draftOnlyObject,
            revision: draftOnlyRevision,
            metadata: { updated_at: "2026-07-14T08:00:00.000Z" },
          },
          {
            artifact_id: `skill-set/science-stack/${setRevision}`,
            artifact_type: "skill_set",
            object_sha256: setObject,
            revision: setRevision,
            metadata: { updated_at: "2026-07-14T10:00:00.000Z" },
          },
        ],
      }),
    });
    expect(commit.status).toBe(201);

    const loaders = makeRemoteDashboardLoaders(hostConfig, handle);
    const library = await loaders.libraryLoader();
    expect(library.counts).toEqual({ total: 2, active: 0, library: 1, draft: 1, archived: 0 });
    const releasedSkill = library.skills.find((skill) => skill.skillId === "science-workflow");
    expect(releasedSkill?.lifecycle).toBe("library");
    expect(releasedSkill?.revisions.map((revision) => revision.contentHash).toSorted()).toEqual(
      [releasedRevision, draftRevision].toSorted(),
    );
    expect(releasedSkill?.locations.every((location) => location.sourceKind === "remote")).toBe(
      true,
    );
    expect(releasedSkill?.origins).toEqual([
      { kind: "registry", label: "SelfTune Remote Library", url: PUBLIC_URL },
    ]);
    expect(library.skills.find((skill) => skill.skillId === "draft-only")?.lifecycle).toBe("draft");

    const skillSets = await loaders.skillSetsLoader();
    expect(skillSets.receipts).toEqual([]);
    expect(skillSets.sets).toHaveLength(1);
    expect(skillSets.sets[0]?.set_id).toBe("science-stack");
    expect(skillSets.sets[0]?.skills[0]?.library_package_path).toBe(
      `selftune-remote://objects/${releasedObject}/packages/science-workflow`,
    );

    const dashboard = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      openBrowser: false,
      authToken: ADMIN_TOKEN,
      externalRequestHandler: handle.handle,
      libraryLoader: loaders.libraryLoader,
      skillSetsLoader: loaders.skillSetsLoader,
      overviewLoader: () => {
        throw new TypeError("Overview should not be loaded in this test.");
      },
      skillReportLoader: () => {
        throw new TypeError("Skill report should not be loaded in this test.");
      },
      runtimeMode: "test",
    });
    dashboardHandles.push(dashboard);
    const baseUrl = `http://127.0.0.1:${dashboard.port}`;
    const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };

    const libraryResponse = await fetch(`${baseUrl}/api/v2/library`, { headers });
    expect(libraryResponse.status).toBe(200);
    expect(await libraryResponse.json()).toMatchObject({ counts: library.counts });

    const skillSetsResponse = await fetch(`${baseUrl}/api/v2/skill-sets`, { headers });
    expect(skillSetsResponse.status).toBe(200);
    expect(await skillSetsResponse.json()).toMatchObject({ sets: skillSets.sets });

    const readOnlyMutation = await fetch(`${baseUrl}/api/v2/skill-sets`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Origin: baseUrl,
      },
      body: "{}",
    });
    expect(readOnlyMutation.status).toBe(405);
    expect(readOnlyMutation.headers.get("allow")).toBe("GET");
    expect(await readOnlyMutation.json()).toMatchObject({ error: { code: "READ_ONLY_HOST" } });
  });
});
