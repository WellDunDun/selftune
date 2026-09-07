/**
 * Tests for the device-code authentication client.
 *
 * Injects the transport to test requestDeviceCode, pollDeviceCode, and getBaseUrl
 * without making real network calls.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  buildVerificationUrl,
  getBaseUrl,
  pollDeviceCode,
  requestDeviceCode,
} from "../../packages/runtime/auth/device-code.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };
type DeviceCodeTransport = NonNullable<Parameters<typeof requestDeviceCode>[1]>;
const validGrant = {
  device_code: "dc_abc123",
  user_code: "ABCD-1234",
  verification_url: "https://test.local/verify",
  expires_in: 300,
  interval: 5,
};
const validApproval = {
  status: "approved",
  api_key: "st_test_example",
  cloud_user_id: "cloud-user",
  org_id: "workspace",
};

// ---------------------------------------------------------------------------
// getBaseUrl
// ---------------------------------------------------------------------------

describe("getBaseUrl", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("strips /push from SELFTUNE_ALPHA_ENDPOINT", () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://api.example.com/api/v1/push";
    expect(getBaseUrl()).toBe("https://api.example.com/api/v1");
  });

  it("returns the endpoint unchanged when it does not end with /push", () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://api.example.com/api/v1";
    expect(getBaseUrl()).toBe("https://api.example.com/api/v1");
  });

  it("uses default endpoint when env var is not set", () => {
    delete process.env.SELFTUNE_ALPHA_ENDPOINT;
    expect(getBaseUrl()).toBe("https://cloud.selftune.dev/api/v1");
  });
});

describe("buildVerificationUrl", () => {
  it("appends the device code as a query parameter", () => {
    expect(buildVerificationUrl("https://app.selftune.dev/auth/device", "ABCD-1234")).toBe(
      "https://app.selftune.dev/auth/device?code=ABCD-1234",
    );
  });

  it("preserves existing query parameters", () => {
    expect(buildVerificationUrl("https://app.selftune.dev/auth/device?foo=bar", "ABCD-1234")).toBe(
      "https://app.selftune.dev/auth/device?foo=bar&code=ABCD-1234",
    );
  });
});

// ---------------------------------------------------------------------------
// requestDeviceCode
// ---------------------------------------------------------------------------

describe("requestDeviceCode", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a DeviceCodeGrant on success", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    const grant = {
      device_code: "dc_abc123",
      user_code: "ABCD-1234",
      verification_url: "https://test.local/verify",
      expires_in: 300,
      interval: 5,
    };

    const request: DeviceCodeTransport = async (url, init) => {
      expect(url).toBe("https://test.local/api/v1/device-code");
      expect(init?.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ client_id: "selftune-cli", scope: "push read" }));
      return new Response(JSON.stringify(grant), { status: 200 });
    };

    const result = await requestDeviceCode("selftune-cli", request);
    expect(result).toEqual(grant);
  });

  it("throws on non-200 response", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    const request: DeviceCodeTransport = async () => {
      return new Response("Server Error", { status: 500, statusText: "Internal Server Error" });
    };

    await expect(requestDeviceCode("selftune-cli", request)).rejects.toThrow(
      "Device code request failed: 500",
    );
  });

  it.each([
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...validGrant, device_code: "" }),
    JSON.stringify({ ...validGrant, user_code: 42 }),
    JSON.stringify({ ...validGrant, verification_url: null }),
    JSON.stringify({ ...validGrant, expires_in: "300" }),
    JSON.stringify({ ...validGrant, interval: 0 }),
    JSON.stringify({ ...validGrant, expires_in: -1 }),
  ])("rejects an invalid grant response %s", async (saved) => {
    const request: DeviceCodeTransport = async () => new Response(saved, { status: 200 });
    await expect(requestDeviceCode("selftune-cli", request)).rejects.toThrow(
      "Device code request returned an invalid response.",
    );
  });
});

// ---------------------------------------------------------------------------
// pollDeviceCode
// ---------------------------------------------------------------------------

describe("pollDeviceCode", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves on approved after pending polls", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    let callCount = 0;
    const request: DeviceCodeTransport = async (url, init) => {
      expect(url).toBe("https://test.local/api/v1/device-code/poll");
      expect(init.body).toBe(
        JSON.stringify({ device_code: "dc_test", client_id: "selftune-desktop-installation" }),
      );
      callCount++;
      if (callCount < 3) {
        return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: "approved",
          api_key: "st_live_newkey123",
          cloud_user_id: "cloud_user_abc",
          org_id: "org_xyz",
        }),
        { status: 200 },
      );
    };

    // Use very short interval (0.01s) and long expiry for test speed
    const result = await pollDeviceCode(
      "dc_test",
      0.01,
      30,
      "selftune-desktop-installation",
      request,
    );
    expect(result.api_key).toBe("st_live_newkey123");
    expect(result.cloud_user_id).toBe("cloud_user_abc");
    expect(result.org_id).toBe("org_xyz");
    expect(callCount).toBe(3);
  });

  it("throws on expired status (HTTP 410 with JSON body)", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    const request: DeviceCodeTransport = async () => {
      return new Response(JSON.stringify({ status: "expired" }), { status: 410 });
    };

    await expect(pollDeviceCode("dc_test", 0.01, 30, "selftune-cli", request)).rejects.toThrow(
      "Device code expired. Please retry.",
    );
  });

  it("throws on denied status (HTTP 403 with JSON body)", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    const request: DeviceCodeTransport = async () => {
      return new Response(JSON.stringify({ status: "denied" }), { status: 403 });
    };

    await expect(pollDeviceCode("dc_test", 0.01, 30, "selftune-cli", request)).rejects.toThrow(
      "Device code denied by user.",
    );
  });

  it("throws on poll HTTP failure with non-JSON body", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    const request: DeviceCodeTransport = async () => {
      return new Response("Bad", { status: 503 });
    };

    await expect(pollDeviceCode("dc_test", 0.01, 30, "selftune-cli", request)).rejects.toThrow(
      "Poll failed: 503",
    );
  });

  it("times out when deadline passes without approval", async () => {
    process.env.SELFTUNE_ALPHA_ENDPOINT = "https://test.local/api/v1/push";

    const request: DeviceCodeTransport = async () => {
      return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
    };

    // expiresIn=0 means deadline is already passed before first poll attempt
    // But the first poll still runs because we sleep first then check deadline
    // Use a tiny expiry so it times out quickly
    await expect(pollDeviceCode("dc_test", 0.01, 0.01, "selftune-cli", request)).rejects.toThrow(
      /timed out|expired/,
    );
  });

  it.each([
    { status: "approved" },
    { ...validApproval, api_key: "" },
    { ...validApproval, api_key: 42 },
    { ...validApproval, cloud_user_id: null },
    { ...validApproval, org_id: "" },
  ])("rejects malformed approval credentials %j", async (approval) => {
    const request: DeviceCodeTransport = async () =>
      new Response(JSON.stringify(approval), { status: 200 });
    await expect(pollDeviceCode("dc_test", 0.001, 1, "selftune-cli", request)).rejects.toThrow(
      "Device code approval returned invalid credentials.",
    );
  });

  it("does not accept credentials from an unsuccessful HTTP approval", async () => {
    const request: DeviceCodeTransport = async () =>
      new Response(JSON.stringify(validApproval), { status: 403 });
    await expect(pollDeviceCode("dc_test", 0.001, 1, "selftune-cli", request)).rejects.toThrow(
      "Poll failed: 403",
    );
  });

  it("keeps temporary non-JSON successful polls pending until a valid approval", async () => {
    let calls = 0;
    const request: DeviceCodeTransport = async () => {
      calls += 1;
      return new Response(
        calls === 1 ? "not-json" : JSON.stringify({ ...validApproval, extra: "not a credential" }),
        { status: 200 },
      );
    };
    const result = await pollDeviceCode("dc_test", 0.001, 1, "selftune-cli", request);
    expect(result).toEqual({
      api_key: validApproval.api_key,
      cloud_user_id: validApproval.cloud_user_id,
      org_id: validApproval.org_id,
    });
    expect(calls).toBe(2);
  });
});
