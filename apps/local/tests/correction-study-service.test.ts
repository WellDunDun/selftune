import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { getCorrectionStudy, openDb } from "@selftune/local-store";
import * as Effect from "effect/Effect";

import {
  CorrectionStudyServiceFailure,
  captureManagedCorrectionStudy,
  captureExplicitCorrectionStudy,
  lookupCorrectionStudy,
} from "../src/correction-study-service.js";
import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";
import {
  CorrectionStudyServiceError,
  createCorrectionStudyRoutes,
} from "../src/routes/correction-studies.js";

const origin = "http://127.0.0.1:3141";
const databases: ReturnType<typeof openDb>[] = [];

function database() {
  const sqlite = openDb(":memory:");
  databases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function requestPayload() {
  return {
    episode: {
      skill_id: "release-checklist",
      skill_name: "release-checklist",
      skill_path: "/Users/example/.agents/skills/release-checklist/SKILL.md",
      task: "Prepare the private beta release checklist with token=secret-value",
      observed_failure: "The agent treated a selected image as uploaded.",
      correction_intent: "Require portal status before claiming upload success.",
      pre_edit_revision: "a".repeat(64),
      post_edit_revision: "b".repeat(64),
      bounded_diff: "Add portal confirmation to /Users/example/skill/SKILL.md.",
      provenance: {
        harness: "codex",
        trace_id: "trace-1",
        session_id: "session-1",
      },
      captured_at: "2026-07-28T18:00:00.000Z",
    },
    verifier: {
      verifier_id: "portal-status-check",
      version: "v1",
      kind: "deterministic",
      qualification: {
        rejects_known_failure: true,
        accepts_known_good: true,
      },
    },
    trials: ["a", "b", "c"].map((pair_id) => ({
      pair_id,
      pre_edit: "fail",
      post_edit: "pass",
    })),
  };
}

function managedRequest() {
  const base = requestPayload();
  const taskPayload = "Confirm the release portal shows the uploaded asset.";
  return {
    episode: base.episode,
    task_case: {
      case_id: "release-portal-case",
      task_payload: taskPayload,
      task_fingerprint: `sha256:${createHash("sha256").update(taskPayload).digest("hex")}`,
    },
    current_revision: base.episode.post_edit_revision,
    runtime: {
      harness: "codex",
      model: "gpt-5",
      config_digest: `sha256:${"c".repeat(64)}`,
    },
    qualified_verifier: qualifyVerifierInstrument({
      instrument: {
        verifier_id: "portal-status-check",
        version: "v1",
        kind: "deterministic",
        success_contract: "Require portal status before declaring upload success.",
        check_description: "Checks the claimed portal state.",
      },
      evidence: ["known_failure", "known_good", "boundary", "adversarial"].map((label) => ({
        evidence_id: `control-${label}`,
        label,
        expected_decision: label === "known_failure" ? "reject" : "accept",
        observed_decision: label === "known_failure" ? "reject" : "accept",
        partition: "verifier_calibration",
        candidate_strategy_reference: null,
      })),
    }),
    required_scored_repetitions: 3,
    max_attempts_per_arm: 3,
  };
}

function managedExecutor(outcome: "success" | "infra" | "cancelled" | "mismatch") {
  return {
    execute: (request: { readonly arm: "pre_edit" | "post_edit"; readonly revision: string }) => {
      if (outcome === "infra") {
        return Effect.succeed({
          kind: "infrastructure" as const,
          category: "network" as const,
          retryable: false,
        });
      }
      if (outcome === "cancelled") return Effect.succeed({ kind: "cancelled" as const });
      return Effect.succeed({
        kind: "scored" as const,
        passed: outcome === "success" ? request.arm === "post_edit" : false,
        executed_revision: outcome === "mismatch" ? "d".repeat(64) : request.revision,
      });
    },
  };
}

function routeServiceError(error: unknown): CorrectionStudyServiceError {
  if (error instanceof CorrectionStudyServiceFailure) {
    return new CorrectionStudyServiceError(error.code, error.message, error.status);
  }
  return new CorrectionStudyServiceError(
    "CORRECTION_STUDY_PERSISTENCE_FAILED",
    error instanceof Error ? error.message : "Correction study operation failed.",
    503,
  );
}

describe("explicit correction study service", () => {
  test("captures, evaluates, persists, and looks up one promoted correction through the HTTP seam", async () => {
    const sqlite = database();
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: (input) =>
        Effect.runPromise(captureExplicitCorrectionStudy(sqlite, input)).catch((error: unknown) => {
          throw routeServiceError(error);
        }),
      lookup: (episodeId) =>
        Effect.runPromise(lookupCorrectionStudy(sqlite, episodeId)).catch((error: unknown) => {
          throw routeServiceError(error);
        }),
    });
    const payload = requestPayload();
    const capture = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/explicit-corrections`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(payload),
      }),
      new URL(`${origin}/api/v2/correction-studies/explicit-corrections`),
      new Set([origin]),
    );

    expect(capture?.status).toBe(200);
    if (!capture) throw new Error("Expected correction capture response.");
    const captured: unknown = await capture.json();
    expect(captured).toMatchObject({
      skill_id: "release-checklist",
      evidence_level: "E1",
      status: "promoted",
      reason: "promoted",
      replay: {
        source: "externally_supplied",
        verified_by_selftune: false,
        minimum_scored_trials: 3,
        scored_pairs: 3,
        censored_pairs: 0,
      },
      applies_change: false,
    });
    if (
      typeof captured !== "object" ||
      captured === null ||
      !("episode_id" in captured) ||
      typeof captured.episode_id !== "string"
    ) {
      throw new Error("Expected a correction episode id.");
    }

    const lookup = await routes.handle(
      new Request(`${origin}/api/v2/correction-studies/${captured.episode_id}`, {
        headers: { origin },
      }),
      new URL(`${origin}/api/v2/correction-studies/${captured.episode_id}`),
      new Set([origin]),
    );
    expect(lookup?.status).toBe(200);
    if (!lookup) throw new Error("Expected correction lookup response.");
    expect(await lookup.json()).toMatchObject({
      episode_id: captured.episode_id,
      evidence_level: "E1",
      status: "promoted",
      regression_case: { status: "active" },
      applies_change: false,
    });

    const persisted = Effect.runSync(getCorrectionStudy(sqlite, captured.episode_id));
    expect(persisted?.evidence_entries).toHaveLength(1);
    expect(persisted?.promoted_case?.status).toBe("active");
    expect(persisted?.episode.trace_payload_json).toContain("[redacted]");
    expect(persisted?.episode.trace_payload_json).not.toContain("secret-value");
    expect(persisted?.episode.correction_intent_json).toContain("[local-path]");
  });

  test("makes duplicate capture idempotent and keeps one regression case", async () => {
    const sqlite = database();
    const input = requestPayload();
    const first = await Effect.runPromise(captureExplicitCorrectionStudy(sqlite, input));
    const second = await Effect.runPromise(captureExplicitCorrectionStudy(sqlite, input));
    const persisted = await Effect.runPromise(getCorrectionStudy(sqlite, first.episode_id));

    expect(second).toEqual(first);
    expect(persisted?.evidence_entries).toHaveLength(1);
    expect(persisted?.promoted_case?.case_id).toBe(first.regression_case?.case_id);
  });

  test("retains insufficient replay evidence without promoting a regression case", async () => {
    const sqlite = database();
    const input = requestPayload();
    const result = await Effect.runPromise(
      captureExplicitCorrectionStudy(sqlite, {
        ...input,
        trials: input.trials.slice(0, 2),
      }),
    );

    expect(result).toMatchObject({
      evidence_level: "E0.5",
      status: "inconclusive",
      reason: "insufficient_scored_trials",
      regression_case: null,
      applies_change: false,
    });
    const persisted = await Effect.runPromise(getCorrectionStudy(sqlite, result.episode_id));
    expect(persisted?.evidence_entries).toHaveLength(1);
    expect(persisted?.promoted_case).toBeNull();
  });

  test("rejects malformed revision input at the schema boundary", async () => {
    const sqlite = database();
    const input = requestPayload();
    try {
      await Effect.runPromise(
        captureExplicitCorrectionStudy(sqlite, {
          ...input,
          episode: { ...input.episode, pre_edit_revision: "not-a-revision" },
        }),
      );
      throw new Error("Expected invalid request failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(CorrectionStudyServiceFailure);
      if (!(error instanceof CorrectionStudyServiceFailure)) throw error;
      expect(error.code).toBe("INVALID_CORRECTION_STUDY_REQUEST");
      expect(error.status).toBe(400);
    }
  });
});

describe("managed correction study service", () => {
  test("runs first-party E1 replay, labels managed evidence, and never applies a skill", async () => {
    const sqlite = database();
    const result = await Effect.runPromise(
      captureManagedCorrectionStudy(sqlite, managedRequest(), managedExecutor("success")),
    );
    const persisted = await Effect.runPromise(getCorrectionStudy(sqlite, result.episode_id));

    expect(result).toMatchObject({
      evidence_level: "E1",
      status: "promoted",
      replay: { source: "managed", verified_by_selftune: true, scored_pairs: 3 },
      applies_change: false,
    });
    expect(persisted?.episode.manifest_json).toContain('"managed":true');
    expect(persisted?.episode.manifest_json).toContain('"verified_by_selftune":true');
    expect(persisted?.promoted_case?.evidence_level).toBe("E1");
    expect(await Effect.runPromise(lookupCorrectionStudy(sqlite, result.episode_id))).toMatchObject(
      {
        replay: {
          source: "managed",
          verified_by_selftune: true,
          censored_attempts: 0,
        },
      },
    );
  });

  test("retains inconclusive managed evidence without a regression case", async () => {
    const sqlite = database();
    const result = await Effect.runPromise(
      captureManagedCorrectionStudy(sqlite, managedRequest(), managedExecutor("infra")),
    );

    expect(result).toMatchObject({
      evidence_level: "E0.5",
      status: "inconclusive",
      reason: "insufficient_scored_repetitions",
      regression_case: null,
      replay: { censored_attempts: 1 },
      applies_change: false,
    });
  });

  test("censuses cancellation and rejects stale or executor-mismatched revision pins", async () => {
    const sqlite = database();
    const cancelled = await Effect.runPromise(
      captureManagedCorrectionStudy(sqlite, managedRequest(), managedExecutor("cancelled")),
    );
    const stale = await Effect.runPromise(
      captureManagedCorrectionStudy(
        sqlite,
        {
          ...managedRequest(),
          episode: {
            ...managedRequest().episode,
            provenance: { ...managedRequest().episode.provenance, session_id: "session-stale" },
          },
          current_revision: "e".repeat(64),
        },
        managedExecutor("success"),
      ),
    );
    const mismatch = await Effect.runPromise(
      captureManagedCorrectionStudy(
        sqlite,
        {
          ...managedRequest(),
          episode: {
            ...managedRequest().episode,
            provenance: { ...managedRequest().episode.provenance, session_id: "session-mismatch" },
          },
        },
        managedExecutor("mismatch"),
      ),
    );

    expect(cancelled).toMatchObject({ status: "inconclusive", reason: "cancelled" });
    expect(stale).toMatchObject({ status: "invalid", reason: "stale_current_revision" });
    expect(mismatch).toMatchObject({ status: "invalid", reason: "executor_revision_mismatch" });
  });
});
