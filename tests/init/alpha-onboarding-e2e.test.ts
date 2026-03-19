/**
 * E2E smoke test: fresh config → alpha-enrolled → upload-ready
 *
 * Proves the agent-first alpha onboarding path works end-to-end
 * without a live cloud API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getAlphaLinkState,
  readAlphaIdentity,
  writeAlphaIdentity,
} from "../../cli/selftune/alpha-identity.js";
import { checkAlphaReadiness } from "../../cli/selftune/init.js";
import { checkCloudLinkHealth } from "../../cli/selftune/observability.js";
import type { AlphaIdentity } from "../../cli/selftune/types.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-onboarding-e2e-"));
  configPath = join(tmpDir, "config.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Agent-first alpha onboarding E2E", () => {
  test("fresh config → alpha-enrolled → upload-ready", () => {
    // Step 1: Fresh machine — no config exists
    expect(readAlphaIdentity(configPath)).toBeNull();
    expect(getAlphaLinkState(null)).toBe("not_linked");

    const readiness0 = checkAlphaReadiness(configPath);
    expect(readiness0.ready).toBe(false);
    expect(readiness0.missing).toContain("alpha identity not configured");

    // Step 2: Agent enrolls user (simulating selftune init --alpha ...)
    const identity: AlphaIdentity = {
      enrolled: true,
      user_id: "test-uuid-1234",
      email: "user@example.com",
      display_name: "Test User",
      consent_timestamp: new Date().toISOString(),
    };
    writeFileSync(configPath, JSON.stringify({ alpha: identity }, null, 2));

    // Step 3: Enrolled but no credential and no cloud link — not ready
    const readiness1 = checkAlphaReadiness(configPath);
    expect(readiness1.ready).toBe(false);
    expect(readiness1.missing).toContain("api_key not set");
    expect(readiness1.missing).toContain("not linked to cloud account");

    // Without cloud_user_id, link state is "not_linked"
    expect(getAlphaLinkState(identity)).toBe("not_linked");

    // Step 4: User provides cloud credential and cloud_user_id
    const linkedIdentity: AlphaIdentity = {
      ...identity,
      api_key: "st_live_abc123xyz",
      cloud_user_id: "cloud-user-5678",
    };
    writeAlphaIdentity(configPath, linkedIdentity);

    // Step 5: Verify readiness — should be fully ready
    const readiness2 = checkAlphaReadiness(configPath);
    expect(readiness2.ready).toBe(true);
    expect(readiness2.missing).toHaveLength(0);

    expect(getAlphaLinkState(linkedIdentity)).toBe("ready");

    // Step 6: Health checks pass
    const healthChecks = checkCloudLinkHealth(linkedIdentity);
    expect(healthChecks.length).toBeGreaterThan(0);
    expect(healthChecks.every((c) => c.status === "pass")).toBe(true);

    // Step 7: Verify persisted config has all fields
    const persisted = readAlphaIdentity(configPath);
    expect(persisted?.enrolled).toBe(true);
    expect(persisted?.api_key).toBe("st_live_abc123xyz");
    expect(persisted?.cloud_user_id).toBe("cloud-user-5678");
    expect(persisted?.email).toBe("user@example.com");
  });

  test("link state transitions are correct", () => {
    expect(getAlphaLinkState(null)).toBe("not_linked");

    expect(
      getAlphaLinkState({
        enrolled: false,
        user_id: "u1",
        consent_timestamp: "",
        cloud_user_id: "cloud-1",
      }),
    ).toBe("linked_not_enrolled");

    expect(
      getAlphaLinkState({
        enrolled: true,
        user_id: "u1",
        consent_timestamp: "",
        cloud_user_id: "cloud-1",
      }),
    ).toBe("enrolled_no_credential");

    expect(
      getAlphaLinkState({
        enrolled: true,
        user_id: "u1",
        consent_timestamp: "",
        cloud_user_id: "cloud-1",
        api_key: "st_live_x",
      }),
    ).toBe("ready");
  });

  test("invalid credential format detected by readiness check", () => {
    const identity: AlphaIdentity = {
      enrolled: true,
      user_id: "u1",
      email: "test@test.com",
      consent_timestamp: new Date().toISOString(),
      api_key: "bad_key_format",
      cloud_user_id: "cloud-1",
    };
    writeAlphaIdentity(configPath, identity);

    const readiness = checkAlphaReadiness(configPath);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing.some((m) => m.includes("invalid format"))).toBe(true);
  });
});
