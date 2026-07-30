import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  maintainUploadArtifacts,
  pruneUploadArtifacts,
} from "../../packages/runtime/alpha-upload/prune.js";
import {
  enqueueUpload,
  markSending,
  markSent,
  readWatermark,
  recoverStaleSendingUploads,
  reconcileStagingDelivery,
  writeWatermark,
} from "../../packages/runtime/alpha-upload/queue.js";
import { openDb } from "../../packages/runtime/localdb/db.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");

let db: Database;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function insertQueueRow(status: string, updatedAt: string): void {
  db.run(
    `INSERT INTO upload_queue
       (payload_type, payload_json, status, attempts, created_at, updated_at)
     VALUES ('push', '{}', ?, 0, ?, ?)`,
    [status, updatedAt, updatedAt],
  );
}

function insertStagingRow(localSeq: number, stagedAt: string): void {
  db.run(
    `INSERT INTO canonical_upload_staging
       (local_seq, record_kind, record_id, record_json, staged_at)
     VALUES (?, 'session', ?, '{}', ?)`,
    [localSeq, `session-${localSeq}`, stagedAt],
  );
}

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("upload artifact pruning", () => {
  test("deletes only expired sent and failed queue rows", () => {
    insertQueueRow("sent", daysAgo(8));
    insertQueueRow("sent", daysAgo(7));
    insertQueueRow("sent", daysAgo(6));
    insertQueueRow("failed", daysAgo(31));
    insertQueueRow("failed", daysAgo(30));
    insertQueueRow("failed", daysAgo(29));
    insertQueueRow("pending", daysAgo(90));
    insertQueueRow("sending", daysAgo(90));

    const counts = pruneUploadArtifacts(db, NOW);

    expect(counts).toEqual({
      uploadQueue: { sent: 1, failed: 1, total: 2 },
      canonicalUploadStaging: 0,
    });
    expect(db.query("SELECT status, updated_at FROM upload_queue ORDER BY id").all()).toEqual([
      { status: "sent", updated_at: daysAgo(7) },
      { status: "sent", updated_at: daysAgo(6) },
      { status: "failed", updated_at: daysAgo(30) },
      { status: "failed", updated_at: daysAgo(29) },
      { status: "pending", updated_at: daysAgo(90) },
      { status: "sending", updated_at: daysAgo(90) },
    ]);
  });

  test("deletes only staging rows at or below the delivered mark that are older than 7 days", () => {
    insertStagingRow(1, daysAgo(60));
    insertStagingRow(2, daysAgo(7));
    insertStagingRow(3, daysAgo(1));
    insertStagingRow(4, daysAgo(60));
    db.run(
      `INSERT INTO upload_watermarks (payload_type, last_uploaded_id, updated_at)
       VALUES ('staging_delivered', 3, ?)`,
      NOW.toISOString(),
    );

    const counts = pruneUploadArtifacts(db, NOW);

    expect(counts.canonicalUploadStaging).toBe(1);
    expect(
      db.query("SELECT local_seq FROM canonical_upload_staging ORDER BY local_seq").all(),
    ).toEqual([{ local_seq: 2 }, { local_seq: 3 }, { local_seq: 4 }]);
  });

  test("does not treat the enqueue cursor as proof of delivery", () => {
    insertStagingRow(1, daysAgo(60));
    db.run(
      `INSERT INTO upload_watermarks (payload_type, last_uploaded_id, updated_at)
       VALUES ('canonical', 1, ?)`,
      NOW.toISOString(),
    );

    const counts = pruneUploadArtifacts(db, NOW);

    expect(counts.canonicalUploadStaging).toBe(0);
    expect(db.query("SELECT local_seq FROM canonical_upload_staging").all()).toEqual([
      { local_seq: 1 },
    ]);
  });

  test("keeps undelivered legacy staging when an old queue row is still sending", () => {
    insertStagingRow(1, daysAgo(60));
    writeWatermark(db, "canonical", 1);
    enqueueUpload(db, "push", "{}");
    markSending(db, [1]);

    const counts = maintainUploadArtifacts(db, NOW, 24 * 60 * 60 * 1_000);

    expect(counts.canonicalUploadStaging).toBe(0);
    expect(readWatermark(db, "staging_delivered")).toBeNull();
    expect(db.query("SELECT status FROM upload_queue WHERE id = 1").get()).toEqual({
      status: "sending",
    });
  });

  test("does not promote a legacy canonical cursor after surviving legacy rows are sent", () => {
    insertStagingRow(1, daysAgo(60));
    insertStagingRow(2, daysAgo(60));
    writeWatermark(db, "canonical", 2);
    enqueueUpload(db, "push", "{}");
    markSending(db, [1]);
    markSent(db, [1]);

    expect(readWatermark(db, "staging_delivered")).toBeNull();

    const beforeBackfill = pruneUploadArtifacts(db, NOW);
    expect(beforeBackfill.canonicalUploadStaging).toBe(0);

    // A new staged payload is the first safe delivery proof for the legacy
    // prefix. Its max sequence establishes an explicit staged boundary.
    enqueueUpload(db, "push", "{}", 2);
    markSending(db, [2]);
    markSent(db, [2]);

    expect(readWatermark(db, "staging_delivered")).toBe(2);
    const afterBackfill = pruneUploadArtifacts(db, NOW);
    expect(afterBackfill.canonicalUploadStaging).toBe(2);
  });

  test("does not let a newly sent staged payload jump over a legacy sending row", () => {
    insertStagingRow(1, daysAgo(60));
    insertStagingRow(2, daysAgo(60));
    enqueueUpload(db, "push", "{}");
    enqueueUpload(db, "push", "{}", 2);
    markSending(db, [1, 2]);
    markSent(db, [2]);

    expect(reconcileStagingDelivery(db, NOW)).toBeNull();
    expect(readWatermark(db, "staging_delivered")).toBeNull();
  });

  test("lets a safely replayed staged prefix supersede a failed legacy row", () => {
    insertStagingRow(1, daysAgo(60));
    insertQueueRow("failed", daysAgo(31));
    enqueueUpload(db, "push", "{}", 1);
    markSending(db, [2]);
    markSent(db, [2]);

    expect(readWatermark(db, "staging_delivered")).toBe(1);

    const counts = pruneUploadArtifacts(db, NOW);
    expect(counts).toEqual({
      uploadQueue: { sent: 0, failed: 1, total: 1 },
      canonicalUploadStaging: 1,
    });
  });

  test("recovers only sending rows whose lease expired", () => {
    insertQueueRow("sending", daysAgo(1));
    insertQueueRow("sending", daysAgo(0));

    const recovered = recoverStaleSendingUploads(db, NOW, 30 * 60 * 1_000);

    expect(recovered).toBe(1);
    expect(db.query("SELECT status FROM upload_queue ORDER BY id").all()).toEqual([
      { status: "pending" },
      { status: "sending" },
    ]);
  });

  test("keeps the delivered mark after its sent queue row is pruned", () => {
    insertStagingRow(10, daysAgo(60));
    expect(enqueueUpload(db, "push", "{}", 10)).toBe(true);
    expect(markSending(db, [1])).toBe(true);
    expect(markSent(db, [1])).toBe(true);
    db.run("UPDATE upload_queue SET updated_at = ? WHERE id = 1", [daysAgo(8)]);

    const counts = pruneUploadArtifacts(db, NOW);

    expect(counts).toEqual({
      uploadQueue: { sent: 1, failed: 0, total: 1 },
      canonicalUploadStaging: 1,
    });
    expect(readWatermark(db, "staging_delivered")).toBe(10);
    expect(db.query("SELECT id FROM upload_queue").all()).toEqual([]);
    expect(db.query("SELECT local_seq FROM canonical_upload_staging").all()).toEqual([]);
  });

  test("retains out-of-order sent rows and staging until the delivery gap closes", () => {
    insertStagingRow(10, daysAgo(60));
    insertStagingRow(20, daysAgo(60));
    enqueueUpload(db, "push", "{}", 10);
    enqueueUpload(db, "push", "{}", 20);
    markSending(db, [2]);
    markSent(db, [2]);
    db.run("UPDATE upload_queue SET updated_at = ? WHERE id = 2", [daysAgo(8)]);

    const blockedCounts = pruneUploadArtifacts(db, NOW);

    expect(blockedCounts.canonicalUploadStaging).toBe(0);
    expect(readWatermark(db, "staging_delivered")).toBeNull();
    expect(db.query("SELECT id FROM upload_queue ORDER BY id").all()).toEqual([
      { id: 1 },
      { id: 2 },
    ]);

    markSending(db, [1]);
    markSent(db, [1]);
    db.run("UPDATE upload_queue SET updated_at = ?", [daysAgo(8)]);

    const deliveredCounts = pruneUploadArtifacts(db, NOW);

    expect(deliveredCounts.canonicalUploadStaging).toBe(2);
    expect(deliveredCounts.uploadQueue.sent).toBe(2);
    expect(readWatermark(db, "staging_delivered")).toBe(20);
  });

  test("retains expired failed staging-backed queue rows as delivery blockers", () => {
    insertStagingRow(10, daysAgo(60));
    enqueueUpload(db, "push", "{}", 10);
    markSending(db, [1]);
    db.run(
      `UPDATE upload_queue
       SET status = 'failed', attempts = 1, updated_at = ?
       WHERE id = 1`,
      [daysAgo(31)],
    );

    const counts = pruneUploadArtifacts(db, NOW);

    expect(counts.uploadQueue.failed).toBe(0);
    expect(counts.canonicalUploadStaging).toBe(0);
    expect(db.query("SELECT id, status FROM upload_queue").all()).toEqual([
      { id: 1, status: "failed" },
    ]);
  });
});
