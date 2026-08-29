/**
 * Tests for the expanded /api/health endpoint with runtime identity fields.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HealthResponse } from "../../packages/runtime/dashboard-contract.js";

let startDashboardServer: typeof import("@selftune/local/dashboard-server").startDashboardServer;
let testSpaDir: string;
let server: Awaited<ReturnType<typeof startDashboardServer>> | null = null;
let shutdownRequests = 0;
const healthAuthToken = "PLACEHOLDER_HEALTH_AUTH_TOKEN";

beforeAll(async () => {
  const mod = await import("@selftune/local/dashboard-server");
  startDashboardServer = mod.startDashboardServer;
  testSpaDir = mkdtempSync(join(tmpdir(), "selftune-health-test-"));
  mkdirSync(join(testSpaDir, "assets"), { recursive: true });
  writeFileSync(join(testSpaDir, "index.html"), `<!DOCTYPE html><html><body></body></html>`);
});

afterAll(async () => {
  if (server) await server.stop();
  try {
    rmSync(testSpaDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("/api/health runtime identity", () => {
  it("rejects runtime identity without dashboard authentication", async () => {
    await expect(
      startDashboardServer({
        port: 0,
        host: "127.0.0.1",
        openBrowser: false,
        runtimeIdentity: {
          configDir: testSpaDir,
          instanceId: "unauthenticated-instance",
          owner: "cli",
          supervision: "os-service",
          ownerExecutablePath: "/usr/local/bin/selftune",
        },
      }),
    ).rejects.toThrow("Runtime identity requires authenticated dashboard health");
  });

  it("returns all expected fields", async () => {
    server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: testSpaDir,
      openBrowser: false,
      authToken: healthAuthToken,
      runtimeMode: "test",
      runtimeIdentity: {
        configDir: testSpaDir,
        instanceId: "health-test-instance",
        owner: "desktop",
        serviceInstallationNonce: "abcdefghijklmnopqrstuvwxyz_ABCDE",
        supervision: "os-service",
        ownerExecutablePath: "/Applications/SelfTune.app/Contents/MacOS/SelfTune",
      },
      runtimeShutdown: () => {
        shutdownRequests += 1;
      },
      overviewLoader: () => ({
        overview: {
          telemetry: [],
          skills: [],
          evolution: [],
          counts: { telemetry: 0, skills: 0, evolution: 0, evidence: 0, sessions: 0, prompts: 0 },
          unmatched_queries: [],
          pending_proposals: [],
          active_sessions: 0,
          recent_activity: [],
        },
        skills: [],
        watched_skills: [],
        autonomy_status: {
          level: "healthy",
          summary: "No issues",
          last_run: null,
          skills_observed: 0,
          pending_reviews: 0,
          attention_required: 0,
        },
        attention_queue: [],
        trust_watchlist: [],
        recent_decisions: [],
      }),
    });

    const origin = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${origin}/api/health`)).status).toBe(401);
    const res = await fetch(`${origin}/api/health`, {
      headers: { Authorization: `Bearer ${healthAuthToken}` },
    });
    expect(res.status).toBe(200);

    const body: HealthResponse = await res.json();

    // Original fields
    expect(body.ok).toBe(true);
    expect(body.service).toBe("selftune-dashboard");
    expect(typeof body.version).toBe("string");
    expect(body).toHaveProperty("latest_version");
    expect(typeof body.update_available).toBe("boolean");
    expect(typeof body.auto_update_supported).toBe("boolean");
    expect(body).toHaveProperty("update_hint");
    expect(typeof body.spa).toBe("boolean");
    expect(typeof body.v2_data_available).toBe("boolean");

    // New runtime identity fields
    expect(typeof body.workspace_root).toBe("string");
    expect(body.workspace_root).toBeTruthy();

    expect(typeof body.git_sha).toBe("string");

    expect(typeof body.db_path).toBe("string");

    expect(typeof body.log_dir).toBe("string");
    expect(typeof body.config_dir).toBe("string");

    expect(["wal", "jsonl", "none"]).toContain(body.watcher_mode);
    expect(body.process_mode).toBe("test");
    expect(body.runtime_instance_id).toBe("health-test-instance");
    expect(body.runtime_owner).toBe("desktop");
    expect(body.runtime_supervision).toBe("os-service");
    expect(body.service_installation_nonce).toBe("abcdefghijklmnopqrstuvwxyz_ABCDE");
    expect(body.owner_executable_path).toBe("/Applications/SelfTune.app/Contents/MacOS/SelfTune");
    expect(body.config_dir).toBe(testSpaDir);

    expect(body.host).toBe("127.0.0.1");
    expect(typeof body.port).toBe("number");
    expect(body.port).toBeGreaterThan(0);

    expect(
      (
        await fetch(`${origin}/api/runtime/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runtime_instance_id: "health-test-instance" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/runtime/shutdown`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${healthAuthToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ runtime_instance_id: "replacement-instance" }),
        })
      ).status,
    ).toBe(409);
    expect(shutdownRequests).toBe(0);
    expect(
      (
        await fetch(`${origin}/api/runtime/shutdown`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${healthAuthToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ runtime_instance_id: "health-test-instance" }),
        })
      ).status,
    ).toBe(202);
    await Bun.sleep(10);
    expect(shutdownRequests).toBe(1);
  });
});
