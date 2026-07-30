import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setTestDb,
  type CreateOrGetCorrectionStudy,
  createOrGetCorrectionStudy,
  getCorrectionStudy,
  getDb,
  openDb,
} from "@selftune/local-store";
import * as Effect from "effect/Effect";

const beforeRevision = "a".repeat(64);
const afterRevision = "b".repeat(64);
const capturedAt = "2026-07-28T08:00:00.000Z";

function correctionStudy(
  overrides: Partial<{
    episode_id: string;
    capture_key: string;
    evidence_id: string;
    evidence_key: string;
    case_id: string;
    evidence_status: "qualified" | "inconclusive";
    include_case: boolean;
    manifest_json: string;
  }> = {},
): CreateOrGetCorrectionStudy {
  const episodeId = overrides.episode_id ?? "episode-001";
  const evidenceId = overrides.evidence_id ?? "evidence-001";
  const manifestJson = overrides.manifest_json ?? JSON.stringify({ task: "repair one file" });
  const includeCase = overrides.include_case ?? true;
  const evidenceStatus = overrides.evidence_status ?? "qualified";
  return {
    episode: {
      episode_id: episodeId,
      capture_key: overrides.capture_key ?? "capture-001",
      skill_id: "skill-001",
      skill_name: "repair-skill",
      skill_path: "/workspace/repair/SKILL.md",
      harness: "codex",
      source_session_id: "session-001",
      pre_revision: beforeRevision,
      post_revision: afterRevision,
      manifest_json: manifestJson,
      correction_intent_json: JSON.stringify({ intent: "keep tests focused" }),
      trace_payload_json: JSON.stringify({ trace_ref: "local:session-001" }),
      evidence_level: "E1",
      status: includeCase ? "promoted" : "inconclusive",
      reason: includeCase ? null : "The verifier did not reproduce the original failure.",
      captured_at: capturedAt,
      created_at: capturedAt,
      updated_at: capturedAt,
    },
    evidence: {
      evidence_id: evidenceId,
      skill_id: "skill-001",
      episode_id: episodeId,
      evidence_key: overrides.evidence_key ?? "evidence-key-001",
      evidence_level: "E1",
      status: evidenceStatus,
      reason: includeCase ? null : "The verifier did not reproduce the original failure.",
      manifest_json: manifestJson,
      verifier_payload_json: JSON.stringify({ kind: "deterministic", version: "v1" }),
      trial_payload_json: JSON.stringify({ old_fails: true, corrected_passes: true }),
      recorded_at: "2026-07-28T08:01:00.000Z",
    },
    ...(includeCase
      ? {
          promoted_case: {
            case_id: overrides.case_id ?? "case-001",
            episode_id: episodeId,
            evidence_id: evidenceId,
            skill_id: "skill-001",
            skill_name: "repair-skill",
            pre_revision: beforeRevision,
            post_revision: afterRevision,
            manifest_json: manifestJson,
            verifier_payload_json: JSON.stringify({ kind: "deterministic", version: "v1" }),
            trial_payload_json: JSON.stringify({ old_fails: true, corrected_passes: true }),
            evidence_level: "E1",
            status: "active",
            reason: null,
            promoted_at: "2026-07-28T08:02:00.000Z",
            created_at: "2026-07-28T08:02:00.000Z",
          },
        }
      : {}),
  };
}

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
});

test("persists a qualified correction and its promoted regression case", () => {
  const created = Effect.runSync(createOrGetCorrectionStudy(getDb(), correctionStudy()));
  const reread = Effect.runSync(getCorrectionStudy(getDb(), "episode-001"));

  expect(created.episode).toMatchObject({
    pre_revision: beforeRevision,
    post_revision: afterRevision,
    evidence_level: "E1",
    status: "promoted",
  });
  expect(created.evidence_entries).toHaveLength(1);
  expect(created.promoted_case).toMatchObject({
    case_id: "case-001",
    verifier_payload_json: JSON.stringify({ kind: "deterministic", version: "v1" }),
  });
  expect(reread).toEqual(created);
});

test("makes repeated deterministic capture idempotent without duplicating a regression case", () => {
  const input = correctionStudy();
  Effect.runSync(createOrGetCorrectionStudy(getDb(), input));
  const repeated = Effect.runSync(createOrGetCorrectionStudy(getDb(), input));

  expect(repeated.evidence_entries).toHaveLength(1);
  expect(repeated.promoted_case?.case_id).toBe("case-001");
});

test("keeps a promoted case after a durable database reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-correction-study-"));
  const databasePath = join(root, "selftune.db");
  const first = openDb(databasePath);
  try {
    Effect.runSync(createOrGetCorrectionStudy(first, correctionStudy()));
  } finally {
    first.close();
  }

  const reopened = openDb(databasePath);
  try {
    const study = Effect.runSync(getCorrectionStudy(reopened, "episode-001"));
    expect(study?.promoted_case).toMatchObject({
      case_id: "case-001",
      post_revision: afterRevision,
    });
  } finally {
    reopened.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("persists an inconclusive result without promoting a case", () => {
  const input = correctionStudy({ include_case: false, evidence_status: "inconclusive" });
  const stored = Effect.runSync(createOrGetCorrectionStudy(getDb(), input));

  expect(stored.episode.status).toBe("inconclusive");
  expect(stored.evidence_entries).toHaveLength(1);
  expect(stored.evidence_entries[0]?.status).toBe("inconclusive");
  expect(stored.promoted_case).toBeNull();
});

test("rejects a conflicting reuse of a deterministic correction capture key", () => {
  Effect.runSync(createOrGetCorrectionStudy(getDb(), correctionStudy()));

  expect(() =>
    Effect.runSync(
      createOrGetCorrectionStudy(
        getDb(),
        correctionStudy({
          episode_id: "episode-002",
          manifest_json: JSON.stringify({ task: "other" }),
        }),
      ),
    ),
  ).toThrow("episode identifier is already bound");

  const stored = Effect.runSync(getCorrectionStudy(getDb(), "episode-001"));
  expect(stored?.evidence_entries).toHaveLength(1);
  expect(stored?.promoted_case?.case_id).toBe("case-001");
});

test("rejects a reused episode id before attaching another evidence entry", () => {
  Effect.runSync(createOrGetCorrectionStudy(getDb(), correctionStudy()));

  expect(() =>
    Effect.runSync(
      createOrGetCorrectionStudy(
        getDb(),
        correctionStudy({
          capture_key: "capture-002",
          evidence_id: "evidence-002",
          evidence_key: "evidence-key-002",
          case_id: "case-002",
        }),
      ),
    ),
  ).toThrow("episode identifier is already bound");

  const stored = Effect.runSync(getCorrectionStudy(getDb(), "episode-001"));
  expect(stored?.evidence_entries).toHaveLength(1);
  expect(stored?.evidence_entries[0]?.evidence_id).toBe("evidence-001");
});

test("rejects a reused evidence id before creating an orphan episode", () => {
  Effect.runSync(createOrGetCorrectionStudy(getDb(), correctionStudy()));

  expect(() =>
    Effect.runSync(
      createOrGetCorrectionStudy(
        getDb(),
        correctionStudy({
          episode_id: "episode-002",
          capture_key: "capture-002",
          evidence_key: "evidence-key-002",
          case_id: "case-002",
        }),
      ),
    ),
  ).toThrow("evidence identifier is already bound");

  expect(Effect.runSync(getCorrectionStudy(getDb(), "episode-002"))).toBeNull();
});
