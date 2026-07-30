import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setTestDb,
  createOrGetPreparedEvaluationSubmissionDraft,
  getDb,
  getEvaluationSubmissionDraft,
  markEvaluationSubmissionDraftStale,
  markEvaluationSubmissionDraftSubmitted,
  openDb,
} from "@selftune/local-store";
import * as Effect from "effect/Effect";

const cohortFingerprint = `sha256:${"a".repeat(64)}`;
const revision = "b".repeat(64);
const createdAt = "2026-07-24T10:00:00.000Z";

function preparedDraft(
  overrides: Partial<{
    draft_id: string;
    pattern_id: string;
    cohort_fingerprint: string;
    skill_name: string;
    skill_revision: string;
    payload_json: string;
    prepared_at: string;
  }> = {},
) {
  return {
    draft_id: "draft-001",
    pattern_id: "execution-pattern-001",
    cohort_fingerprint: cohortFingerprint,
    skill_name: "review-skill",
    skill_revision: revision,
    payload_json: JSON.stringify({ schema_version: 1, candidate: "body" }),
    prepared_at: createdAt,
    ...overrides,
  };
}

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
});

test("retries the same content-addressed draft without merging a different candidate", () => {
  const first = Effect.runSync(
    createOrGetPreparedEvaluationSubmissionDraft(getDb(), preparedDraft()),
  );
  const repeated = Effect.runSync(
    createOrGetPreparedEvaluationSubmissionDraft(
      getDb(),
      preparedDraft({
        prepared_at: "2026-07-24T10:05:00.000Z",
      }),
    ),
  );
  const different = Effect.runSync(
    createOrGetPreparedEvaluationSubmissionDraft(
      getDb(),
      preparedDraft({
        draft_id: "draft-002",
        payload_json: JSON.stringify({ schema_version: 1, candidate: "refined body" }),
        prepared_at: "2026-07-24T10:06:00.000Z",
      }),
    ),
  );

  expect(first.draft_id).toBe("draft-001");
  expect(repeated.draft_id).toBe("draft-001");
  expect(repeated.lifecycle).toBe("prepared");
  expect(repeated.updated_at).toBe("2026-07-24T10:05:00.000Z");
  expect(different.draft_id).toBe("draft-002");
  expect(different.payload_json).toContain("refined body");
});

test("never reuses a submitted receipt for a different candidate in the same cohort", () => {
  Effect.runSync(createOrGetPreparedEvaluationSubmissionDraft(getDb(), preparedDraft()));
  Effect.runSync(
    markEvaluationSubmissionDraftSubmitted(getDb(), {
      draft_id: "draft-001",
      cloud_run_id: "run-001",
    }),
  );

  const next = Effect.runSync(
    createOrGetPreparedEvaluationSubmissionDraft(
      getDb(),
      preparedDraft({
        draft_id: "draft-002",
        payload_json: JSON.stringify({ schema_version: 1, candidate: "different body" }),
      }),
    ),
  );

  expect(next).toMatchObject({
    draft_id: "draft-002",
    lifecycle: "prepared",
    cloud_run_id: null,
  });
});

test("records a Cloud receipt exactly once and rejects a conflicting receipt", () => {
  Effect.runSync(createOrGetPreparedEvaluationSubmissionDraft(getDb(), preparedDraft()));

  const submitted = Effect.runSync(
    markEvaluationSubmissionDraftSubmitted(getDb(), {
      draft_id: "draft-001",
      cloud_run_id: "run-001",
      submitted_at: "2026-07-24T10:10:00.000Z",
    }),
  );
  const duplicate = Effect.runSync(
    markEvaluationSubmissionDraftSubmitted(getDb(), {
      draft_id: "draft-001",
      cloud_run_id: "run-001",
      submitted_at: "2026-07-24T10:11:00.000Z",
    }),
  );

  expect(submitted).toMatchObject({ lifecycle: "submitted", cloud_run_id: "run-001" });
  expect(duplicate).toMatchObject({ lifecycle: "submitted", cloud_run_id: "run-001" });
  expect(() =>
    Effect.runSync(
      markEvaluationSubmissionDraftSubmitted(getDb(), {
        draft_id: "draft-001",
        cloud_run_id: "run-002",
      }),
    ),
  ).toThrow("different Cloud run receipt");
});

test("stales a prepared draft without allowing submission afterward", () => {
  Effect.runSync(createOrGetPreparedEvaluationSubmissionDraft(getDb(), preparedDraft()));

  const stale = Effect.runSync(
    markEvaluationSubmissionDraftStale(getDb(), {
      draft_id: "draft-001",
      stale_at: "2026-07-24T10:15:00.000Z",
    }),
  );
  const repeated = Effect.runSync(
    markEvaluationSubmissionDraftStale(getDb(), {
      draft_id: "draft-001",
      stale_at: "2026-07-24T10:16:00.000Z",
    }),
  );

  expect(stale.lifecycle).toBe("stale");
  expect(repeated.updated_at).toBe("2026-07-24T10:15:00.000Z");
  expect(() =>
    Effect.runSync(
      markEvaluationSubmissionDraftSubmitted(getDb(), {
        draft_id: "draft-001",
        cloud_run_id: "run-001",
      }),
    ),
  ).toThrow("stale evaluation submission draft");
});

test("migrates and reopens durable drafts", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-evaluation-draft-"));
  const databasePath = join(root, "selftune.db");
  const first = openDb(databasePath);
  try {
    Effect.runSync(createOrGetPreparedEvaluationSubmissionDraft(first, preparedDraft()));
  } finally {
    first.close();
  }

  const reopened = openDb(databasePath);
  try {
    const draft = Effect.runSync(getEvaluationSubmissionDraft(reopened, "draft-001"));
    expect(draft).toMatchObject({
      draft_id: "draft-001",
      lifecycle: "prepared",
      skill_revision: revision,
    });
  } finally {
    reopened.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects malformed or oversized opaque payloads before persistence", () => {
  expect(() =>
    Effect.runSync(
      createOrGetPreparedEvaluationSubmissionDraft(
        getDb(),
        preparedDraft({ payload_json: "not-json" }),
      ),
    ),
  ).toThrow(/JSON Parse error|Unexpected/);
  expect(() =>
    Effect.runSync(
      createOrGetPreparedEvaluationSubmissionDraft(
        getDb(),
        preparedDraft({ payload_json: `"${"x".repeat(65_537)}"` }),
      ),
    ),
  ).toThrow();
});
