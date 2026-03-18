/**
 * Tests for the expanded /api/health endpoint with runtime identity fields.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthResponse } from "../../cli/selftune/dashboard-contract.js";

let startDashboardServer: typeof import("../../cli/selftune/dashboard-server.js").startDashboardServer;
let testSpaDir: string;
let server: Awaited<ReturnType<typeof startDashboardServer>> | null = null;

beforeAll(async () => {
  const mod = await import("../../cli/selftune/dashboard-server.js");
  startDashboardServer = mod.startDashboardServer;
  testSpaDir = mkdtempSync(join(tmpdir(), "selftune-health-test-"));
  mkdirSync(join(testSpaDir, "assets"), { recursive: true });
  writeFileSync(
    join(testSpaDir, "index.html"),
    `<!DOCTYPE html><html><body></body></html>`,
  );
});

afterAll(() => {
  if (server) server.stop();
  try {
    rmSync(testSpaDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe("/api/health runtime identity", () => {
  it("returns all expected fields", async () => {
    server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      runtimeMode: "test",
      overviewLoader: () => ({
        overview: {
          telemetry: [],
          skills: [],
          evolution: [],
          counts: { telemetry: 0, skills: 0, evolution: 0, evidence: 0, sessions: 0, prompts: 0 },
          unmatched_queries: [],
          pending_proposals: [],
        },
        skills: [],
      }),
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);

    const body: HealthResponse = await res.json();

    // Original fields
    expect(body.ok).toBe(true);
    expect(body.service).toBe("selftune-dashboard");
    expect(typeof body.version).toBe("string");
    expect(typeof body.spa).toBe("boolean");
    expect(typeof body.v2_data_available).toBe("boolean");

    // New runtime identity fields
    expect(typeof body.workspace_root).toBe("string");
    expect(body.workspace_root).toBe(process.cwd());

    expect(typeof body.git_sha).toBe("string");
    expect(body.git_sha.length).toBeGreaterThan(0);

    expect(typeof body.db_path).toBe("string");
    expect(body.db_path).toContain("selftune.db");

    expect(typeof body.log_dir).toBe("string");
    expect(typeof body.config_dir).toBe("string");

    expect(body.watcher_mode).toMatch(/^(jsonl|none)$/);
    expect(body.process_mode).toBe("test");

    expect(body.host).toBe("127.0.0.1");
    expect(typeof body.port).toBe("number");
    expect(body.port).toBeGreaterThan(0);
  });
});
