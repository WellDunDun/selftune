import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startDashboardServer } from "@selftune/local/dashboard-server";

const TOKEN = "dashboard-token-with-at-least-thirty-two-characters";
let handle: Awaited<ReturnType<typeof startDashboardServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = await startDashboardServer({
    host: "127.0.0.1",
    port: 0,
    openBrowser: false,
    authToken: TOKEN,
    authCookie: true,
    allowedOrigins: ["https://selftune.example.com"],
    overviewLoader: () => {
      throw new TypeError("Overview should not be loaded in this test.");
    },
    skillReportLoader: () => {
      throw new TypeError("Skill report should not be loaded in this test.");
    },
    externalRequestHandler: (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/v1/remote-library")) return null;
      return new Response(null, {
        status: 204,
        headers: { "X-SelfTune-Extension": request.method },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => handle.stop());

describe("self-hosted dashboard authentication", () => {
  test("uses a derived browser session and keeps API requests authenticated", async () => {
    const redirect = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");

    const loginPage = await fetch(`${baseUrl}/login`);
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("Enter the access token");
    expect(loginPage.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const rejected = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "incorrect" }),
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(accepted.status).toBe(204);
    const cookie = accepted.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain(encodeURIComponent(TOKEN));

    const health = await fetch(`${baseUrl}/api/health`, {
      headers: { Cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(health.status).toBe(200);

    const unauthenticatedApi = await fetch(`${baseUrl}/api/health`);
    expect(unauthenticatedApi.status).toBe(401);

    const deniedOrigin = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(deniedOrigin.status).toBe(403);

    const logout = await fetch(`${baseUrl}/api/auth/session`, {
      method: "DELETE",
      headers: { Origin: baseUrl },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("delegates extension preflights before the dashboard CORS handler", async () => {
    const response = await fetch(`${baseUrl}/api/v1/remote-library/objects/hash`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-selftune-extension")).toBe("OPTIONS");
  });

  test("isolates throttling by credential behind a shared proxy address", async () => {
    const rejectedStatuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "repeated-invalid-proxy-credential" }),
      });
      rejectedStatuses.push(response.status);
    }
    expect(rejectedStatuses).toEqual([401, 401, 401, 401, 401]);

    const throttled = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "repeated-invalid-proxy-credential" }),
    });
    expect(throttled.status).toBe(429);

    const isolatedCredential = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "different-invalid-proxy-credential" }),
    });
    expect(isolatedCredential.status).toBe(401);

    const accepted = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("set-cookie")).not.toContain("; Secure");
  });
});
