/**
 * Alpha upload queue — local queue and watermark storage layer.
 *
 * Queues payload items for upload to the alpha remote endpoint.
 * No HTTP code — this module only manages the SQLite queue state.
 *
 * All public functions follow the fail-open pattern from direct-write.ts:
 * they catch errors internally and return boolean success / safe defaults.
 */

import type { Database } from "bun:sqlite";

// -- Types --------------------------------------------------------------------

export interface QueueItem {
  id: number;
  payload_type: string;
  payload_json: string;
  status: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface QueueStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

// -- Queue operations ---------------------------------------------------------

/**
 * Insert a new pending item into the upload queue.
 * Returns true on success, false on failure (fail-open).
 */
export function enqueueUpload(db: Database, payloadType: string, payloadJson: string): boolean {
  try {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO upload_queue (payload_type, payload_json, status, attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
      [payloadType, payloadJson, now, now],
    );
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] enqueueUpload failed:", err);
    }
    return false;
  }
}

/**
 * Get pending upload items, oldest first.
 * Default limit is 50.
 */
export function getPendingUploads(db: Database, limit = 50): QueueItem[] {
  try {
    return db
      .query(
        `SELECT id, payload_type, payload_json, status, attempts, created_at, updated_at, last_error
         FROM upload_queue
         WHERE status = 'pending'
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(limit) as QueueItem[];
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] getPendingUploads failed:", err);
    }
    return [];
  }
}

/**
 * Transition pending items to sending status.
 * Only transitions items that are currently 'pending'.
 */
export function markSending(db: Database, ids: number[]): boolean {
  if (ids.length === 0) return true;
  try {
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    db.run(
      `UPDATE upload_queue
       SET status = 'sending', updated_at = ?
       WHERE id IN (${placeholders}) AND status = 'pending'`,
      [now, ...ids],
    );
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] markSending failed:", err);
    }
    return false;
  }
}

/**
 * Transition sending items to sent status.
 * Also updates the watermark per payload_type to the max id in the batch.
 */
export function markSent(db: Database, ids: number[]): boolean {
  if (ids.length === 0) return true;
  try {
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");

    db.run("BEGIN TRANSACTION");
    try {
      // Mark items as sent
      db.run(
        `UPDATE upload_queue
         SET status = 'sent', updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'sending'`,
        [now, ...ids],
      );

      // Update watermarks per payload_type — set to max id for each type
      const types = db
        .query(
          `SELECT payload_type, MAX(id) as max_id
           FROM upload_queue
           WHERE id IN (${placeholders})
           GROUP BY payload_type`,
        )
        .all(...ids) as Array<{ payload_type: string; max_id: number }>;

      for (const { payload_type, max_id } of types) {
        writeWatermark(db, payload_type, max_id);
      }

      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] markSent failed:", err);
    }
    return false;
  }
}

/**
 * Transition a sending item to failed status.
 * Increments the attempts counter and records the error message.
 */
export function markFailed(db: Database, id: number, error: string): boolean {
  try {
    const now = new Date().toISOString();
    db.run(
      `UPDATE upload_queue
       SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      [error, now, id],
    );
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] markFailed failed:", err);
    }
    return false;
  }
}

/**
 * Get counts of items by status.
 */
export function getQueueStats(db: Database): QueueStats {
  try {
    const row = db
      .query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
           COALESCE(SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END), 0) as sending,
           COALESCE(SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END), 0) as sent,
           COALESCE(SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END), 0) as failed
         FROM upload_queue`,
      )
      .get() as QueueStats;
    return row;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] getQueueStats failed:", err);
    }
    return { pending: 0, sending: 0, sent: 0, failed: 0 };
  }
}

// -- Watermark operations -----------------------------------------------------

/**
 * Read the last uploaded ID for a given payload type.
 * Returns null if no watermark exists.
 */
export function readWatermark(db: Database, payloadType: string): number | null {
  try {
    const row = db
      .query("SELECT last_uploaded_id FROM upload_watermarks WHERE payload_type = ?")
      .get(payloadType) as { last_uploaded_id: number } | null;
    return row?.last_uploaded_id ?? null;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] readWatermark failed:", err);
    }
    return null;
  }
}

/**
 * Upsert the watermark for a given payload type.
 */
export function writeWatermark(db: Database, payloadType: string, lastId: number): boolean {
  try {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO upload_watermarks (payload_type, last_uploaded_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(payload_type) DO UPDATE SET
         last_uploaded_id = excluded.last_uploaded_id,
         updated_at = excluded.updated_at`,
      [payloadType, lastId, now],
    );
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] writeWatermark failed:", err);
    }
    return false;
  }
}
