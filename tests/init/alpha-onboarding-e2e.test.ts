/**
 * E2E smoke test: fresh config → alpha-enrolled → upload-ready
 *
 * Since alpha enrollment uses the device-code flow (browser auth),
 * these tests mock fetch to simulate the cloud API responses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAlphaLinkState, readAlphaIdentity } from "../../cli/selftune/alpha-identity.js";
import { checkAlphaReadiness, runInit } from "../../cli/selftune/init.js";
import { checkCloudLinkHealth } from "../../cli/selftune/observability.js";

let tmpDir: string;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function mockDeviceCodeFlow(): void {
  process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";
  process.env.SELFTUNE_NO_BROWSER = "1";
  let pollCount = 0;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/device-code/poll")) {
      pollCount++;
      if (pollCount < 2) {
        return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: "approved",
          api_key: ["st_live", "e2e_test_key"].join("_"),
          cloud_user_id: "cloud-user-e2e",
          org_id: "org-e2e",
        }),
        { status: 200 },
      );
    }
    // /device-code request
    return new Response(
      JSON.stringify({
        device_code: "dc_e2e",
        user_code: "TEST-1234",
        verification_url: "https://test.local/verify",
        expires_in: 300,
        interval: 0.01,
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-onboarding-e2e-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function makeInitOpts(overrides: Record<string, unknown> = {}) {
  const configDir = join(tmpDir, ".selftune");
  const configPath = join(configDir, "config.json");
  return {
    configDir,
    configPath,
    force: false,
    agentOverride: "claude_code",
    cliPathOverride: "/test/cli/selftune/index.ts",
    homeDir: tmpDir,
    ...overrides,
  };
}

describe("Agent-first alpha onboarding E2E", () => {
  test("fresh config → selftune init --alpha → device-code → upload-ready", async () => {
    mockDeviceCodeFlow();
    const opts = makeInitOpts();

    // Step 1: Fresh machine — no config exists
    expect(readAlphaIdentity(opts.configPath)).toBeNull();
    const readiness0 = checkAlphaReadiness(opts.configPath);
    expect(readiness0.ready).toBe(false);
    expect(readiness0.missing).toContain("alpha identity not configured");
    expect(readiness0.guidance.blocking).toBe(true);
    expect(readiness0.guidance.next_command).toContain("selftune init --alpha");

    // Step 2: Enroll via device-code flow
    const config1 = await runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "user@example.com",
        alphaName: "Test User",
      }),
    );

    expect(config1.alpha?.enrolled).toBe(true);
    expect(config1.alpha?.email).toBe("user@example.com");
    expect(config1.alpha?.api_key).toBe(["st_live", "e2e_test_key"].join("_"));
    expect(config1.alpha?.cloud_user_id).toBe("cloud-user-e2e");
    expect(config1.alpha?.cloud_org_id).toBe("org-e2e");

    // Step 3: Readiness check — api_key is valid so readiness passes
    const readiness1 = checkAlphaReadiness(opts.configPath);
    expect(readiness1.ready).toBe(true);
    expect(readiness1.missing).toHaveLength(0);

    // Step 4: Health checks
    const identity1 = readAlphaIdentity(opts.configPath);
    const healthChecks = checkCloudLinkHealth(identity1);
    expect(healthChecks.length).toBeGreaterThan(0);
  });

  test("--alpha triggers device-code flow", async () => {
    mockDeviceCodeFlow();

    const config = await runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "user@example.com",
      }),
    );

    expect(config.alpha?.enrolled).toBe(true);
    expect(config.alpha?.cloud_user_id).toBe("cloud-user-e2e");
  });

  test("device-code flow failure propagates error", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";
    globalThis.fetch = (async () => {
      return new Response("Server Error", { status: 500, statusText: "Internal Server Error" });
    }) as typeof globalThis.fetch;

    await expect(
      runInit(
        makeInitOpts({
          alpha: true,
          alphaEmail: "user@example.com",
        }),
      ),
    ).rejects.toThrow("Device code request failed: 500");
  });

  test("link state transitions are correct", () => {
    expect(getAlphaLinkState(null)).toBe("not_linked");

    // enrolled=false, no cloud_user_id -> not_linked
    expect(
      getAlphaLinkState({
        enrolled: false,
        user_id: "u1",
        consent_timestamp: "",
      }),
    ).toBe("not_linked");

    // enrolled=false, has cloud_user_id -> linked_not_enrolled
    expect(
      getAlphaLinkState({
        enrolled: false,
        user_id: "u1",
        consent_timestamp: "",
        cloud_user_id: "cloud-1",
      }),
    ).toBe("linked_not_enrolled");

    // enrolled=true, no api_key -> enrolled_no_credential
    expect(
      getAlphaLinkState({
        enrolled: true,
        user_id: "u1",
        consent_timestamp: "",
      }),
    ).toBe("enrolled_no_credential");

    // enrolled=true, has cloud_user_id + valid api_key -> ready
    expect(
      getAlphaLinkState({
        enrolled: true,
        user_id: "u1",
        consent_timestamp: "",
        cloud_user_id: "cloud-1",
        api_key: "st_live_x",
      }),
    ).toBe("ready");

    // enrolled=true, has valid api_key but no cloud_user_id -> ready
    // (cloud_user_id is bonus enrichment, not a gate for readiness)
    expect(
      getAlphaLinkState({
        enrolled: true,
        user_id: "u1",
        consent_timestamp: "",
        api_key: "st_live_x",
      }),
    ).toBe("ready");
  });
});
