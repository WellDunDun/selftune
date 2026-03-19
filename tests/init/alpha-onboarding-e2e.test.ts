/**
 * E2E smoke test: fresh config → alpha-enrolled → upload-ready
 *
 * Exercises the real runInit() path, not synthetic config writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAlphaLinkState, readAlphaIdentity } from "../../cli/selftune/alpha-identity.js";
import { checkAlphaReadiness, runInit } from "../../cli/selftune/init.js";
import { checkCloudLinkHealth } from "../../cli/selftune/observability.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-onboarding-e2e-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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
  test("fresh config → selftune init --alpha → upload-ready", () => {
    const opts = makeInitOpts();

    // Step 1: Fresh machine — no config exists
    expect(readAlphaIdentity(opts.configPath)).toBeNull();
    const readiness0 = checkAlphaReadiness(opts.configPath);
    expect(readiness0.ready).toBe(false);
    expect(readiness0.missing).toContain("alpha identity not configured");

    // Step 2: Enroll with email only (no key yet)
    const config1 = runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "user@example.com",
        alphaName: "Test User",
      }),
    );

    expect(config1.alpha?.enrolled).toBe(true);
    expect(config1.alpha?.email).toBe("user@example.com");

    // Step 3: Without api_key, not ready
    const readiness1 = checkAlphaReadiness(opts.configPath);
    expect(readiness1.ready).toBe(false);
    expect(readiness1.missing).toContain("api_key not set");

    const identity1 = readAlphaIdentity(opts.configPath);
    expect(getAlphaLinkState(identity1)).toBe("enrolled_no_credential");

    // Step 4: Re-init with credential
    const config2 = runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "user@example.com",
        alphaKey: "st_live_abc123xyz",
        force: true,
      }),
    );

    expect(config2.alpha?.api_key).toBe("st_live_abc123xyz");

    // Step 5: Now fully ready
    const readiness2 = checkAlphaReadiness(opts.configPath);
    expect(readiness2.ready).toBe(true);
    expect(readiness2.missing).toHaveLength(0);

    const identity2 = readAlphaIdentity(opts.configPath);
    expect(getAlphaLinkState(identity2)).toBe("ready");

    // Step 6: Health checks pass
    const healthChecks = checkCloudLinkHealth(identity2);
    expect(healthChecks.length).toBeGreaterThan(0);
    expect(healthChecks.every((c) => c.status === "pass")).toBe(true);
  });

  test("invalid credential format rejected by init", () => {
    expect(() =>
      runInit(
        makeInitOpts({
          alpha: true,
          alphaEmail: "user@example.com",
          alphaKey: "bad_key_format",
        }),
      ),
    ).toThrow("invalid_api_key_format");
  });

  test("link state transitions are correct", () => {
    expect(getAlphaLinkState(null)).toBe("not_linked");

    // enrolled=false, no cloud_user_id → not_linked
    expect(
      getAlphaLinkState({
        enrolled: false,
        user_id: "u1",
        consent_timestamp: "",
      }),
    ).toBe("not_linked");

    // enrolled=false, has cloud_user_id → linked_not_enrolled
    expect(
      getAlphaLinkState({
        enrolled: false,
        user_id: "u1",
        consent_timestamp: "",
        cloud_user_id: "cloud-1",
      }),
    ).toBe("linked_not_enrolled");

    // enrolled=true, no api_key → enrolled_no_credential
    expect(
      getAlphaLinkState({
        enrolled: true,
        user_id: "u1",
        consent_timestamp: "",
      }),
    ).toBe("enrolled_no_credential");

    // enrolled=true, has api_key → ready
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
