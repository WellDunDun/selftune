import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import {
  buildEvent,
  disableTelemetry,
  enableTelemetry,
  getAnonymousId,
  isAnalyticsEnabled,
  resetAnalyticsState,
  trackEvent,
} from "../../../packages/runtime/analytics.js";

const configDir = process.env.SELFTUNE_ANALYTICS_TEST_DIR;
if (!configDir || configDir !== process.env.SELFTUNE_CONFIG_DIR) {
  throw new Error("Run analytics cases through the isolated parent test.");
}
const configPath = join(configDir, "config.json");

// ---------------------------------------------------------------------------
// Environment isolation — prevent real user config from affecting tests
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

beforeEach(() => {
  // Reset all internal caches so each test starts clean
  resetAnalyticsState();
  // Force analytics enabled by clearing all disable signals
  delete process.env.SELFTUNE_NO_ANALYTICS;
  delete process.env.CI;
  rmSync(configPath, { force: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetAnalyticsState();
});

// ---------------------------------------------------------------------------
// Tests: getAnonymousId
// ---------------------------------------------------------------------------

describe("getAnonymousId", () => {
  test("returns a 16-char hex string", () => {
    const id = getAnonymousId();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  test("returns the same value on repeated calls", () => {
    const id1 = getAnonymousId();
    expect(readFileSync(join(configDir, ".anonymous_id"), "utf8")).toBe(id1);
    resetAnalyticsState();
    const id2 = getAnonymousId();
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildEvent
// ---------------------------------------------------------------------------

describe("buildEvent", () => {
  test("includes event name and properties", () => {
    const event = buildEvent("command_run", { command: "status" });
    expect(event.event).toBe("command_run");
    expect(event.properties.command).toBe("status");
  });

  test("includes context with required fields", () => {
    const event = buildEvent("test_event");
    expect(event.context.anonymous_id).toMatch(/^[a-f0-9]{16}$/);
    expect(event.context.os).toBe(platform());
    expect(event.context.os_release).toBe(release());
    expect(event.context.arch).toBe(arch());
    expect(event.context.selftune_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(event.context.node_version).toBe(process.version);
    expect(event.context.agent_type).toBe("unknown");
  });

  test("includes ISO timestamp in sent_at", () => {
    const event = buildEvent("test_event");
    expect(event.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does NOT contain PII fields", () => {
    const event = buildEvent("command_run", { command: "evolve" });
    const json = JSON.stringify(event);

    // Should not contain home directory
    const home = originalEnv.HOME ?? originalEnv.USERPROFILE ?? "";
    if (home) {
      expect(json).not.toContain(home);
    }

    // Should not contain username (raw, not hashed)
    const username = originalEnv.USER ?? originalEnv.USERNAME ?? "";
    if (username && username.length > 3) {
      // Check that username doesn't appear as a plain value
      expect(event.context).not.toHaveProperty("username");
      expect(event.context).not.toHaveProperty("user");
      expect(event.context).not.toHaveProperty("email");
      expect(event.context).not.toHaveProperty("ip");
      expect(event.context).not.toHaveProperty("hostname");
    }

    // Should not contain file paths
    expect(event.context).not.toHaveProperty("cwd");
    expect(event.context).not.toHaveProperty("path");
    expect(event.context).not.toHaveProperty("file_path");
    expect(event.context).not.toHaveProperty("transcript_path");

    // Should not contain session IDs
    expect(event.context).not.toHaveProperty("session_id");
    expect(event.properties).not.toHaveProperty("session_id");
  });

  test("does NOT contain IP address or geolocation", () => {
    const event = buildEvent("test_event");
    expect(event.context).not.toHaveProperty("ip");
    expect(event.context).not.toHaveProperty("ip_address");
    expect(event.context).not.toHaveProperty("geo");
    expect(event.context).not.toHaveProperty("location");
    expect(event.context).not.toHaveProperty("latitude");
    expect(event.context).not.toHaveProperty("longitude");
  });

  test("does NOT contain file paths or repo names", () => {
    const event = buildEvent("command_run", { command: "status" });
    const json = JSON.stringify(event);
    // Should not contain absolute path patterns
    expect(json).not.toMatch(/\/Users\/[^"]+/);
    expect(json).not.toMatch(/\/home\/[^"]+/);
    expect(json).not.toMatch(/C:\\Users\\[^"]+/);
  });
});

// ---------------------------------------------------------------------------
// Tests: isAnalyticsEnabled
// ---------------------------------------------------------------------------

describe("isAnalyticsEnabled", () => {
  test("returns true when no overrides set", () => {
    expect(isAnalyticsEnabled()).toBe(true);
  });

  test("honors an opt-out saved in the isolated config", () => {
    writeFileSync(configPath, JSON.stringify({ analytics_disabled: true }));
    expect(isAnalyticsEnabled()).toBe(false);
  });

  test("persists consent changes without dropping unrelated configuration", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ agent_type: "codex", custom: { keep: [1, false] } }),
    );
    disableTelemetry();
    expect(isAnalyticsEnabled()).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      agent_type: "codex",
      custom: { keep: [1, false] },
      analytics_disabled: true,
    });
    enableTelemetry();
    expect(isAnalyticsEnabled()).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      agent_type: "codex",
      custom: { keep: [1, false] },
      analytics_disabled: false,
    });
  });

  test("refuses to overwrite malformed configuration when changing consent", () => {
    for (const contents of ["{", "null", "[]"]) {
      writeFileSync(configPath, contents);
      resetAnalyticsState();
      expect(isAnalyticsEnabled()).toBe(false);
      expect(() => disableTelemetry()).toThrow();
      expect(readFileSync(configPath, "utf8")).toBe(contents);
    }
  });

  test("returns false when SELFTUNE_NO_ANALYTICS=1", () => {
    process.env.SELFTUNE_NO_ANALYTICS = "1";
    expect(isAnalyticsEnabled()).toBe(false);
  });

  test("returns false when SELFTUNE_NO_ANALYTICS=true", () => {
    process.env.SELFTUNE_NO_ANALYTICS = "true";
    expect(isAnalyticsEnabled()).toBe(false);
  });

  test("does not disable when SELFTUNE_NO_ANALYTICS=0", () => {
    process.env.SELFTUNE_NO_ANALYTICS = "0";
    // Should not be disabled by the env var (config dir is non-existent)
    expect(isAnalyticsEnabled()).toBe(true);
  });

  test("returns false when CI=true", () => {
    process.env.CI = "true";
    expect(isAnalyticsEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: trackEvent (fire-and-forget behavior)
// ---------------------------------------------------------------------------

describe("trackEvent", () => {
  test("calls fetch with correct payload shape", async () => {
    const mockFetch = mock(async (_url: string, _init: RequestInit) => new Response("ok"));

    trackEvent(
      "test_command",
      { command: "status" },
      {
        endpoint: "https://test.example.com/events",
        fetchFn: mockFetch,
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    const request = new Request(url, init);
    expect(request.url).toBe("https://test.example.com/events");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toMatchObject({
      event: "test_command",
      properties: { command: "status" },
      context: { anonymous_id: expect.stringMatching(/^[a-f0-9]{16}$/) },
    });
  });

  test("does not call fetch when analytics disabled via env", () => {
    process.env.SELFTUNE_NO_ANALYTICS = "1";

    const mockFetch = mock(async () => new Response("ok", { status: 200 }));

    trackEvent(
      "test_command",
      { command: "status" },
      {
        endpoint: "https://test.example.com/events",
        fetchFn: mockFetch,
      },
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("does not throw when fetch fails (fire-and-forget)", async () => {
    const failingFetch = mock(async () => {
      throw new Error("Network error");
    });

    // This should NOT throw
    expect(() => {
      trackEvent(
        "test_command",
        {},
        {
          endpoint: "https://unreachable.test/events",
          fetchFn: failingFetch,
        },
      );
    }).not.toThrow();
    await Promise.resolve();
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  test("does not throw when fetch throws synchronously", () => {
    const syncThrowFetch = mock(() => {
      throw new Error("Sync failure");
    });

    expect(() => {
      trackEvent(
        "test_command",
        {},
        {
          endpoint: "https://sync-throw.test/events",
          fetchFn: syncThrowFetch,
        },
      );
    }).not.toThrow();
  });

  test("trackEvent returns immediately (non-blocking)", async () => {
    const pending = Promise.withResolvers<Response>();
    const slowFetch = mock(() => pending.promise);

    trackEvent(
      "test_command",
      {},
      {
        endpoint: "https://slow.test/events",
        fetchFn: slowFetch,
      },
    );

    expect(slowFetch).toHaveBeenCalledTimes(1);
    pending.resolve(new Response("ok"));
    await pending.promise;
  });
});
