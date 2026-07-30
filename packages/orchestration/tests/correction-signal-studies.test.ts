import { afterEach, expect, test } from "bun:test";

import {
  getCorrectionSignalCandidate,
  getCorrectionStudyDraft,
  getMeta,
  listCorrectionStudyDrafts,
  openDb,
} from "@selftune/local-store";
import type { ExplicitCorrectionSignal } from "@selftune/runtime/correction-study/signal-discovery";
import * as Effect from "effect/Effect";

import { captureCorrectionSignalStudies } from "../src/orchestrate/correction-signal-studies.js";

const databases: Array<ReturnType<typeof openDb>> = [];
const preRevision = "a".repeat(64);
const postRevision = "b".repeat(64);

function signal(
  candidateId: string,
  overrides: Partial<
    Pick<ExplicitCorrectionSignal, "review_status" | "evidence_level" | "reason">
  > = {},
): ExplicitCorrectionSignal {
  return {
    candidate_id: candidateId,
    kind: "explicit_correction_hypothesis",
    review_status: overrides.review_status ?? "review_required",
    dry_run: true,
    evidence_level: overrides.evidence_level ?? "E0.5",
    reason: overrides.reason ?? "invocation_hash_delta",
    skill: {
      name: "repair-skill",
      path: "[local-path-redacted]",
      pre_revision: preRevision,
      post_revision: postRevision,
    },
    source: {
      harness: "codex",
      session_id: `session-${candidateId}`,
      prompt_id: `prompt-${candidateId}`,
      skill_invocation_id: `invocation-${candidateId}`,
      raw_source_ref_digest: null,
    },
    raw_edit_digest: "a".repeat(64),
    raw_content_digests: { before: "c".repeat(64), after: "d".repeat(64) },
    deferred_skill_names: null,
    correlation_truncated: false,
    correction_intent: "Keep the fix bounded; token=raw-secret at /private/raw/session.json.",
    intent_detection: "heuristic",
    proves_causality: false,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

test("pages, persists idempotently, and defers revision-incomplete signals", async () => {
  const database = openDb(":memory:");
  databases.push(database);
  const valid = signal("signal-001");
  const deferred = {
    ...signal("signal-002", {
      review_status: "deferred",
      evidence_level: "E0",
      reason: "missing_revision_evidence",
    }),
    skill: { ...signal("signal-002").skill, post_revision: null },
  };
  let pages = 0;
  const discoverPage = () => {
    pages += 1;
    return pages === 1
      ? { items: [valid], next_cursor: "page-2" }
      : { items: [deferred], next_cursor: null };
  };

  const first = await captureCorrectionSignalStudies({
    database,
    discoverPage,
    now: () => "2026-07-29T12:00:00.000Z",
  });
  const second = await captureCorrectionSignalStudies({
    database,
    discoverPage: () => ({ items: [valid], next_cursor: null }),
    now: () => "2026-07-29T12:01:00.000Z",
  });

  expect(first).toEqual({ detected: 2, persisted: 2, drafted: 1, deferred: 1, errors: 0 });
  expect(second).toEqual({ detected: 1, persisted: 1, drafted: 1, deferred: 0, errors: 0 });
  expect(pages).toBe(2);
  expect(Effect.runSync(getCorrectionSignalCandidate(database, "signal-002"))).toMatchObject({
    lifecycle: "deferred",
    evidence_level: "E0",
  });
  expect(
    Effect.runSync(getCorrectionStudyDraft(database, "study-draft-" + "x".repeat(32))),
  ).toBeNull();
  const validCandidate = Effect.runSync(getCorrectionSignalCandidate(database, "signal-001"));
  expect(validCandidate?.created_at).toBe("2026-07-29T12:00:00.000Z");
  expect(validCandidate?.signal_payload_json).not.toContain("raw-secret");
  expect(validCandidate?.signal_payload_json).not.toContain("/private/raw/session.json");
  expect(validCandidate?.signal_payload_json).not.toContain("[local-path-redacted]");
  expect(validCandidate?.signal_payload_json).not.toContain("raw_content_digests");
  const [draft] = Effect.runSync(listCorrectionStudyDrafts(database));
  expect(draft?.study_payload_json).not.toContain("raw-secret");
  expect(draft?.study_payload_json).not.toContain("/private/raw/session.json");
});

test("records discovery errors without interrupting orchestration", async () => {
  const database = openDb(":memory:");
  databases.push(database);

  const summary = await captureCorrectionSignalStudies({
    database,
    discoverPage: () => {
      throw new Error("runtime correction source unavailable");
    },
  });

  expect(summary).toEqual({
    detected: 0,
    persisted: 0,
    drafted: 0,
    deferred: 0,
    errors: 1,
  });
});

test("advances a durable historical checkpoint without starving new live signals", async () => {
  const database = openDb(":memory:");
  databases.push(database);
  const latestFirst = signal("latest-first");
  const oldestFirst = signal("oldest-first");
  const olderFirst = signal("older-first");
  const oldestSecond = signal("oldest-second");
  const newerLive = signal("newer-live");
  const calls: Array<string | null> = [];

  const first = await captureCorrectionSignalStudies({
    database,
    discoverPage: (_database, input) => {
      calls.push(input.cursor ?? null);
      switch (input.cursor) {
        case null:
          return { items: [latestFirst], next_cursor: "history-1" };
        case "history-1":
          return { items: [oldestFirst], next_cursor: "history-2" };
        case "history-2":
          return { items: [olderFirst], next_cursor: "history-3" };
        default:
          throw new Error(`unexpected cursor ${input.cursor}`);
      }
    },
  });

  expect(first).toEqual({ detected: 3, persisted: 3, drafted: 3, deferred: 0, errors: 0 });
  expect(calls).toEqual([null, "history-1", "history-2"]);
  expect(getMeta(database, "orchestrate.correction-signal-history.v1")).toBe(
    JSON.stringify({ version: 1, state: "active", cursor: "history-3" }),
  );

  calls.length = 0;
  const second = await captureCorrectionSignalStudies({
    database,
    discoverPage: (_database, input) => {
      calls.push(input.cursor ?? null);
      switch (input.cursor) {
        case null:
          return { items: [newerLive], next_cursor: "history-1" };
        case "history-3":
          return { items: [oldestSecond], next_cursor: null };
        default:
          throw new Error(`unexpected cursor ${input.cursor}`);
      }
    },
  });

  expect(second).toEqual({ detected: 2, persisted: 2, drafted: 2, deferred: 0, errors: 0 });
  expect(calls).toEqual([null, "history-3"]);
  expect(Effect.runSync(getCorrectionSignalCandidate(database, "newer-live"))).not.toBeNull();
  expect(Effect.runSync(getCorrectionSignalCandidate(database, "oldest-second"))).not.toBeNull();
  expect(getMeta(database, "orchestrate.correction-signal-history.v1")).toBe(
    JSON.stringify({ version: 1, state: "complete", cursor: null }),
  );
});
