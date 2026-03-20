import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALPHA_CONSENT_NOTICE,
  generateUserId,
  readAlphaIdentity,
  writeAlphaIdentity,
} from "../../cli/selftune/alpha-identity.js";
import { runInit } from "../../cli/selftune/init.js";
import type { AlphaIdentity, SelftuneConfig } from "../../cli/selftune/types.js";

let tmpDir: string;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function mockDeviceCodeFlow(): void {
  process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";
  process.env.SELFTUNE_NO_BROWSER = "1";
  globalThis.fetch = (async (url: string) => {
    if (typeof url === "string" && url.endsWith("/device-code/poll")) {
      return new Response(
        JSON.stringify({
          status: "approved",
          api_key: "st_live_testkey123",
          cloud_user_id: "cloud-user-test",
          org_id: "org-test",
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        device_code: "dc_test",
        user_code: "TEST-0000",
        verification_url: "https://test.local/verify",
        expires_in: 300,
        interval: 0.01,
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-alpha-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// alpha-identity module
// ---------------------------------------------------------------------------

describe("generateUserId", () => {
  test("returns a valid UUID string", () => {
    const id = generateUserId();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("generates unique IDs on each call", () => {
    const id1 = generateUserId();
    const id2 = generateUserId();
    expect(id1).not.toBe(id2);
  });
});

describe("readAlphaIdentity", () => {
  test("returns null when config does not exist", () => {
    const result = readAlphaIdentity(join(tmpDir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  test("returns null when config has no alpha block", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ agent_type: "claude_code" }), "utf-8");
    const result = readAlphaIdentity(configPath);
    expect(result).toBeNull();
  });

  test("returns null when config contains malformed JSON", () => {
    const configPath = join(tmpDir, "bad.json");
    writeFileSync(configPath, "{invalid json!!!", "utf-8");
    const result = readAlphaIdentity(configPath);
    expect(result).toBeNull();
  });

  test("returns alpha block when present", () => {
    const configPath = join(tmpDir, "config.json");
    const alpha: AlphaIdentity = {
      enrolled: true,
      user_id: "test-uuid",
      email: "test@example.com",
      consent_timestamp: "2026-03-18T00:00:00Z",
    };
    writeFileSync(configPath, JSON.stringify({ agent_type: "claude_code", alpha }), "utf-8");

    const result = readAlphaIdentity(configPath);
    expect(result).not.toBeNull();
    expect(result?.enrolled).toBe(true);
    expect(result?.user_id).toBe("test-uuid");
    expect(result?.email).toBe("test@example.com");
  });
});

describe("writeAlphaIdentity", () => {
  test("writes alpha block to new config file", () => {
    const configPath = join(tmpDir, "config.json");
    const identity: AlphaIdentity = {
      enrolled: true,
      user_id: "new-uuid",
      email: "new@example.com",
      consent_timestamp: "2026-03-18T00:00:00Z",
    };

    writeAlphaIdentity(configPath, identity);

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.alpha).toEqual(identity);
  });

  test("throws when config contains malformed JSON", () => {
    const configPath = join(tmpDir, "corrupt.json");
    writeFileSync(configPath, "not valid json{{{", "utf-8");
    const identity: AlphaIdentity = {
      enrolled: true,
      user_id: "test-uuid",
      email: "test@example.com",
      consent_timestamp: "2026-03-18T00:00:00Z",
    };
    expect(() => writeAlphaIdentity(configPath, identity)).toThrow();
  });

  test("merges alpha block into existing config without clobbering other fields", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ agent_type: "claude_code", cli_path: "/test" }),
      "utf-8",
    );

    const identity: AlphaIdentity = {
      enrolled: true,
      user_id: "merged-uuid",
      email: "merged@example.com",
      consent_timestamp: "2026-03-18T00:00:00Z",
    };

    writeAlphaIdentity(configPath, identity);

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agent_type).toBe("claude_code");
    expect(raw.cli_path).toBe("/test");
    expect(raw.alpha.user_id).toBe("merged-uuid");
  });
});

describe("ALPHA_CONSENT_NOTICE", () => {
  test("contains key disclosure elements", () => {
    expect(ALPHA_CONSENT_NOTICE).toContain("alpha");
    expect(ALPHA_CONSENT_NOTICE).toContain("WHAT IS COLLECTED");
    expect(ALPHA_CONSENT_NOTICE).toContain("WHAT IS NOT COLLECTED");
    expect(ALPHA_CONSENT_NOTICE).toContain("Raw user prompt/query text");
    expect(ALPHA_CONSENT_NOTICE).toContain("selftune init --no-alpha");
  });
});

// ---------------------------------------------------------------------------
// runInit alpha integration (device-code flow)
// ---------------------------------------------------------------------------

describe("runInit with alpha", () => {
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

  test("writes alpha block with valid UUID via device-code flow", async () => {
    mockDeviceCodeFlow();
    const opts = makeInitOpts({
      alpha: true,
      alphaEmail: "user@example.com",
      alphaName: "Test User",
    });

    const config = await runInit(opts);

    expect(config.alpha).toBeDefined();
    expect(config.alpha?.enrolled).toBe(true);
    expect(config.alpha?.user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(config.alpha?.email).toBe("user@example.com");
    expect(config.alpha?.display_name).toBe("Test User");
    expect(config.alpha?.consent_timestamp).toBeTruthy();
    expect(config.alpha?.api_key).toBe("st_live_testkey123");
    expect(config.alpha?.cloud_user_id).toBe("cloud-user-test");
  });

  test("does NOT write alpha block when alpha flag is absent", async () => {
    const opts = makeInitOpts();
    const config = await runInit(opts);
    expect(config.alpha).toBeUndefined();
  });

  test("--no-alpha sets enrolled=false but preserves user_id", async () => {
    mockDeviceCodeFlow();

    // First, enroll via device-code
    const enrollConfig = await runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "user@example.com",
        force: true,
      }),
    );
    const originalUserId = enrollConfig.alpha?.user_id;

    // Then unenroll
    const unenrollConfig = await runInit(
      makeInitOpts({
        noAlpha: true,
        force: true,
      }),
    );

    expect(unenrollConfig.alpha).toBeDefined();
    expect(unenrollConfig.alpha?.enrolled).toBe(false);
    expect(unenrollConfig.alpha?.user_id).toBe(originalUserId);
  });

  test("reinit with force + alpha preserves existing user_id", async () => {
    mockDeviceCodeFlow();

    // First enrollment
    const firstConfig = await runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "first@example.com",
        force: true,
      }),
    );
    const originalUserId = firstConfig.alpha?.user_id;

    // Re-init with force + alpha (should preserve user_id)
    const secondConfig = await runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "second@example.com",
        force: true,
      }),
    );

    expect(secondConfig.alpha?.user_id).toBe(originalUserId);
    expect(secondConfig.alpha?.email).toBe("second@example.com");
  });

  test("plain force reinit preserves existing alpha enrollment", async () => {
    mockDeviceCodeFlow();

    const firstConfig = await runInit(
      makeInitOpts({
        alpha: true,
        alphaEmail: "first@example.com",
        force: true,
      }),
    );

    const secondConfig = await runInit(
      makeInitOpts({
        force: true,
      }),
    );

    expect(secondConfig.alpha).toBeDefined();
    expect(secondConfig.alpha?.enrolled).toBe(true);
    expect(secondConfig.alpha?.user_id).toBe(firstConfig.alpha?.user_id);
    expect(secondConfig.alpha?.email).toBe("first@example.com");
  });

  test("config round-trips correctly (read after write)", async () => {
    mockDeviceCodeFlow();
    const opts = makeInitOpts({
      alpha: true,
      alphaEmail: "roundtrip@example.com",
      alphaName: "Round Trip",
    });

    await runInit(opts);

    // Read back from disk
    const raw = JSON.parse(readFileSync(opts.configPath, "utf-8")) as SelftuneConfig;
    expect(raw.alpha).toBeDefined();
    expect(raw.alpha?.enrolled).toBe(true);
    expect(raw.alpha?.email).toBe("roundtrip@example.com");
    expect(raw.alpha?.display_name).toBe("Round Trip");
    expect(raw.alpha?.user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Read via the identity module
    const identity = readAlphaIdentity(opts.configPath);
    expect(identity).not.toBeNull();
    expect(identity?.user_id).toBe(raw.alpha?.user_id);
  });
});
