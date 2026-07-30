import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  _setTestDb,
  getCorrectionLearningPolicy,
  getDb,
  openDb,
  purgeExpiredE0CorrectionSourceMaterial,
  recordCorrectionReviewDecision,
  setCorrectionLearningPolicy,
  retirePromotedStudyCase,
  listActivePromotedStudyCases,
  listPromotedStudyCaseRetirements,
  createOrGetCorrectionCandidateEvaluation,
  getCorrectionCandidateEvaluation,
  listLatestCorrectionCandidateEvaluations,
  queryCorrectionPipelineMetrics,
  upsertCorrectionSignalCandidate,
} from "@selftune/local-store";
import * as Effect from "effect/Effect";
import { correctionCapabilityEnabled } from "@selftune/runtime/correction-study/review-policy";

const stamp = "2026-07-29T10:00:00.000Z";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function candidate(id: string, manifest = "a"): object {
  const payload = JSON.stringify({ id });
  return {
    candidate_id: id,
    idempotency_key: `key-${id}`,
    skill_id: "skill-1",
    skill_name: "repair-skill",
    source_session_id: "session-1",
    evidence_level: "E0",
    lifecycle: "deferred",
    reason: "review",
    manifest_digest: `sha256:${manifest.repeat(64)}`,
    signal_payload_digest: digest(payload),
    signal_payload_json: payload,
    created_at: stamp,
    updated_at: stamp,
  };
}

beforeEach(() => _setTestDb(openDb(":memory:")));
afterEach(() => _setTestDb(null));

test("defaults capture on while generation and execution are off, with bounded controls", () => {
  const initial = getCorrectionLearningPolicy(getDb(), "workspace-a");
  expect(initial).toMatchObject({
    capture_enabled: true,
    proactive_generation_enabled: false,
    managed_execution_enabled: false,
    max_concurrency: 1,
  });
  expect(() =>
    setCorrectionLearningPolicy(getDb(), "workspace-a", { ...initial, max_concurrency: 0 }),
  ).toThrow("out of bounds");
  expect(getCorrectionLearningPolicy(getDb(), "workspace-b").updated_at).toBeString();
});

test("capture stays local under kill switch or concurrency while execution paths remain independent", () => {
  const policy = {
    ...getCorrectionLearningPolicy(getDb(), "workspace-gates"),
    kill_switch_enabled: true,
    proactive_generation_enabled: false,
    managed_execution_enabled: true,
  };
  expect(correctionCapabilityEnabled(policy, "capture", 99)).toBe(true);
  expect(correctionCapabilityEnabled(policy, "proactive_generation", 0)).toBe(false);
  expect(correctionCapabilityEnabled(policy, "managed_execution", 0)).toBe(false);
  expect(
    correctionCapabilityEnabled({ ...policy, kill_switch_enabled: false }, "managed_execution", 0),
  ).toBe(true);
  expect(
    correctionCapabilityEnabled(
      { ...policy, kill_switch_enabled: false },
      "proactive_generation",
      0,
    ),
  ).toBe(false);
  expect(correctionCapabilityEnabled({ ...policy, capture_enabled: false }, "capture", 0)).toBe(
    false,
  );
});

test("records append-only decisions and requires new deferred evidence for an edit", () => {
  Effect.runSync(upsertCorrectionSignalCandidate(getDb(), candidate("candidate-old", "a")));
  Effect.runSync(upsertCorrectionSignalCandidate(getDb(), candidate("candidate-new", "b")));
  recordCorrectionReviewDecision(getDb(), {
    decision_id: "decision-defer",
    candidate_id: "candidate-old",
    action: "defer",
    actor: "reviewer",
    reason: "review later",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    decided_at: stamp,
  });
  recordCorrectionReviewDecision(getDb(), {
    decision_id: "decision-edit",
    candidate_id: "candidate-old",
    replacement_candidate_id: "candidate-new",
    action: "edit",
    actor: "reviewer",
    reason: "narrow scope",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    decided_at: stamp,
  });
  expect(() =>
    recordCorrectionReviewDecision(getDb(), {
      decision_id: "decision-bad",
      candidate_id: "candidate-old",
      action: "edit",
      actor: "reviewer",
      reason: "reuse",
      manifest_digest: `sha256:${"a".repeat(64)}`,
      decided_at: stamp,
    }),
  ).toThrow("distinct replacement");
  expect(() =>
    recordCorrectionReviewDecision(getDb(), {
      decision_id: "decision-wrong-manifest",
      candidate_id: "candidate-old",
      action: "reject",
      actor: "reviewer",
      reason: "wrong receipt",
      manifest_digest: `sha256:${"c".repeat(64)}`,
      decided_at: stamp,
    }),
  ).toThrow("exact manifest");
  recordCorrectionReviewDecision(getDb(), {
    decision_id: "decision-defer",
    candidate_id: "candidate-old",
    action: "defer",
    actor: "reviewer",
    reason: "review later",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    decided_at: "2026-07-29T12:01:00.000Z",
  });
  expect(
    getDb()
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM correction_review_decisions")
      .get()?.count,
  ).toBe(2);
});

test("makes accept and reject terminal while keeping identical delivery idempotent", () => {
  Effect.runSync(upsertCorrectionSignalCandidate(getDb(), candidate("candidate-terminal", "f")));
  const decision = {
    decision_id: "decision-terminal",
    candidate_id: "candidate-terminal",
    action: "accept" as const,
    actor: "reviewer",
    reason: "verified",
    manifest_digest: `sha256:${"f".repeat(64)}`,
    decided_at: stamp,
  };
  recordCorrectionReviewDecision(getDb(), decision);
  recordCorrectionReviewDecision(getDb(), {
    ...decision,
    decided_at: "2026-07-29T12:01:00.000Z",
  });
  expect(() =>
    recordCorrectionReviewDecision(getDb(), {
      ...decision,
      decision_id: "decision-terminal-conflict",
      action: "reject",
      reason: "changed mind",
    }),
  ).toThrow("terminal accept");
  expect(
    getDb()
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM correction_review_decisions WHERE candidate_id = 'candidate-terminal'",
      )
      .get()?.count,
  ).toBe(1);
});

test("retention deletes only expired E0 raw material", () => {
  Effect.runSync(upsertCorrectionSignalCandidate(getDb(), candidate("candidate-retention", "c")));
  recordCorrectionReviewDecision(getDb(), {
    decision_id: "decision-retention",
    candidate_id: "candidate-retention",
    action: "defer",
    actor: "reviewer",
    reason: "retain ledger",
    manifest_digest: `sha256:${"c".repeat(64)}`,
    decided_at: stamp,
  });
  const revision = "a".repeat(64);
  getDb()
    .query(
      `INSERT INTO correction_episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "episode-retained",
      "capture-retained",
      "skill-1",
      "repair-skill",
      "/local/SKILL.md",
      "codex",
      "session-1",
      revision,
      "b".repeat(64),
      "{}",
      "{}",
      "{}",
      "E1",
      "promoted",
      null,
      stamp,
      stamp,
      stamp,
      "episode-evidence",
      "capture-evidence",
      "skill-1",
      "repair-skill",
      "/local/SKILL.md",
      "codex",
      "session-1",
      revision,
      "c".repeat(64),
      "{}",
      "{}",
      "{}",
      "E1",
      "captured",
      null,
      stamp,
      stamp,
      stamp,
    );
  getDb()
    .query(
      "INSERT INTO correction_evidence_ledger_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "evidence-retained",
      "skill-1",
      "episode-retained",
      "evidence-key",
      "E2",
      "qualified",
      null,
      "{}",
      "{}",
      '{"censored_attempts":3}',
      stamp,
    );
  getDb()
    .query("INSERT INTO promoted_study_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "case-retained",
      "episode-retained",
      "evidence-retained",
      "repair-skill",
      "skill-1",
      revision,
      "b".repeat(64),
      "{}",
      "{}",
      "{}",
      "E2",
      "active",
      null,
      stamp,
      stamp,
    );
  getDb()
    .query("INSERT INTO correction_raw_source_material VALUES (?, ?, ?, ?, ?, ?)")
    .run("raw-1", "candidate-retention", "E0", '{"raw":true}', "2026-07-01T00:00:00.000Z", stamp);
  getDb()
    .query("INSERT INTO correction_raw_source_material VALUES (?, ?, ?, ?, ?, ?)")
    .run("raw-e05", "candidate-retention", "E0.5", "{}", "2026-07-01T00:00:00.000Z", stamp);
  getDb()
    .query("INSERT INTO correction_raw_source_material VALUES (?, ?, ?, ?, ?, ?)")
    .run("raw-future", "candidate-retention", "E0", "{}", "2026-08-01T00:00:00.000Z", stamp);
  expect(purgeExpiredE0CorrectionSourceMaterial(getDb(), stamp)).toBe(1);
  expect(
    getDb()
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM correction_signal_candidates")
      .get()?.count,
  ).toBe(1);
  expect(
    getDb()
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM correction_review_decisions")
      .get()?.count,
  ).toBe(1);
  expect(
    getDb()
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM correction_evidence_ledger_entries",
      )
      .get()?.count,
  ).toBe(1);
  expect(
    getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM promoted_study_cases").get()
      ?.count,
  ).toBe(1);
  expect(
    getDb()
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM correction_raw_source_material")
      .get()?.count,
  ).toBe(2);
  expect(queryCorrectionPipelineMetrics(getDb(), 10)).toMatchObject({
    capture_candidates: 1,
    drafts: 0,
    verifier_replay_evidence: 1,
    promoted_regressions: 1,
    invalid_or_inconclusive: 0,
    review_decisions: 1,
    infrastructure_censored_attempts: 3,
  });
});

test("retires an active promoted case with an immutable receipt", () => {
  const revision = "a".repeat(64);
  const manifest = "{}";
  getDb()
    .query(
      "INSERT INTO correction_episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "episode-r",
      "capture-r",
      "skill-r",
      "repair-skill",
      "/local/SKILL.md",
      "codex",
      "session-r",
      revision,
      "b".repeat(64),
      manifest,
      "{}",
      "{}",
      "E1",
      "promoted",
      null,
      stamp,
      stamp,
      stamp,
    );
  getDb()
    .query(
      "INSERT INTO correction_evidence_ledger_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "evidence-r",
      "skill-r",
      "episode-r",
      "evidence-r-key",
      "E2",
      "qualified",
      null,
      manifest,
      "{}",
      "{}",
      stamp,
    );
  getDb()
    .query("INSERT INTO promoted_study_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "case-r",
      "episode-r",
      "evidence-r",
      "repair-skill",
      "skill-r",
      revision,
      "b".repeat(64),
      manifest,
      "{}",
      "{}",
      "E2",
      "active",
      null,
      stamp,
      stamp,
    );
  const prior = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  expect(listActivePromotedStudyCases(getDb(), "skill-r", 1)).toHaveLength(1);
  retirePromotedStudyCase(getDb(), {
    retirement_id: "retirement-r",
    case_id: "case-r",
    actor: "reviewer",
    reason: "obsolete",
    prior_manifest_digest: prior,
    retired_at: stamp,
  });
  expect(listActivePromotedStudyCases(getDb(), "skill-r")).toHaveLength(0);
  expect(listPromotedStudyCaseRetirements(getDb(), "case-r")).toHaveLength(1);
  expect(
    getDb()
      .query<{ manifest_json: string }, [string]>(
        "SELECT manifest_json FROM promoted_study_cases WHERE case_id = ?",
      )
      .get("case-r")?.manifest_json,
  ).toBe(manifest);
  expect(() =>
    retirePromotedStudyCase(getDb(), {
      retirement_id: "retirement-r2",
      case_id: "case-r",
      actor: "reviewer",
      reason: "again",
      prior_manifest_digest: prior,
      retired_at: stamp,
    }),
  ).toThrow("immutable retirement");
});

test("stores immutable bounded candidate evaluations without applying changes", () => {
  Effect.runSync(upsertCorrectionSignalCandidate(getDb(), candidate("candidate-eval", "d")));
  const input = {
    evaluation_id: "eval-1",
    candidate_id: "candidate-eval",
    current_revision: "a".repeat(64),
    candidate_revision: "b".repeat(64),
    evidence_level: "E2" as const,
    status: "selected" as const,
    blind_manifest_json: "{}",
    blind_result_json: "{}",
    verifier_provenance: "{}",
    runtime_provenance: "{}",
    cost_estimate: "0.25",
    cost_actual: "0",
    recorded_at: stamp,
  };
  expect(createOrGetCorrectionCandidateEvaluation(getDb(), input)).toMatchObject({
    applies_change: "0",
  });
  expect(createOrGetCorrectionCandidateEvaluation(getDb(), input)).toMatchObject({
    evaluation_id: "eval-1",
  });
  expect(getCorrectionCandidateEvaluation(getDb(), "eval-1")).not.toBeNull();
  expect(listLatestCorrectionCandidateEvaluations(getDb(), "candidate-eval", 1)).toHaveLength(1);
  expect(() =>
    createOrGetCorrectionCandidateEvaluation(getDb(), {
      ...input,
      evaluation_id: "eval-2",
      candidate_id: "missing",
    }),
  ).toThrow("does not exist");
  expect(() =>
    createOrGetCorrectionCandidateEvaluation(getDb(), {
      ...input,
      evaluation_id: "eval-3",
      evidence_level: "E1",
    }),
  ).toThrow("status");
  expect(() =>
    createOrGetCorrectionCandidateEvaluation(getDb(), {
      ...input,
      evaluation_id: "eval-4",
      candidate_revision: input.current_revision,
    }),
  ).toThrow("identity");
  expect(() =>
    createOrGetCorrectionCandidateEvaluation(getDb(), {
      ...input,
      evaluation_id: "eval-5",
      cost_actual: "-1",
    }),
  ).toThrow("cost");
  expect(() =>
    createOrGetCorrectionCandidateEvaluation(getDb(), {
      ...input,
      evaluation_id: "eval-6",
      blind_result_json: "{",
    }),
  ).toThrow();
  expect(() =>
    createOrGetCorrectionCandidateEvaluation(getDb(), {
      ...input,
      evaluation_id: "eval-7",
      verifier_provenance: "x".repeat(65_537),
    }),
  ).toThrow("bound");
});
