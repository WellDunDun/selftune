/* oxlint-disable no-await-in-loop -- SSE reads and lifecycle mutations are ordered */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InsightsResponse } from "../../packages/runtime/dashboard-contract.js";
import {
  type DashboardUpdateEvent,
  insightDecisionResources,
} from "../../packages/runtime/dashboard-reactivity.js";

let startDashboardServer: typeof import("@selftune/local/dashboard-server").startDashboardServer;
let configRoot: string;
let spaDirectory: string;
let originalConfigRoot: string | undefined;

const insightsFixture: InsightsResponse = {
  snapshot: {
    snapshotId: "snapshot",
    evidenceVersion: 1,
    generatedAt: "2026-07-16T00:00:00.000Z",
    candidates: [
      {
        candidateId: "candidate",
        kind: "coverage_gap",
        title: "Research workflow",
        summary: "Create a reusable workflow",
        skillNames: ["research"],
        evidence: {
          sessionCount: 3,
          projectCount: 2,
          successRate: 1,
          heldOutSessionCount: 1,
          exploratory: false,
        },
        supportingSessionIds: ["one", "two"],
        heldOutSessionIds: ["three"],
        generatedAt: "2026-07-16T00:00:00.000Z",
        status: "pending",
        decision: null,
        decisionHistory: [],
      },
    ],
  },
  portfolio_reviews: [],
  counts: {
    pending: 1,
    accepted: 0,
    drafted: 0,
    snoozed: 0,
    completed: 0,
    stale_reviews: 0,
    routing_reviews: 0,
  },
};

async function readUpdateEvents(
  response: Response,
  expectedCount: number,
): Promise<DashboardUpdateEvent[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE response body");
  const decoder = new TextDecoder();
  const updates: DashboardUpdateEvent[] = [];
  let buffer = "";
  while (updates.length < expectedCount) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      if (!lines.includes("event: update")) continue;
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (data) updates.push(JSON.parse(data) as DashboardUpdateEvent);
    }
  }
  await reader.cancel();
  return updates;
}

beforeAll(async () => {
  originalConfigRoot = process.env.SELFTUNE_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "selftune-insights-reactivity-"));
  process.env.SELFTUNE_CONFIG_DIR = configRoot;
  spaDirectory = mkdtempSync(join(tmpdir(), "selftune-insights-spa-"));
  mkdirSync(join(spaDirectory, "assets"), { recursive: true });
  writeFileSync(join(spaDirectory, "index.html"), '<!doctype html><div id="root"></div>');
  ({ startDashboardServer } = await import("@selftune/local/dashboard-server"));
});

afterAll(() => {
  if (originalConfigRoot === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigRoot;
  rmSync(configRoot, { force: true, recursive: true });
  rmSync(spaDirectory, { force: true, recursive: true });
});

describe("Insights live semantic reactivity", () => {
  it("broadcasts each successful lifecycle declaration once and emits nothing for a failed attempt", async () => {
    let reviewAttempts = 0;
    const server = await startDashboardServer({
      port: 0,
      host: "127.0.0.1",
      spaDir: spaDirectory,
      openBrowser: false,
      authToken: "AUTH_TOKEN_PLACEHOLDER",
      insightsLoader: () => insightsFixture,
      insightReviewer: () => {
        reviewAttempts += 1;
        if (reviewAttempts === 1) throw new Error("Decision was not persisted");
        return insightsFixture.snapshot.candidates[0];
      },
      insightDrafter: () => ({ draft: { skill_dir: "/tmp/draft" } }),
      insightEvaluator: () => ({ recommended: true, blockers: [] }),
      insightReleaser: () => ({ package_path: "/tmp/released" }),
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer AUTH_TOKEN_PLACEHOLDER",
        "Content-Type": "application/json",
        Origin: origin,
      };
      const eventsResponse = await fetch(`${origin}/api/v2/events`, {
        headers: { Authorization: headers.Authorization },
      });
      const updatesPromise = readUpdateEvents(eventsResponse, 4);

      const reviewBody = JSON.stringify({
        candidate_id: "candidate",
        action: "accept",
        reason: "Evidence is sufficient",
      });
      const failed = await fetch(`${origin}/api/v2/insights/review`, {
        method: "POST",
        headers,
        body: reviewBody,
      });
      expect(failed.status).toBe(500);

      const retried = await fetch(`${origin}/api/v2/insights/review`, {
        method: "POST",
        headers,
        body: reviewBody,
      });
      expect(retried.status).toBe(200);

      for (const action of ["draft", "evaluate", "release"] as const) {
        const response = await fetch(`${origin}/api/v2/insights/${action}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ candidate_id: "candidate" }),
        });
        expect(response.status).toBe(200);
      }

      const updates = await updatesPromise;
      expect(reviewAttempts).toBe(2);
      expect(updates.map((update) => update.resources)).toEqual([
        insightDecisionResources.review,
        insightDecisionResources.draft,
        insightDecisionResources.evaluate,
        insightDecisionResources.release,
      ]);
    } finally {
      server.stop();
    }
  });
});
