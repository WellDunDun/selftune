import { describe, expect, test } from "bun:test";

import {
  CorrectionStudyServiceError,
  createCorrectionStudyRoutes,
} from "../src/routes/correction-studies.js";
import { correctionSignal, studyRequest, studyResponse } from "./correction-route-fixtures.js";
import { projectCorrectionReview } from "../src/correction-review-projection.js";

const origin = "http://127.0.0.1:3141";
const allowedOrigins = new Set([origin]);
const capturePath = "/api/v2/correction-studies/explicit-corrections";
const reviewPath = "/api/v2/correction-studies/review-decisions";
const review = {
  candidate_id: "candidate-1",
  action: "defer",
  reason: "Needs evaluation.",
  manifest_digest: `sha256:${"a".repeat(64)}`,
};

function captureRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${capturePath}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body,
  });
}

describe("correction-study routes", () => {
  test.each([
    null,
    {},
    { ...studyRequest, episode: { ...studyRequest.episode, pre_edit_revision: "invalid" } },
    { ...studyRequest, verifier: { ...studyRequest.verifier, kind: "untrusted" } },
    { ...studyRequest, trials: [{ pair_id: "pair-1", pre_edit: "yes", post_edit: "pass" }] },
  ])("rejects malformed study contracts before capture: %j", async (payload) => {
    let captured = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => {
        captured = true;
        return studyResponse;
      },
      lookup: async () => studyResponse,
    });
    const response = await routes.handle(
      captureRequest(JSON.stringify(payload)),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: "INVALID_CORRECTION_STUDY_REQUEST" },
    });
    expect(captured).toBeFalse();
  });

  test.each(
    [
      null,
      [],
      {},
      { ...review, candidate_id: "" },
      { ...review, candidate_id: "../candidate" },
      { ...review, candidate_id: "x".repeat(129) },
      { ...review, action: "edit" },
      { ...review, action: true },
      { ...review, reason: "   " },
      { ...review, reason: "x".repeat(513) },
      { ...review, manifest_digest: "invalid" },
      { ...review, manifest_digest: null },
    ].map((payload) => ({ payload })),
  )("rejects malformed review input before invoking persistence: %j", async ({ payload }) => {
    let recorded = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      recordReviewDecision: async () => {
        recorded = true;
        return { recorded: true, action: "defer", applies_skill: false };
      },
    });
    const response = await routes.handle(
      new Request(`${origin}${reviewPath}`, {
        method: "POST",
        headers: { origin },
        body: JSON.stringify(payload),
      }),
      new URL(`${origin}${reviewPath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: "INVALID_CORRECTION_REVIEW" } });
    expect(recorded).toBeFalse();
  });

  test.each([
    { body: "{broken", status: 400, code: "INVALID_CORRECTION_REVIEW_REQUEST" },
    {
      body: JSON.stringify({ ...review, reason: "é".repeat(4_096) }),
      status: 413,
      code: "CORRECTION_REVIEW_REQUEST_TOO_LARGE",
    },
  ])(
    "retains JSON and byte-limit failures before review persistence: %j",
    async ({ body, status, code }) => {
      let recorded = false;
      const routes = createCorrectionStudyRoutes({
        captureExplicitCorrection: async () => studyResponse,
        lookup: async () => studyResponse,
        recordReviewDecision: async () => {
          recorded = true;
          return { recorded: true, action: "defer", applies_skill: false };
        },
      });
      const response = await routes.handle(
        new Request(`${origin}${reviewPath}`, {
          method: "POST",
          headers: { origin },
          body,
        }),
        new URL(`${origin}${reviewPath}`),
        allowedOrigins,
      );
      expect(response?.status).toBe(status);
      expect(await response?.json()).toMatchObject({ error: { code } });
      expect(recorded).toBeFalse();
    },
  );

  test("rejects an invalid review-list query without calling the service", async () => {
    let listed = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      listReviews: async () => {
        listed = true;
        return { items: [] };
      },
    });
    const url = new URL(`${origin}/api/v2/correction-studies/reviews?limit=129`);
    const response = await routes.handle(new Request(url), url, allowedOrigins);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: "INVALID_CORRECTION_REVIEW_QUERY" },
    });
    expect(listed).toBeFalse();
  });

  test.each([
    {
      failure: new Error("Private database path"),
      status: 503,
      code: "CORRECTION_REVIEW_UNAVAILABLE",
      message: "Correction review is unavailable.",
    },
    {
      failure: new CorrectionStudyServiceError("REVIEW_CONFLICT", "Review conflict", 409),
      status: 409,
      code: "REVIEW_CONFLICT",
      message: "Review conflict",
    },
  ])("returns bounded review-list failures: %j", async ({ failure, status, code, message }) => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      listReviews: async () => {
        throw failure;
      },
    });
    const url = new URL(`${origin}/api/v2/correction-studies/reviews`);
    const response = await routes.handle(new Request(url), url, allowedOrigins);
    expect(response?.status).toBe(status);
    expect(await response?.json()).toEqual({ error: { code, message } });
  });

  test("captures an allowed explicit correction without changing its payload", async () => {
    const payload = studyRequest;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async (input) => {
        expect(input).toEqual(payload);
        return studyResponse;
      },
      lookup: async () => studyResponse,
    });

    const response = await routes.handle(
      captureRequest(JSON.stringify(payload)),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );

    expect(response?.status).toBe(200);
    if (!response) throw new Error("Expected correction capture response.");
    expect(await response.json()).toEqual(studyResponse);
  });

  test("records a review decision without an apply operation", async () => {
    const payload = {
      candidate_id: "candidate-1",
      action: "defer",
      reason: "Needs evaluation.",
      manifest_digest: `sha256:${"a".repeat(64)}`,
    };
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      recordReviewDecision: async (input) => {
        expect(input).toEqual(payload);
        return { recorded: true, action: input.action, applies_skill: false };
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
    expect(await response?.json()).toEqual({
      recorded: true,
      action: "defer",
      applies_skill: false,
    });
  });

  test("rejects a review decision mutation without Origin before recording it", async () => {
    let recorded = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      recordReviewDecision: async () => {
        recorded = true;
        return { recorded: true, action: "defer", applies_skill: false };
      },
    });
    const path = "/api/v2/correction-studies/review-decisions";
    const response = await routes.handle(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer local-dashboard-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ candidate_id: "candidate-1", action: "defer" }),
      }),
      new URL(`${origin}${path}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(403);
    expect(recorded).toBeFalse();
  });

  test("lists a bounded persisted review projection for a same-origin dashboard GET without Origin", async () => {
    const reviewItem = projectCorrectionReview({
      candidate_id: "candidate-1",
      evidence_level: "E2",
    });
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      listReviews: async (limit) => {
        expect(limit).toBe(7);
        return { items: [reviewItem] };
      },
    });
    const response = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/reviews?limit=7`, {
        headers: { authorization: "Bearer local-dashboard-session" },
      }),
      new URL(`${origin}/api/v2/correction-studies/reviews?limit=7`),
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      items: [reviewItem],
    });
  });

  test("rejects a review-list GET with an untrusted Origin", async () => {
    let listed = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      listReviews: async () => {
        listed = true;
        return { items: [] };
      },
    });
    const path = "/api/v2/correction-studies/reviews";
    const response = await routes.handle(
      new Request(`${origin}${path}`, { headers: { origin: "https://evil.example" } }),
      new URL(`${origin}${path}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(403);
    expect(listed).toBeFalse();
  });

  test("rejects an explicit-correction mutation without Origin before capture", async () => {
    let captured = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => {
        captured = true;
        return studyResponse;
      },
      lookup: async () => studyResponse,
    });
    const response = await routes.handle(
      new Request(`${origin}${capturePath}`, {
        method: "POST",
        headers: {
          authorization: "Bearer local-dashboard-session",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      new URL(`${origin}${capturePath}`),
      allowedOrigins,
    );
    expect(response?.status).toBe(403);
    expect(captured).toBeFalse();
  });

  test("rejects a wrong origin before capture", async () => {
    let captured = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => {
        captured = true;
        return studyResponse;
      },
      lookup: async () => studyResponse,
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
        return studyResponse;
      },
      lookup: async () => studyResponse,
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
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
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
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => {
        lookedUp = true;
        return studyResponse;
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
      lookup: async () => studyResponse,
    });
    const response = await routes.handle(
      captureRequest(JSON.stringify(studyRequest)),
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
      captureExplicitCorrection: async () => studyResponse,
      lookup: async (episodeId) => {
        expect(episodeId).toBe("episode:one");
        return { ...studyResponse, episode_id: episodeId };
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
    expect(await response.json()).toEqual({ ...studyResponse, episode_id: "episode:one" });
  });

  test("preserves a typed not-found lookup error", async () => {
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
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
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      discoverSignals: async (input) => {
        received = input;
        return {
          items: [correctionSignal],
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
      items: [correctionSignal],
      next_cursor: null,
    });
  });

  test("rejects cross-origin and unbounded signal discovery queries", async () => {
    let discovered = false;
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
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
