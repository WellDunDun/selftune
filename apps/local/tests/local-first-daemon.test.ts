import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "@selftune/runtime/localdb/db";
import { startDashboardServer } from "../src/dashboard-server.js";
import { installFetchSpy } from "../../../tests/helpers/fetch-spy.js";

const directories: string[] = [];
const servers: Awaited<ReturnType<typeof startDashboardServer>>[] = [];
let restoreFetch: (() => void) | undefined;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  restoreFetch?.();
  restoreFetch = undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("an enrolled daemon serves local requests without sending or pruning legacy uploads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-local-first-daemon-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({
      agent_type: "codex",
      llm_mode: "agent",
      agent_cli: "codex",
      cli_path: "/test/selftune",
      hooks_installed: false,
      initialized_at: "2026-09-05T00:00:00.000Z",
      alpha: {
        enrolled: true,
        user_id: "local-test",
        cloud_user_id: "cloud-test",
        credential: { provider: "file", account: "test" },
      },
    }),
  );
  writeFileSync(
    join(directory, "credential-store.json"),
    JSON.stringify({ test: "st_test_not_real" }),
  );
  const db = openDb(join(directory, "selftune.db"));
  db.run(
    "INSERT INTO upload_queue(payload_type, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["canonical", '{"private":"local history"}', "pending", "2020-01-01", "2020-01-01"],
  );
  db.close();
  const originalFetch = globalThis.fetch;
  const externalRequests: string[] = [];
  restoreFetch = installFetchSpy(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "127.0.0.1") return originalFetch(input, options);
    externalRequests.push(url.href);
    throw new Error("Unexpected external request during local daemon test");
  });
  const server = await startDashboardServer({
    port: 0,
    host: "127.0.0.1",
    runtimeMode: "standalone",
    openBrowser: false,
    manageProcessSignals: false,
    skillSetConfigRoot: directory,
  });
  servers.push(server);
  const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
  expect(health.status).toBe(200);
  const retired = await fetch(
    `http://127.0.0.1:${server.port}/api/v2/trace-candidates/draft/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  expect(retired.status).toBe(404);
  await server.close();
  servers.pop();
  expect(externalRequests).toEqual([]);
  const retained = openDb(join(directory, "selftune.db"));
  try {
    expect(
      retained
        .query<{ status: string; payload_json: string }, []>(
          "SELECT status, payload_json FROM upload_queue",
        )
        .all(),
    ).toEqual([{ status: "pending", payload_json: '{"private":"local history"}' }]);
  } finally {
    retained.close();
  }
});

test("product entry points cannot reconnect the retired telemetry uploader", async () => {
  const root = resolve(import.meta.dir, "../../..");
  expect(existsSync(join(root, "packages/runtime/alpha-upload/index.ts"))).toBe(false);
  for (const directory of [
    "packages/runtime",
    "packages/orchestration/src",
    "apps/local/src",
    "apps/cli/src",
  ]) {
    for await (const file of new Bun.Glob("**/*.ts").scan(join(root, directory))) {
      const source = readFileSync(join(root, directory, file), "utf8");
      expect(source, file).not.toMatch(
        /from\s+["'][^"']*alpha-upload|import\(["'][^"']*alpha-upload/,
      );
      expect(source, file).not.toContain("prepareCompatibilityExport");
      expect(source, file).not.toContain("createCompatibilityExportWorker");
      expect(source, file).not.toContain("CloudEvaluationSubmissionClient");
      expect(source, file).not.toContain("CloudEvaluationTargetClient");
    }
  }
});
