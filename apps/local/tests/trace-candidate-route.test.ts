import { describe, expect, test } from "bun:test";

import { createTraceCandidateRoutes } from "../src/routes/trace-candidates.js";
import type { TraceCandidateReview } from "../src/trace-candidate-contract.js";
import type {
  HistoricalSkillImprovementRequest,
  HistoricalSkillImprovementResponse,
} from "../src/historical-skill-improvement-service.js";
import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";

const origin = "http://127.0.0.1:3141";
const allowedOrigins = new Set([origin]);
const prepared = {
  draft_id: null,
  pattern_id: "pattern",
  cohort_fingerprint: null,
  target_revision: null,
  readiness: "not_ready",
  failure_reason: "Insufficient evidence",
  evidence: { cohort_entries: 0, resolved_entries: 0 },
  candidate: null,
} satisfies TraceCandidateReview;
const evaluated = {
  pattern_id: "execution-pattern-test",
  draft_id: null,
  candidate_id: null,
  evaluation_id: null,
  status: "not_ready",
  evidence_level: "E0",
  reason: "Insufficient evidence",
  cohort_fingerprint: null,
  cases: { calibration: 0, selection: 0, audit_holdout: 0, active_regressions: 0 },
  applies_change: false,
} satisfies HistoricalSkillImprovementResponse;
const evaluationRequest = {
  pattern_id: "execution-pattern-test",
  qualified_verifier: qualifyVerifierInstrument({
    instrument: {
      verifier_id: "portal-check",
      version: "v1",
      kind: "deterministic",
      success_contract: "Portal confirms upload",
      check_description: "Checks portal confirmation",
    },
    evidence: (["known_failure", "known_good", "boundary", "adversarial"] as const).map(
      (label) => ({
        evidence_id: `control-${label}`,
        label,
        expected_decision: label === "known_failure" ? "reject" : "accept",
        observed_decision: label === "known_failure" ? "reject" : "accept",
        partition: "verifier_calibration",
        candidate_strategy_reference: null,
      }),
    ),
  }),
  runtime: { harness: "codex", model: "gpt-5", config_digest: `sha256:${"a".repeat(64)}` },
  required_scored_repetitions: 3,
  max_attempts_per_arm: 3,
  controls: {
    entitlement_proactive_managed: true,
    proactive_generation_enabled: true,
    managed_execution_enabled: true,
    kill_switch_enabled: false,
    active_runs: 0,
    max_concurrency: 1,
    budget_remaining_usd: 1,
    estimated_cost_usd: 0.1,
  },
  recorded_at: "2026-09-06T10:00:00Z",
} satisfies HistoricalSkillImprovementRequest;

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
        return prepared;
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
    const routes = createTraceCandidateRoutes({ prepare: async () => prepared });
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
    const routes = createTraceCandidateRoutes({ prepare: async () => prepared });
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
      prepare: async () => prepared,
      evaluate: async (input) => {
        expect(input).toEqual(evaluationRequest);
        return evaluated;
      },
    });
    const url = new URL(`${origin}/api/v2/trace-candidates/evaluate`);
    const response = await routes.handle(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(evaluationRequest),
      }),
      url,
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(evaluated);
  });

  test("forwards a validated preparation request and complete review", async () => {
    const input = { pattern_id: "pattern", candidate_count: 3, calibration_repetitions: 2 };
    const routes = createTraceCandidateRoutes({
      prepare: async (received) => {
        expect(received).toEqual(input);
        return prepared;
      },
    });
    const response = await routes.handle(
      request(JSON.stringify(input)),
      new URL(`${origin}/api/v2/trace-candidates/prepare`),
      allowedOrigins,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(prepared);
  });

  test.each([
    "{broken",
    "null",
    "{}",
    JSON.stringify({ pattern_id: "" }),
    JSON.stringify({ pattern_id: "pattern", candidate_count: 9 }),
    JSON.stringify({ pattern_id: "pattern", calibration_repetitions: "2" }),
  ])("rejects invalid preparation before service invocation: %s", async (body) => {
    let called = false;
    const routes = createTraceCandidateRoutes({
      prepare: async () => {
        called = true;
        return prepared;
      },
    });
    const response = await routes.handle(
      request(body),
      new URL(`${origin}/api/v2/trace-candidates/prepare`),
      allowedOrigins,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: "INVALID_TRACE_CANDIDATE_REQUEST" },
    });
    expect(called).toBeFalse();
  });

  test.each([
    { pattern_id: "execution-pattern-test" },
    { ...evaluationRequest, runtime: { ...evaluationRequest.runtime, config_digest: "invalid" } },
    {
      ...evaluationRequest,
      controls: { ...evaluationRequest.controls, kill_switch_enabled: "false" },
    },
  ])("rejects incomplete or malformed evaluation contracts before replay: %j", async (input) => {
    let called = false;
    const routes = createTraceCandidateRoutes({
      prepare: async () => prepared,
      evaluate: async () => {
        called = true;
        return evaluated;
      },
    });
    const url = new URL(`${origin}/api/v2/trace-candidates/evaluate`);
    const response = await routes.handle(
      new Request(url, { method: "POST", headers: { origin }, body: JSON.stringify(input) }),
      url,
      allowedOrigins,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: "INVALID_TRACE_CANDIDATE_REQUEST" },
    });
    expect(called).toBeFalse();
  });
});
