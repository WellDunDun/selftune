import { describe, expect, test } from "bun:test";

import {
  CorrectionStudyServiceError,
  createCorrectionStudyRoutes,
} from "../src/routes/correction-studies.js";

const origin = "http://127.0.0.1:3141";
const allowedOrigins = new Set([origin]);
const capturePath = "/api/v2/correction-studies/explicit-corrections";

function captureRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${capturePath}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body,
  });
}

describe("correction-study routes", () => {
  test("captures an allowed explicit correction without changing its payload", async () => {
    const payload = { trace_id: "trace-1", correction: { intent: "Use the existing skill." } };
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async (input) => {
        expect(input).toEqual(payload);
        return { episode_id: "episode-1", disposition: "captured" };
      },
      lookup: async () => ({}),
    });

    const response = await routes.handle(
      captureRequest(JSON.stringify(payload)),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );

    expect(response?.status).toBe(200);
    if (!response) throw new Error("Expected correction capture response.");
    expect(await response.json()).toEqual({ episode_id: "episode-1", disposition: "captured" });
  });

  test("records a review decision without an apply operation", async () => {
    let applied = false;
    const payload = {
      candidate_id: "candidate-1",
      action: "defer",
      reason: "Needs evaluation.",
      manifest_digest: `sha256:${"a".repeat(64)}`,
    };
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => ({}),
      recordReviewDecision: async (input) => {
        expect(input).toEqual(payload);
        return { recorded: true, applies_skill: applied };
      },
    });
    const response = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/review-decisions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(payload),
      }),
      new URL(`${origin}/api/v2/correction-studies/review-decisions`),
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(applied).toBeFalse();
    expect(await response?.json()).toEqual({ recorded: true, applies_skill: false });
  });

  test("lists a bounded persisted review projection", async () => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => ({}),
      listReviews: async (limit) => ({
        items: [{ candidate_id: "candidate-1", evidence_level: "E2" }],
        limit,
      }),
    });
    const response = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/reviews?limit=7`, {
        headers: { origin },
      }),
      new URL(`${origin}/api/v2/correction-studies/reviews?limit=7`),
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      items: [{ candidate_id: "candidate-1", evidence_level: "E2" }],
      limit: 7,
    });
  });

  test("rejects a wrong origin before capture", async () => {
    let captured = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => {
        captured = true;
        return {};
      },
      lookup: async () => ({}),
    });
    const response = await routes.handle(
      captureRequest("{}", { origin: "https://evil.example" }),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(403);
    expect(captured).toBeFalse();
  });

  test("bounds capture payloads before invoking the domain", async () => {
    let captured = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => {
        captured = true;
        return {};
      },
      lookup: async () => ({}),
    });
    const response = await routes.handle(
      captureRequest(JSON.stringify({ padding: "x".repeat(9_000) })),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: {
        code: "CORRECTION_STUDY_REQUEST_TOO_LARGE",
        message: "Explicit correction capture requests cannot exceed 8 KiB.",
      },
    });
    expect(captured).toBeFalse();
  });

  test("rejects malformed capture JSON", async () => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => ({}),
    });
    const response = await routes.handle(
      captureRequest("{not json"),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(400);
    if (!response) throw new Error("Expected malformed payload response.");
    expect((await response.json()).error.code).toBe("INVALID_CORRECTION_STUDY_REQUEST");
  });

  test("rejects missing and malformed episode ids before lookup", async () => {
    let lookedUp = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => {
        lookedUp = true;
        return {};
      },
    });
    const missing = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/`, { headers: { origin } }),
      new URL(`${origin}/api/v2/correction-studies/`),
      allowedOrigins,
    );
    expect(missing?.status).toBe(400);
    const malformed = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/%E0%A4%A`, { headers: { origin } }),
      new URL(`${origin}/api/v2/correction-studies/%E0%A4%A`),
      allowedOrigins,
    );
    expect(malformed?.status).toBe(400);
    if (!malformed) throw new Error("Expected malformed id response.");
    expect((await malformed.json()).error.code).toBe("INVALID_CORRECTION_EPISODE");
    expect(lookedUp).toBeFalse();
  });

  test("preserves typed service errors", async () => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => {
        throw new CorrectionStudyServiceError(
          "CORRECTION_EPISODE_CONFLICT",
          "The correction episode conflicts with its pinned revision.",
          409,
        );
      },
      lookup: async () => ({}),
    });
    const response = await routes.handle(
      captureRequest("{}"),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(409);
    if (!response) throw new Error("Expected typed capture error response.");
    expect(await response.json()).toEqual({
      error: {
        code: "CORRECTION_EPISODE_CONFLICT",
        message: "The correction episode conflicts with its pinned revision.",
      },
    });
  });

  test("looks up an encoded, bounded correction episode id", async () => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async (episodeId) => {
        expect(episodeId).toBe("episode:one");
        return { episode_id: episodeId, status: "captured" };
      },
    });
    const path = "/api/v2/correction-studies/episode%3Aone";
    const response = await routes.handle(
      new Request(`${origin}${path}`, { headers: { origin } }),
      new URL(`${origin}${path}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    if (!response) throw new Error("Expected correction study lookup response.");
    expect(await response.json()).toEqual({ episode_id: "episode:one", status: "captured" });
  });

  test("preserves a typed not-found lookup error", async () => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => {
        throw new CorrectionStudyServiceError(
          "CORRECTION_EPISODE_NOT_FOUND",
          "The correction episode no longer exists.",
          404,
        );
      },
    });
    const path = "/api/v2/correction-studies/missing-episode";
    const response = await routes.handle(
      new Request(`${origin}${path}`, { headers: { origin } }),
      new URL(`${origin}${path}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(404);
    if (!response) throw new Error("Expected typed lookup error response.");
    expect(await response.json()).toEqual({
      error: {
        code: "CORRECTION_EPISODE_NOT_FOUND",
        message: "The correction episode no longer exists.",
      },
    });
  });

  test("serves bounded, same-origin review-only correction signals", async () => {
    let received: { readonly limit: number; readonly cursor: string | null } | null = null;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => ({}),
      discoverSignals: async (input) => {
        received = input;
        return {
          items: [{ candidate_id: "signal-1", review_status: "review_required" }],
          next_cursor: null,
        };
      },
    });
    const path = "/api/v2/correction-studies/signals?limit=12&cursor=cursor-1";
    const response = await routes.handle(
      new Request(`${origin}${path}`, { headers: { origin } }),
      new URL(`${origin}${path}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(received).toEqual({ limit: 12, cursor: "cursor-1" });
    if (!response) throw new Error("Expected signal discovery response.");
    expect(await response.json()).toEqual({
      items: [{ candidate_id: "signal-1", review_status: "review_required" }],
      next_cursor: null,
    });
  });

  test("rejects cross-origin and unbounded signal discovery queries", async () => {
    let discovered = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => ({}),
      lookup: async () => ({}),
      discoverSignals: async () => {
        discovered = true;
        return { items: [], next_cursor: null };
      },
    });
    const deniedPath = "/api/v2/correction-studies/signals";
    const denied = await routes.handle(
      new Request(`${origin}${deniedPath}`, { headers: { origin: "https://evil.example" } }),
      new URL(`${origin}${deniedPath}`),
      allowedOrigins,
    );
    expect(denied?.status).toBe(403);
    const invalidPath = "/api/v2/correction-studies/signals?limit=129";
    const invalid = await routes.handle(
      new Request(`${origin}${invalidPath}`, { headers: { origin } }),
      new URL(`${origin}${invalidPath}`),
      allowedOrigins,
    );
    expect(invalid?.status).toBe(400);
    expect(discovered).toBeFalse();
  });
});
