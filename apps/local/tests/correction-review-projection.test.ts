import { afterEach, expect, test } from "bun:test";

import {
  createOrGetCorrectionCandidateEvaluation,
  openDb,
  recordCorrectionReviewDecision,
} from "@selftune/local-store";

import {
  listCorrectionReviews,
  projectCorrectionReview,
} from "../src/correction-review-projection.js";
import { recordLocalCorrectionReviewDecision } from "../src/correction-review-service.js";
import type { CorrectionReviewRequest } from "../src/correction-review-request.js";
import { createCorrectionStudyRoutes } from "../src/routes/correction-studies.js";
import { studyResponse } from "./correction-route-fixtures.js";

const databases: Array<ReturnType<typeof openDb>> = [];
const manifestDigest = `sha256:${"d".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seedCandidate(database: ReturnType<typeof openDb>): void {
  database
    .query(
      "INSERT INTO correction_signal_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "candidate-review",
      "candidate-review-key",
      "release-checklist",
      "release-checklist",
      "session-review",
      "E0.5",
      "review_ready",
      "invocation_hash_delta",
      manifestDigest,
      `sha256:${"e".repeat(64)}`,
      JSON.stringify({
        reason: "The agent claimed an upload before the portal confirmed it.",
        correction_intent: "Require portal confirmation before declaring upload success.",
      }),
      "2026-07-29T12:00:00.000Z",
      "2026-07-29T12:00:00.000Z",
    );
  database
    .query("INSERT INTO correction_study_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "draft-review",
      "draft-review-key",
      "candidate-review",
      "release-checklist",
      "release-checklist",
      "a".repeat(64),
      "E0.5",
      "review_ready",
      null,
      manifestDigest,
      `sha256:${"f".repeat(64)}`,
      JSON.stringify({
        task_capsule: {
          observed_failure: "A selected asset was reported as uploaded.",
          correction_intent: "Wait for the successful portal status.",
        },
        revisions: {
          pre_edit_revision: "a".repeat(64),
          post_edit_revision: "b".repeat(64),
        },
      }),
      "2026-07-29T12:00:00.000Z",
      "2026-07-29T12:00:00.000Z",
    );
}

function evaluation(
  database: ReturnType<typeof openDb>,
  input: {
    readonly evaluationId: string;
    readonly recordedAt: string;
    readonly evidenceLevel: "E0.5" | "E2";
    readonly status: "inconclusive" | "selected";
    readonly reason?: string;
  },
): void {
  createOrGetCorrectionCandidateEvaluation(database, {
    evaluation_id: input.evaluationId,
    candidate_id: "candidate-review",
    current_revision: "b".repeat(64),
    candidate_revision: input.evaluationId === "eval-latest" ? "c".repeat(64) : "d".repeat(64),
    evidence_level: input.evidenceLevel,
    status: input.status,
    reason: input.reason,
    blind_manifest_json: JSON.stringify({
      candidate: {
        installed_body: "Claim success when selected.",
        proposed_body: "Claim success only after portal confirmation.",
        changed_lines: 1,
      },
      active_regression_cases: [
        { case_id: "prior-regression", skill_id: "release-checklist", status: "active" },
      ],
    }),
    blind_result_json: JSON.stringify({
      reason: input.status === "selected" ? "selected" : input.reason,
      trials: [
        {
          case_id: "prior-regression",
          arm: "candidate_skill",
          scored_repetitions: 3,
          passed_repetitions: 3,
          skipped: false,
        },
      ],
    }),
    verifier_provenance: JSON.stringify({
      instrument: { verifier_id: "portal-check", version: "v1" },
    }),
    runtime_provenance: "{}",
    recorded_at: input.recordedAt,
  });
}

test("projects one auditable review from the latest durable evaluation", () => {
  const database = openDb(":memory:");
  databases.push(database);
  seedCandidate(database);
  evaluation(database, {
    evaluationId: "eval-old",
    recordedAt: "2026-07-29T12:01:00.000Z",
    evidenceLevel: "E0.5",
    status: "inconclusive",
    reason: "candidate_did_not_beat_baselines",
  });
  evaluation(database, {
    evaluationId: "eval-latest",
    recordedAt: "2026-07-29T12:02:00.000Z",
    evidenceLevel: "E2",
    status: "selected",
  });
  recordCorrectionReviewDecision(database, {
    decision_id: "decision-defer",
    candidate_id: "candidate-review",
    action: "defer",
    actor: "reviewer",
    reason: "Review tomorrow.",
    manifest_digest: manifestDigest,
    decided_at: "2026-07-29T12:03:00.000Z",
  });

  const [review] = listCorrectionReviews(database, 25);
  expect(listCorrectionReviews(database, 25)).toHaveLength(1);
  expect(review).toMatchObject({
    candidate_id: "candidate-review",
    evidence_level: "E2",
    observed_failure: "A selected asset was reported as uploaded.",
    correction_intent: "Wait for the successful portal status.",
    evaluation: { summary: "selected: selected", regressions: [] },
    terminal: false,
  });
  expect(review?.proposed_change?.diff).toContain("-Claim success when selected.");
  expect(review?.proposed_change?.diff).toContain("+Claim success only after portal confirmation.");
  expect(review?.provenance).toEqual(["Verifier portal-check@v1"]);

  recordCorrectionReviewDecision(database, {
    decision_id: "decision-accept",
    candidate_id: "candidate-review",
    action: "accept",
    actor: "reviewer",
    reason: "Evidence is sufficient.",
    manifest_digest: manifestDigest,
    decided_at: "2026-07-29T12:04:00.000Z",
  });
  expect(listCorrectionReviews(database, 25)[0]?.terminal).toBeTrue();
});

test("bounds malformed projection payloads instead of exposing raw JSON", () => {
  const projected = projectCorrectionReview({
    candidate_id: "candidate-malformed",
    evidence_level: "unexpected",
    signal_payload_json: "{",
    study_payload_json: "x".repeat(65_537),
    evaluation_manifest_json: "{",
    evaluation_result_json: "{",
    manifest_digest: manifestDigest,
  });
  expect(projected).toMatchObject({
    candidate_id: "candidate-malformed",
    evidence_level: "E0",
    proposed_change: null,
    evaluation: null,
  });
  expect(JSON.stringify(projected)).not.toContain("x".repeat(1_000));
  const database = openDb(":memory:");
  databases.push(database);
  expect(() => listCorrectionReviews(database, 129)).toThrow(RangeError);
});

test.each(["accept", "reject", "defer"])(
  "records an HTTP %s review once without applying a skill",
  async (action) => {
    const database = openDb(":memory:");
    databases.push(database);
    seedCandidate(database);
    const origin = "http://127.0.0.1:3141";
    const url = new URL(`${origin}/api/v2/correction-studies/review-decisions`);
    const routes = createCorrectionStudyRoutes({
      captureExplicitCorrection: async () => studyResponse,
      lookup: async () => studyResponse,
      recordReviewDecision: async (input) => recordLocalCorrectionReviewDecision(database, input),
    });
    const body = JSON.stringify({
      candidate_id: "candidate-review",
      action,
      reason: "Reviewed evidence",
      manifest_digest: manifestDigest,
    });
    const request = () => new Request(url, { method: "POST", headers: { origin }, body });
    const first = await routes.handle(request(), url, new Set([origin]));
    const retry = await routes.handle(request(), url, new Set([origin]));
    expect(first?.status).toBe(200);
    expect(retry?.status).toBe(200);
    expect(await first?.json()).toEqual({ recorded: true, action, applies_skill: false });
    expect(await retry?.json()).toEqual({ recorded: true, action, applies_skill: false });
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM correction_review_decisions")
        .get()?.count,
    ).toBe(1);
  },
);

test("records identical dashboard review delivery exactly once without applying", () => {
  const database = openDb(":memory:");
  databases.push(database);
  seedCandidate(database);
  const input = {
    candidate_id: "candidate-review",
    action: "defer",
    reason: "Wait for the release window.",
    manifest_digest: manifestDigest,
  } satisfies CorrectionReviewRequest;
  expect(
    recordLocalCorrectionReviewDecision(database, input, "2026-07-29T12:10:00.000Z"),
  ).toMatchObject({ recorded: true, applies_skill: false });
  recordLocalCorrectionReviewDecision(database, input, "2026-07-29T12:11:00.000Z");
  expect(
    database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM correction_review_decisions")
      .get()?.count,
  ).toBe(1);
});

test.each(["null", "[]", "42", '"unexpected"', "{"])(
  "keeps scalar review metadata when saved evidence is %s",
  (payload) => {
    const projected = projectCorrectionReview({
      candidate_id: "candidate-partial",
      evidence_level: "E1",
      reason: "Saved candidate reason",
      signal_payload_json: payload,
      study_payload_json: payload,
      evaluation_manifest_json: payload,
      evaluation_result_json: payload,
      verifier_provenance: payload,
      evaluation_status: "inconclusive",
      evaluation_reason: "Saved evaluation reason",
    });
    expect(projected).toMatchObject({
      candidate_id: "candidate-partial",
      evidence_level: "E1",
      observed_failure: "Saved candidate reason",
      evaluation: { summary: "inconclusive: Saved evaluation reason", regressions: [] },
      proposed_change: null,
      provenance: ["Candidate manifest"],
      terminal: false,
    });
  },
);

test("retains valid regression neighbors and does not coerce malformed trial fields", () => {
  const projected = projectCorrectionReview({
    signal_payload_json: JSON.stringify({ reason: "Valid reason", correction_intent: 12 }),
    study_payload_json: JSON.stringify({
      task_capsule: { observed_failure: [], correction_intent: "Keep portal confirmation" },
    }),
    evaluation_status: "rejected",
    evaluation_manifest_json: JSON.stringify({
      candidate: { installed_body: "Before", proposed_body: "After", changed_lines: "2" },
      active_regression_cases: [null, 2, [], { case_id: 4 }, { case_id: "active" }],
    }),
    evaluation_result_json: JSON.stringify({
      reason: {},
      trials: [
        null,
        [],
        {
          case_id: "active",
          arm: "candidate_skill",
          passed_repetitions: "0",
          scored_repetitions: 3,
        },
        { case_id: "active", arm: "candidate_skill", skipped: "true" },
        { case_id: "inactive", arm: "candidate_skill", skipped: true },
        { case_id: "active", arm: "current_skill", skipped: true },
        { case_id: "active", arm: "candidate_skill", passed_repetitions: 1, scored_repetitions: 3 },
        { case_id: "active", arm: "candidate_skill", skipped: true },
      ],
    }),
    verifier_provenance: JSON.stringify({ instrument: { verifier_id: "portal", version: 2 } }),
  });
  expect(projected.observed_failure).toBe("Valid reason");
  expect(projected.correction_intent).toBe("Keep portal confirmation");
  expect(projected.proposed_change).toEqual({
    diff: "--- current skill body\n+++ proposed skill body\n-Before\n+After",
    summary: "Bounded changed line(s)",
  });
  expect(projected.evaluation).toEqual({
    summary: "rejected: No reason recorded",
    regressions: ["active", "active"],
  });
  expect(projected.provenance).toEqual(["Verifier portal"]);
});

test("keeps explicit empty evidence and bounded display text", () => {
  const projected = projectCorrectionReview({
    reason: "Fallback reason",
    signal_payload_json: JSON.stringify({ reason: "" }),
    study_payload_json: JSON.stringify({ task_capsule: { correction_intent: "x".repeat(8_001) } }),
    evaluation_manifest_json: JSON.stringify({
      candidate: { installed_body: "Before", proposed_body: "After", changed_lines: 0 },
    }),
    last_action: "reject",
  });
  expect(projected.observed_failure).toBe("");
  expect(projected.correction_intent).toHaveLength(8_000);
  expect(projected.proposed_change?.summary).toBe("0 changed line(s)");
  expect(projected.terminal).toBeTrue();
});
