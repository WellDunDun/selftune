import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type AnalyticsEvent,
  buildEvent,
  getAnonymousId,
  isAnalyticsEnabled,
  resetAnalyticsState,
  trackEvent,
} from "../../cli/selftune/analytics.js";

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
    expect(typeof event.context.os).toBe("string");
    expect(typeof event.context.os_release).toBe("string");
    expect(typeof event.context.arch).toBe("string");
    expect(event.context.selftune_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof event.context.node_version).toBe("string");
    expect(typeof event.context.agent_type).toBe("string");
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
    // beforeEach already clears SELFTUNE_NO_ANALYTICS and CI,
    // and sets config dir to non-existent path
    expect(isAnalyticsEnabled()).toBe(true);
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
    let capturedBody: AnalyticsEvent | null = null;
    let capturedUrl = "";

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      if (init?.body) {
        capturedBody = JSON.parse(String(init.body)) as AnalyticsEvent;
      }
      return new Response("ok", { status: 200 });
    });

    trackEvent(
      "test_command",
      { command: "status" },
      {
        endpoint: "https://test.example.com/events",
        fetchFn: mockFetch as unknown as typeof fetch,
      },
    );

    // Wait for the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalled();
    expect(capturedUrl).toBe("https://test.example.com/events");
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as AnalyticsEvent;
    expect(body.event).toBe("test_command");
    expect(body.properties.command).toBe("status");
    expect(body.context.anonymous_id).toMatch(/^[a-f0-9]{16}$/);
  });

  test("does not call fetch when analytics disabled via env", async () => {
    process.env.SELFTUNE_NO_ANALYTICS = "1";

    const mockFetch = mock(async () => new Response("ok", { status: 200 }));

    trackEvent(
      "test_command",
      { command: "status" },
      {
        endpoint: "https://test.example.com/events",
        fetchFn: mockFetch as unknown as typeof fetch,
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("does not throw when fetch fails (fire-and-forget)", () => {
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
          fetchFn: failingFetch as unknown as typeof fetch,
        },
      );
    }).not.toThrow();
  });

  test("trackEvent returns immediately (non-blocking)", () => {
    let fetchResolved = false;
    const slowFetch = mock(async () => {
      await new Promise((r) => setTimeout(r, 500));
      fetchResolved = true;
      return new Response("ok", { status: 200 });
    });

    const start = Date.now();
    trackEvent(
      "test_command",
      {},
      {
        endpoint: "https://slow.test/events",
        fetchFn: slowFetch as unknown as typeof fetch,
      },
    );
    const elapsed = Date.now() - start;

    // trackEvent should return in <50ms even though fetch takes 500ms
    expect(elapsed).toBeLessThan(50);
    expect(fetchResolved).toBe(false);
  });
});
