/**
 * Tests for alpha upload queue and watermark storage layer.
 *
 * Uses in-memory SQLite via openDb(":memory:") for isolation.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  enqueueUpload,
  getPendingUploads,
  getQueueStats,
  markFailed,
  markSending,
  markSent,
  readWatermark,
  writeWatermark,
} from "../../cli/selftune/alpha-upload/queue.js";
import { openDb } from "../../cli/selftune/localdb/db.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

// -- enqueueUpload ------------------------------------------------------------

describe("enqueueUpload", () => {
  test("inserts a pending item with correct fields", () => {
    const payload = JSON.stringify({ session_id: "s1", platform: "claude" });
    const ok = enqueueUpload(db, "session", payload);
    expect(ok).toBe(true);

    const row = db.query("SELECT * FROM upload_queue WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    expect(row).toBeTruthy();
    expect(row.payload_type).toBe("session");
    expect(row.payload_json).toBe(payload);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(typeof row.created_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
  });

  test("auto-increments id across multiple inserts", () => {
    enqueueUpload(db, "session", "{}");
    enqueueUpload(db, "invocation", "{}");
    enqueueUpload(db, "evolution", "{}");

    const rows = db.query("SELECT id FROM upload_queue ORDER BY id").all() as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

// -- getPendingUploads --------------------------------------------------------

describe("getPendingUploads", () => {
  test("returns only pending items, oldest first", () => {
    enqueueUpload(db, "session", '{"a":1}');
    enqueueUpload(db, "session", '{"a":2}');
    enqueueUpload(db, "invocation", '{"a":3}');

    // Mark first as sending so it's no longer pending
    markSending(db, [1]);

    const pending = getPendingUploads(db);
    expect(pending.length).toBe(2);
    expect(pending[0].id).toBe(2);
    expect(pending[1].id).toBe(3);
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      enqueueUpload(db, "session", `{"i":${i}}`);
    }
    const pending = getPendingUploads(db, 3);
    expect(pending.length).toBe(3);
    expect(pending[0].id).toBe(1);
  });

  test("returns empty array when no pending items", () => {
    const pending = getPendingUploads(db);
    expect(pending).toEqual([]);
  });
});

// -- markSending --------------------------------------------------------------

describe("markSending", () => {
  test("transitions pending items to sending", () => {
    enqueueUpload(db, "session", "{}");
    enqueueUpload(db, "session", "{}");

    const ok = markSending(db, [1, 2]);
    expect(ok).toBe(true);

    const rows = db.query("SELECT status FROM upload_queue ORDER BY id").all() as Array<{
      status: string;
    }>;
    expect(rows.every((r) => r.status === "sending")).toBe(true);
  });

  test("does not transition non-pending items", () => {
    enqueueUpload(db, "session", "{}");
    markSending(db, [1]);
    // Try to transition again (already sending)
    markSending(db, [1]);

    const row = db.query("SELECT status FROM upload_queue WHERE id = 1").get() as {
      status: string;
    };
    expect(row.status).toBe("sending");
  });
});

// -- markSent -----------------------------------------------------------------

describe("markSent", () => {
  test("transitions sending items to sent", () => {
    enqueueUpload(db, "session", "{}");
    markSending(db, [1]);

    const ok = markSent(db, [1]);
    expect(ok).toBe(true);

    const row = db.query("SELECT status FROM upload_queue WHERE id = 1").get() as {
      status: string;
    };
    expect(row.status).toBe("sent");
  });

  test("updates watermark to max id per payload_type", () => {
    enqueueUpload(db, "session", "{}");
    enqueueUpload(db, "session", "{}");
    enqueueUpload(db, "invocation", "{}");
    markSending(db, [1, 2, 3]);
    markSent(db, [1, 2, 3]);

    const sessionWm = readWatermark(db, "session");
    expect(sessionWm).toBe(2);

    const invocationWm = readWatermark(db, "invocation");
    expect(invocationWm).toBe(3);
  });

  test("does not advance the watermark for rows that were never sending", () => {
    enqueueUpload(db, "session", "{}");

    expect(markSent(db, [1])).toBe(true);
    expect(readWatermark(db, "session")).toBeNull();
  });
});

// -- markFailed ---------------------------------------------------------------

describe("markFailed", () => {
  test("transitions sending item to failed and records error", () => {
    enqueueUpload(db, "session", "{}");
    markSending(db, [1]);

    const ok = markFailed(db, 1, "network timeout");
    expect(ok).toBe(true);

    const row = db
      .query("SELECT status, attempts, last_error FROM upload_queue WHERE id = 1")
      .get() as { status: string; attempts: number; last_error: string };
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("network timeout");
  });

  test("increments attempts on repeated failures", () => {
    enqueueUpload(db, "session", "{}");

    // First failure cycle
    markSending(db, [1]);
    markFailed(db, 1, "error 1");

    // Reset to pending for retry, then fail again
    db.run("UPDATE upload_queue SET status = 'pending' WHERE id = 1");
    markSending(db, [1]);
    markFailed(db, 1, "error 2");

    const row = db.query("SELECT attempts, last_error FROM upload_queue WHERE id = 1").get() as {
      attempts: number;
      last_error: string;
    };
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe("error 2");
  });
});

// -- getQueueStats ------------------------------------------------------------

describe("getQueueStats", () => {
  test("returns counts by status", () => {
    enqueueUpload(db, "session", "{}");
    enqueueUpload(db, "session", "{}");
    enqueueUpload(db, "invocation", "{}");
    markSending(db, [1]);
    markSent(db, [1]);
    markSending(db, [2]);
    markFailed(db, 2, "err");

    const stats = getQueueStats(db);
    expect(stats.pending).toBe(1);
    expect(stats.sending).toBe(0);
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(1);
  });

  test("returns all zeros for empty queue", () => {
    const stats = getQueueStats(db);
    expect(stats).toEqual({ pending: 0, sending: 0, sent: 0, failed: 0 });
  });
});

// -- readWatermark / writeWatermark -------------------------------------------

describe("watermarks", () => {
  test("readWatermark returns null for unknown payload type", () => {
    const wm = readWatermark(db, "session");
    expect(wm).toBeNull();
  });

  test("writeWatermark inserts new watermark", () => {
    writeWatermark(db, "session", 42);
    const wm = readWatermark(db, "session");
    expect(wm).toBe(42);
  });

  test("writeWatermark upserts existing watermark", () => {
    writeWatermark(db, "session", 10);
    writeWatermark(db, "session", 50);
    const wm = readWatermark(db, "session");
    expect(wm).toBe(50);
  });

  test("watermarks are independent per payload_type", () => {
    writeWatermark(db, "session", 100);
    writeWatermark(db, "invocation", 200);
    writeWatermark(db, "evolution", 300);

    expect(readWatermark(db, "session")).toBe(100);
    expect(readWatermark(db, "invocation")).toBe(200);
    expect(readWatermark(db, "evolution")).toBe(300);
  });
});

// -- Schema validation --------------------------------------------------------

describe("schema", () => {
  test("upload_queue table exists with correct columns", () => {
    const cols = db.query("PRAGMA table_info(upload_queue)").all() as Array<{
      name: string;
      type: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("payload_type");
    expect(colNames).toContain("payload_json");
    expect(colNames).toContain("status");
    expect(colNames).toContain("attempts");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("last_error");
  });

  test("upload_watermarks table exists with correct columns", () => {
    const cols = db.query("PRAGMA table_info(upload_watermarks)").all() as Array<{
      name: string;
      type: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("payload_type");
    expect(colNames).toContain("last_uploaded_id");
    expect(colNames).toContain("updated_at");
  });

  test("indexes exist on upload_queue", () => {
    const indexes = db.query("PRAGMA index_list(upload_queue)").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_upload_queue_status");
    expect(indexNames).toContain("idx_upload_queue_type_status");
  });
});
