import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setTestDb,
  getCorrectionSignalCandidate,
  getCorrectionStudyDraft,
  getDb,
  listCorrectionSignalCandidates,
  listCorrectionStudyDrafts,
  openDb,
  upsertCorrectionSignalCandidate,
  upsertCorrectionStudyDraft,
} from "@selftune/local-store";
import * as Effect from "effect/Effect";

const revision = "a".repeat(64);
const createdAt = "2026-07-29T09:00:00.000Z";

function digest(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function signalCandidate(
  overrides: Partial<{
    candidate_id: string;
    idempotency_key: string;
    skill_id: string;
    source_session_id: string;
    lifecycle: "detected" | "review_ready" | "deferred" | "dismissed";
    updated_at: string;
  }> = {},
) {
  const payload = JSON.stringify({ source: "trace", observed: "repeated retry" });
  return {
    candidate_id: overrides.candidate_id ?? "signal-001",
    idempotency_key: overrides.idempotency_key ?? "signal-key-001",
    skill_id: overrides.skill_id ?? "skill-001",
    skill_name: "repair-skill",
    source_session_id: overrides.source_session_id ?? "session-001",
    evidence_level: "E0" as const,
    lifecycle: overrides.lifecycle ?? ("detected" as const),
    reason: "retry_cluster",
    manifest_digest: `sha256:${"b".repeat(64)}`,
    signal_payload_digest: digest(payload),
    signal_payload_json: payload,
    created_at: createdAt,
    updated_at: overrides.updated_at ?? createdAt,
  };
}

function studyDraft(
  overrides: Partial<{
    draft_id: string;
    idempotency_key: string;
    candidate_id: string;
    skill_id: string;
    lifecycle: "prepared" | "review_ready" | "deferred" | "invalid";
    updated_at: string;
  }> = {},
) {
  const payload = JSON.stringify({ task_capsule: "repair one file", verifier_plan: "review only" });
  return {
    draft_id: overrides.draft_id ?? "draft-001",
    idempotency_key: overrides.idempotency_key ?? "draft-key-001",
    candidate_id: overrides.candidate_id ?? "signal-001",
    skill_id: overrides.skill_id ?? "skill-001",
    skill_name: "repair-skill",
    source_revision: revision,
    evidence_level: "E0.5" as const,
    lifecycle: overrides.lifecycle ?? ("prepared" as const),
    reason: "bounded_capsule",
    manifest_digest: `sha256:${"c".repeat(64)}`,
    study_payload_digest: digest(payload),
    study_payload_json: payload,
    created_at: createdAt,
    updated_at: overrides.updated_at ?? createdAt,
  };
}

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
});

test("persists and lists E0/E0.5 review-only signals and bounded StudyDrafts", () => {
  const candidate = Effect.runSync(upsertCorrectionSignalCandidate(getDb(), signalCandidate()));
  const draft = Effect.runSync(upsertCorrectionStudyDraft(getDb(), studyDraft()));

  expect(candidate).toMatchObject({ evidence_level: "E0", lifecycle: "detected" });
  expect(draft).toMatchObject({ evidence_level: "E0.5", lifecycle: "prepared" });
  expect(
    Effect.runSync(listCorrectionSignalCandidates(getDb(), { skill_id: "skill-001" })),
  ).toHaveLength(1);
  expect(
    Effect.runSync(listCorrectionStudyDrafts(getDb(), { lifecycle: "prepared" })),
  ).toHaveLength(1);
});

test("idempotently refreshes lifecycle state without changing immutable payload evidence", () => {
  Effect.runSync(upsertCorrectionSignalCandidate(getDb(), signalCandidate()));
  const refreshed = Effect.runSync(
    upsertCorrectionSignalCandidate(
      getDb(),
      signalCandidate({ lifecycle: "review_ready", updated_at: "2026-07-29T09:01:00.000Z" }),
    ),
  );
  Effect.runSync(upsertCorrectionStudyDraft(getDb(), studyDraft()));
  const draft = Effect.runSync(
    upsertCorrectionStudyDraft(
      getDb(),
      studyDraft({ lifecycle: "review_ready", updated_at: "2026-07-29T09:02:00.000Z" }),
    ),
  );

  expect(refreshed).toMatchObject({
    lifecycle: "review_ready",
    updated_at: "2026-07-29T09:01:00.000Z",
  });
  expect(draft).toMatchObject({
    lifecycle: "review_ready",
    updated_at: "2026-07-29T09:02:00.000Z",
  });
});

test("rejects a StudyDraft without its local signal candidate", () => {
  expect(() => Effect.runSync(upsertCorrectionStudyDraft(getDb(), studyDraft()))).toThrow(
    "requires an existing signal candidate",
  );
});

test("bounds filtered candidate and StudyDraft reads in SQLite", () => {
  for (let index = 0; index < 55; index += 1) {
    const candidateId = `signal-bounded-${index}`;
    const lifecycle = index % 2 === 0 ? "detected" : "deferred";
    Effect.runSync(
      upsertCorrectionSignalCandidate(
        getDb(),
        signalCandidate({
          candidate_id: candidateId,
          idempotency_key: `signal-bounded-key-${index}`,
          skill_id: "skill-bounded",
          source_session_id: `session-bounded-${index}`,
          lifecycle,
          updated_at: `2026-07-29T09:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      ),
    );
    Effect.runSync(
      upsertCorrectionStudyDraft(
        getDb(),
        studyDraft({
          draft_id: `draft-bounded-${index}`,
          idempotency_key: `draft-bounded-key-${index}`,
          candidate_id: candidateId,
          skill_id: "skill-bounded",
          lifecycle: index % 2 === 0 ? "prepared" : "deferred",
          updated_at: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      ),
    );
  }

  const candidates = Effect.runSync(
    listCorrectionSignalCandidates(getDb(), {
      skill_id: "skill-bounded",
      lifecycle: "deferred",
      limit: 7,
    }),
  );
  const drafts = Effect.runSync(
    listCorrectionStudyDrafts(getDb(), {
      skill_id: "skill-bounded",
      lifecycle: "deferred",
      limit: 6,
    }),
  );

  expect(candidates).toHaveLength(7);
  expect(candidates.every((candidate) => candidate.lifecycle === "deferred")).toBe(true);
  expect(drafts).toHaveLength(6);
  expect(drafts.every((draft) => draft.lifecycle === "deferred")).toBe(true);
});

test("migrates and reopens durable E0/E0.5 review state", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-signal-draft-"));
  const databasePath = join(root, "selftune.db");
  const first = openDb(databasePath);
  try {
    Effect.runSync(upsertCorrectionSignalCandidate(first, signalCandidate()));
    Effect.runSync(upsertCorrectionStudyDraft(first, studyDraft()));
  } finally {
    first.close();
  }

  const reopened = openDb(databasePath);
  try {
    expect(Effect.runSync(getCorrectionSignalCandidate(reopened, "signal-001"))).toMatchObject({
      manifest_digest: `sha256:${"b".repeat(64)}`,
      lifecycle: "detected",
    });
    expect(Effect.runSync(getCorrectionStudyDraft(reopened, "draft-001"))).toMatchObject({
      source_revision: revision,
      lifecycle: "prepared",
    });
  } finally {
    reopened.close();
    rmSync(root, { force: true, recursive: true });
  }
});
