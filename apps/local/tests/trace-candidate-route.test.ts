import { describe, expect, test } from "bun:test";

import { createTraceCandidateRoutes } from "../src/routes/trace-candidates.js";

const origin = "http://127.0.0.1:3141";
const allowedOrigins = new Set([origin]);

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/v2/trace-candidates/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body,
  });
}

describe("trace candidate preparation route", () => {
  test("requires the dashboard origin before invoking preparation", async () => {
    let called = false;
    const routes = createTraceCandidateRoutes({
      prepare: async () => {
        called = true;
        return {};
      },
    });
    const response = await routes.handle(
      new Request(`${origin}/api/v2/trace-candidates/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({ pattern_id: "pattern" }),
      }),
      new URL(`${origin}/api/v2/trace-candidates/prepare`),
      allowedOrigins,
    );
    expect(response?.status).toBe(403);
    expect(called).toBe(false);
  });

  test("bounds streamed request bodies at 8 KiB", async () => {
    const routes = createTraceCandidateRoutes({ prepare: async () => ({}) });
    const response = await routes.handle(
      request(JSON.stringify({ pattern_id: "x", padding: "a".repeat(8 * 1024) })),
      new URL(`${origin}/api/v2/trace-candidates/prepare`),
      allowedOrigins,
    );
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: {
        code: "TRACE_CANDIDATE_TOO_LARGE",
        message: "Trace candidate preparation requests cannot exceed 8 KiB.",
      },
    });
  });

  test("fails closed when historical evaluation has no managed replay harness", async () => {
    const routes = createTraceCandidateRoutes({ prepare: async () => ({}) });
    const url = new URL(`${origin}/api/v2/trace-candidates/evaluate`);
    const response = await routes.handle(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ pattern_id: "execution-pattern-test" }),
      }),
      url,
      allowedOrigins,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: {
        code: "HISTORICAL_REPLAY_UNAVAILABLE",
        message: "No managed replay harness is registered for historical evaluation.",
      },
    });
  });

  test("delegates historical evaluation to the registered product service", async () => {
    const routes = createTraceCandidateRoutes({
      prepare: async () => ({}),
      evaluate: async (input) => ({ status: "review_ready", input }),
    });
    const url = new URL(`${origin}/api/v2/trace-candidates/evaluate`);
    const response = await routes.handle(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ pattern_id: "execution-pattern-test" }),
      }),
      url,
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      status: "review_ready",
      input: { pattern_id: "execution-pattern-test" },
    });
  });
});
