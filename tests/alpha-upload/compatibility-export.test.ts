import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  flushCompatibilityExport,
  prepareCompatibilityExport,
} from "../../packages/runtime/alpha-upload/index.js";
import { enqueueUpload, getPendingUploads } from "../../packages/runtime/alpha-upload/queue.js";
import { openDb } from "../../packages/runtime/localdb/db.js";

let db: Database;
let originalFetch: typeof fetch;

function stageOneSession(database: Database): void {
  database.run(
    `INSERT INTO canonical_upload_staging
      (record_kind, record_id, record_json, session_id, staged_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "session",
      "compatibility-session",
      JSON.stringify({
        record_kind: "session",
        schema_version: "2.0",
        normalizer_version: "1.0.0",
        normalized_at: "2026-01-01T00:00:00.000Z",
        platform: "codex",
        capture_mode: "replay",
        source_session_kind: "interactive",
        raw_source_ref: {},
        session_id: "compatibility-session",
      }),
      "compatibility-session",
      new Date().toISOString(),
    ],
  );
}

function enqueueV2Envelope(database: Database): void {
  stageOneSession(database);
  const prepared = prepareCompatibilityExport(database, {
    enrolled: true,
    canonicalLogPath: "/does-not-exist.jsonl",
  });
  expect(prepared.enqueued).toBe(1);
}

function row(database: Database): {
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
} {
  const value = database
    .query("SELECT status, attempts, last_error, next_attempt_at FROM upload_queue WHERE id = 1")
    .get();
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    !("attempts" in value) ||
    !("last_error" in value) ||
    !("next_attempt_at" in value)
  ) {
    throw new Error("expected compatibility queue row");
  }
  const { status, attempts, last_error, next_attempt_at } = value;
  if (
    typeof status !== "string" ||
    typeof attempts !== "number" ||
    (last_error !== null && typeof last_error !== "string") ||
    (next_attempt_at !== null && typeof next_attempt_at !== "string")
  ) {
    throw new Error("invalid compatibility queue row");
  }
  return { status, attempts, last_error, next_attempt_at };
}

beforeEach(() => {
  db = openDb(":memory:");
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

describe("V2 compatibility-export queue lifecycle", () => {
  test("prepares locally while fetch is permanently unresolved", () => {
    stageOneSession(db);
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return new Promise<Response>(() => undefined);
    };

    const started = performance.now();
    const prepared = prepareCompatibilityExport(db, {
      enrolled: true,
      canonicalLogPath: "/does-not-exist.jsonl",
    });

    expect(performance.now() - started).toBeLessThan(100);
    expect(fetchCalls).toBe(0);
    expect(prepared.enqueued).toBe(1);
    expect(row(db)).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("persists retry backoff across restart and preserves transient failures", async () => {
    enqueueV2Envelope(db);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };

    const result = await flushCompatibilityExport(db, {
      enrolled: true,
      endpoint: "https://example.invalid/push",
    });
    expect(result.skipped).toBe(1);
    expect(row(db)).toMatchObject({ status: "pending", attempts: 1 });
    expect(row(db).last_error).toBe("compatibility_export:retryable_network");
    const nextAttemptAt = row(db).next_attempt_at;
    expect(nextAttemptAt).not.toBeNull();
    if (nextAttemptAt === null) throw new Error("retry timestamp was not persisted");

    // A fresh worker cannot hot-loop before the durable next-attempt time.
    expect(getPendingUploads(db, 50, new Date()).length).toBe(0);
    expect(getPendingUploads(db, 50, new Date(nextAttemptAt)).length).toBe(1);
  });

  test("records receiver rejection as a terminal failure", async () => {
    enqueueV2Envelope(db);
    globalThis.fetch = async () => new Response("invalid", { status: 400 });

    const result = await flushCompatibilityExport(db, {
      enrolled: true,
      endpoint: "https://example.invalid/push",
    });
    expect(result.failed).toBe(1);
    expect(row(db)).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
  });

  test("aborting an active fetch promptly returns its row to the persisted retry lifecycle", async () => {
    enqueueV2Envelope(db);
    const controller = new AbortController();
    globalThis.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });

    const pending = flushCompatibilityExport(db, {
      enrolled: true,
      endpoint: "https://example.invalid/push",
      signal: controller.signal,
    });
    controller.abort();
    expect((await pending).skipped).toBe(1);
    expect(row(db)).toMatchObject({ status: "pending", attempts: 1 });
    expect(row(db).next_attempt_at).not.toBeNull();
  });

  test("bounds the whole flush and leaves later queue rows untouched", async () => {
    enqueueV2Envelope(db);
    const payload = db.query("SELECT payload_json FROM upload_queue WHERE id = 1").get() as {
      payload_json: string;
    };
    expect(enqueueUpload(db, "push", payload.payload_json, 2)).toBe(true);
    globalThis.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });

    const startedAt = performance.now();
    const result = await flushCompatibilityExport(db, {
      enrolled: true,
      endpoint: "https://example.invalid/push",
      deadlineMs: 10,
    });

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(result.skipped).toBe(1);
    expect(db.query("SELECT status, attempts FROM upload_queue ORDER BY id").all()).toEqual([
      { status: "pending", attempts: 1 },
      { status: "pending", attempts: 0 },
    ]);
  });
});
