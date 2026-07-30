/**
 * Tests for alpha identity management — cached cloud identity model.
 *
 * Tests the AlphaIdentity interface, getAlphaLinkState() logic,
 * migrateLocalIdentity() detection, and config read/write helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateUserId,
  getAlphaLinkState,
  isValidApiKeyFormat,
  migrateLocalIdentity,
  readAlphaIdentity,
  writeAlphaIdentity,
} from "../../packages/runtime/alpha-identity.js";
import type { AlphaIdentity } from "../../packages/runtime/types.js";
import type { PlatformCredentialStore } from "../../packages/runtime/credential-store.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeIdentity(overrides: Partial<AlphaIdentity> = {}): AlphaIdentity {
  return {
    enrolled: true,
    user_id: "local-uuid-123",
    consent_timestamp: "2026-03-20T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateUserId
// ---------------------------------------------------------------------------

describe("generateUserId", () => {
  test("returns a valid UUID v4 string", () => {
    const id = generateUserId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("returns unique values on each call", () => {
    const a = generateUserId();
    const b = generateUserId();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// isValidApiKeyFormat
// ---------------------------------------------------------------------------

describe("isValidApiKeyFormat", () => {
  test("accepts st_live_ prefix", () => {
    expect(isValidApiKeyFormat("st_live_abc123")).toBe(true);
  });

  test("accepts st_test_ prefix", () => {
    expect(isValidApiKeyFormat("st_test_abc123")).toBe(true);
  });

  test("rejects arbitrary strings", () => {
    expect(isValidApiKeyFormat("sk_live_abc123")).toBe(false);
    expect(isValidApiKeyFormat("random-key")).toBe(false);
    expect(isValidApiKeyFormat("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAlphaLinkState — cloud-first model
// ---------------------------------------------------------------------------

describe("getAlphaLinkState", () => {
  test("returns not_linked when identity is null", () => {
    expect(getAlphaLinkState(null)).toBe("not_linked");
  });

  test("returns not_linked when not enrolled and no cloud_user_id", () => {
    const identity = makeIdentity({ enrolled: false });
    expect(getAlphaLinkState(identity)).toBe("not_linked");
  });

  test("returns linked_not_enrolled when has cloud_user_id but not enrolled", () => {
    const identity = makeIdentity({
      enrolled: false,
      cloud_user_id: "cloud-123",
    });
    expect(getAlphaLinkState(identity)).toBe("linked_not_enrolled");
  });

  test("returns enrolled_no_credential when enrolled but no cloud_user_id", () => {
    const identity = makeIdentity({
      enrolled: true,
      // no cloud_user_id
    });
    expect(getAlphaLinkState(identity)).toBe("enrolled_no_credential");
  });

  test("returns enrolled_no_credential when enrolled with cloud_user_id but no api_key", () => {
    const identity = makeIdentity({
      enrolled: true,
      cloud_user_id: "cloud-123",
      // no api_key
    });
    expect(getAlphaLinkState(identity)).toBe("enrolled_no_credential");
  });

  test("returns enrolled_no_credential when api_key has invalid format", () => {
    const identity = makeIdentity({
      enrolled: true,
      cloud_user_id: "cloud-123",
      api_key: "invalid_key",
    });
    expect(getAlphaLinkState(identity)).toBe("enrolled_no_credential");
  });

  test("returns ready when enrolled with cloud_user_id and valid api_key", () => {
    const identity = makeIdentity({
      enrolled: true,
      cloud_user_id: "cloud-123",
      api_key: "st_live_abc123",
    });
    expect(getAlphaLinkState(identity)).toBe("ready");
  });

  test("returns ready with st_test_ api_key", () => {
    const identity = makeIdentity({
      enrolled: true,
      cloud_user_id: "cloud-123",
      api_key: "st_test_abc123",
    });
    expect(getAlphaLinkState(identity)).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// migrateLocalIdentity
// ---------------------------------------------------------------------------

describe("migrateLocalIdentity", () => {
  test("detects legacy identity needing cloud link", () => {
    const identity = makeIdentity({
      user_id: "local-uuid",
      email: "user@example.com",
      // no cloud_user_id
    });
    const result = migrateLocalIdentity(identity);
    expect(result.needsCloudLink).toBe(true);
    expect(result.identity).toBe(identity);
  });

  test("recognizes already-linked identity", () => {
    const identity = makeIdentity({
      user_id: "local-uuid",
      cloud_user_id: "cloud-abc",
    });
    const result = migrateLocalIdentity(identity);
    expect(result.needsCloudLink).toBe(false);
    expect(result.identity).toBe(identity);
  });
});

// ---------------------------------------------------------------------------
// Config read/write helpers
// ---------------------------------------------------------------------------

describe("readAlphaIdentity / writeAlphaIdentity", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "selftune-alpha-test-"));
    configPath = join(tempDir, "config.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null when config does not exist", () => {
    expect(readAlphaIdentity(configPath)).toBeNull();
  });

  test("returns null when config has no alpha block", () => {
    writeFileSync(configPath, JSON.stringify({ agent_type: "claude_code" }));
    expect(readAlphaIdentity(configPath)).toBeNull();
  });

  test("returns null on invalid JSON", () => {
    writeFileSync(configPath, "not-json");
    expect(readAlphaIdentity(configPath)).toBeNull();
  });

  test("reads back identity after write", () => {
    const credentials = new Map<string, string>();
    const credentialStore: PlatformCredentialStore = {
      set: (account, value) => {
        credentials.set(account, value);
        return { provider: "file", account };
      },
      get: (reference) => credentials.get(reference.account) ?? null,
      delete: (reference) => {
        credentials.delete(reference.account);
      },
    };
    const identity = makeIdentity({
      cloud_user_id: "cloud-xyz",
      cloud_org_id: "org-abc",
      email: "user@example.com",
      display_name: "Test User",
      api_key: "st_live_key123",
    });

    writeAlphaIdentity(configPath, identity, { credentialStore });

    const result = readAlphaIdentity(configPath);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("expected alpha identity to be written");
    }
    expect(result.enrolled).toBe(true);
    expect(result.user_id).toBe("local-uuid-123");
    expect(result.cloud_user_id).toBe("cloud-xyz");
    expect(result.cloud_org_id).toBe("org-abc");
    expect(result.email).toBe("user@example.com");
    expect(result.api_key).toBeUndefined();
    expect(result.credential).toBeDefined();
    expect(credentials.get(result.credential?.account ?? "")).toBe("st_live_key123");
  });

  test("preserves existing config fields when writing alpha", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        agent_type: "claude_code",
        cli_path: "/some/path",
      }),
    );

    writeAlphaIdentity(configPath, makeIdentity());

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agent_type).toBe("claude_code");
    expect(raw.cli_path).toBe("/some/path");
    expect(raw.alpha).toBeDefined();
  });

  test("throws on corrupt existing config", () => {
    writeFileSync(configPath, "not-json");
    expect(() => writeAlphaIdentity(configPath, makeIdentity())).toThrow(/not valid JSON/);
  });

  test("creates parent directories", () => {
    const nestedPath = join(tempDir, "nested", "dir", "config.json");
    writeAlphaIdentity(nestedPath, makeIdentity());
    const result = readAlphaIdentity(nestedPath);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AlphaIdentity interface shape (compile-time checks via usage)
// ---------------------------------------------------------------------------

describe("AlphaIdentity interface", () => {
  test("supports all expected fields", () => {
    const identity: AlphaIdentity = {
      enrolled: true,
      cloud_user_id: "cloud-123",
      cloud_org_id: "org-456",
      email: "user@example.com",
      display_name: "Test User",
      user_id: "local-uuid",
      consent_timestamp: "2026-03-20T00:00:00.000Z",
      api_key: "st_live_abc",
    };

    // All fields are accessible
    expect(identity.enrolled).toBe(true);
    expect(identity.cloud_user_id).toBe("cloud-123");
    expect(identity.cloud_org_id).toBe("org-456");
    expect(identity.email).toBe("user@example.com");
    expect(identity.display_name).toBe("Test User");
    expect(identity.user_id).toBe("local-uuid");
    expect(identity.consent_timestamp).toBe("2026-03-20T00:00:00.000Z");
    expect(identity.api_key).toBe("st_live_abc");
  });

  test("optional fields can be undefined", () => {
    const identity: AlphaIdentity = {
      enrolled: false,
      user_id: "local-uuid",
      consent_timestamp: "2026-03-20T00:00:00.000Z",
    };

    expect(identity.cloud_user_id).toBeUndefined();
    expect(identity.cloud_org_id).toBeUndefined();
    expect(identity.email).toBeUndefined();
    expect(identity.display_name).toBeUndefined();
    expect(identity.api_key).toBeUndefined();
  });
});
