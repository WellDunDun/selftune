import { afterEach, describe, expect, test } from "bun:test";

import { startDashboardServer, type DashboardServerOptions } from "../src/dashboard-server.js";
import type { HookRunner } from "../src/routes/hooks.js";

const AUTH_TOKEN = "PLACEHOLDER_HOOK_ROUTE_TOKEN";
const servers: Array<Awaited<ReturnType<typeof startDashboardServer>>> = [];

async function startWithRunners(runners: DashboardServerOptions["hookRunners"]) {
  const handle = await startDashboardServer({
    port: 0,
    host: "127.0.0.1",
    openBrowser: false,
    manageProcessSignals: false,
    authToken: AUTH_TOKEN,
    hookRunners: runners,
  });
  servers.push(handle);
  return `http://127.0.0.1:${handle.port}`;
}

function postHook(baseUrl: string, name: string, body: string, authenticated = true) {
  return fetch(`${baseUrl}/api/hooks/${name}`, {
    method: "POST",
    headers: authenticated ? { Authorization: `Bearer ${AUTH_TOKEN}` } : undefined,
    body,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("POST /api/hooks/:name", () => {
  test("relays synchronous hook output", async () => {
    const baseUrl = await startWithRunners({
      "auto-activate": async (rawStdin) => ({
        exit_code: 2,
        stdout: rawStdin,
        stderr: "guard detail\n",
      }),
    });

    const response = await postHook(baseUrl, "auto-activate", '{"session_id":"sync"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      exit_code: 2,
      stdout: '{"session_id":"sync"}',
      stderr: "guard detail\n",
    });
  });

  test("admits telemetry and responds 202", async () => {
    const baseUrl = await startWithRunners({
      "prompt-log": async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    });

    const response = await postHook(baseUrl, "prompt-log", '{"session_id":"telemetry"}');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
  });

  test("serializes each session while allowing different sessions to interleave", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const releases = new Map<string, () => void>();
    const runner: HookRunner = async (rawStdin) => {
      const payload = JSON.parse(rawStdin) as { event: string };
      started.push(payload.event);
      await new Promise<void>((resolve) => releases.set(payload.event, resolve));
      finished.push(payload.event);
      return { exit_code: 0, stdout: "", stderr: "" };
    };
    const baseUrl = await startWithRunners({ "prompt-log": runner });

    expect(
      (await postHook(baseUrl, "prompt-log", '{"session_id":"same","event":"same-1"}')).status,
    ).toBe(202);
    expect(
      (await postHook(baseUrl, "prompt-log", '{"session_id":"same","event":"same-2"}')).status,
    ).toBe(202);
    expect(
      (await postHook(baseUrl, "prompt-log", '{"session_id":"other","event":"other-1"}')).status,
    ).toBe(202);

    await Bun.sleep(10);
    expect(started).toContain("same-1");
    expect(started).toContain("other-1");
    expect(started).not.toContain("same-2");

    releases.get("other-1")?.();
    releases.get("same-1")?.();
    await Bun.sleep(10);
    expect(started).toEqual(expect.arrayContaining(["same-1", "other-1", "same-2"]));
    expect(finished.indexOf("same-1")).toBeLessThan(started.indexOf("same-2"));

    releases.get("same-2")?.();
  });

  test("requires bearer authentication", async () => {
    const baseUrl = await startWithRunners({});
    const response = await postHook(baseUrl, "prompt-log", '{"session_id":"no-auth"}', false);
    expect(response.status).toBe(401);
  });

  test("returns 404 for an unknown hook", async () => {
    const baseUrl = await startWithRunners({});
    const response = await postHook(baseUrl, "not-a-hook", "{}");
    expect(response.status).toBe(404);
  });

  test("rejects hook bodies larger than 2MB", async () => {
    const baseUrl = await startWithRunners({});
    const response = await postHook(baseUrl, "prompt-log", "x".repeat(2 * 1024 * 1024 + 1));
    expect(response.status).toBe(413);
  });
});
