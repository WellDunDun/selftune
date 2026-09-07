import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadSelfHostConfig } from "./config.js";
import { makeRemoteApi, type RemoteApiHandle } from "./remote-api.js";

const token = "SELFHOST_REQUEST_CONTRACT_ADMIN_0001";
const origin = "https://selftune.example.com";
const roots: string[] = [];
const handles: RemoteApiHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function api() {
  const dataDir = mkdtempSync(join(tmpdir(), "selftune-selfhost-request-"));
  roots.push(dataDir);
  const config = await Effect.runPromise(
    loadSelfHostConfig({
      SELFTUNE_AUTH_TOKEN: token,
      SELFTUNE_PUBLIC_URL: origin,
      SELFTUNE_DATA_DIR: dataDir,
    }),
  );
  const handle = makeRemoteApi(config);
  handles.push(handle);
  await handle.ready;
  return handle;
}

const routes = [
  {
    path: "/api/v1/remote-library/snapshots",
    code: "RemoteLibraryInvalidSnapshot",
    message: "Invalid Remote Library snapshot",
  },
  {
    path: "/api/v1/remote-library/shares",
    code: "RemoteLibraryInvalidShare",
    message: "Invalid private share",
  },
  {
    path: "/api/v1/remote-library/packs",
    code: "RemoteLibraryInvalidPack",
    message: "Invalid Skill Set Pack request",
  },
  {
    path: "/api/v1/contributions/relay",
    code: "ContributorSignalInvalid",
    message: "Invalid contributor signal",
  },
  {
    path: "/api/v1/desktop/manifest",
    code: "HostedManifestInvalid",
    message: "Invalid Desktop manifest",
  },
];

describe("self-host request contracts", () => {
  test.each(
    routes.flatMap((route) =>
      ["{broken", "null", '{"private":"PRIVATE_PAYLOAD_MARKER"}'].map((body) => ({
        ...route,
        body,
      })),
    ),
  )(
    "rejects malformed request bodies without reflecting their contents: %j",
    async ({ path, code, message, body }) => {
      const handle = await api();
      const response = await handle.handle(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body,
        }),
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: { code, message } });
      const diagnostics = await handle.handle(
        new Request(`${origin}/api/v1/remote-library/diagnostics`, {
          headers: { Authorization: `Bearer ${token}`, Origin: origin },
        }),
      );
      expect(diagnostics?.status).toBe(200);
      expect(await diagnostics?.json()).toMatchObject({ object_count: 0, snapshot_count: 0 });
    },
  );

  test.each(routes)("authenticates before decoding %j", async ({ path }) => {
    const handle = await api();
    const response = await handle.handle(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: origin },
        body: "{broken",
      }),
    );
    expect(response?.status).toBe(401);
  });
});
