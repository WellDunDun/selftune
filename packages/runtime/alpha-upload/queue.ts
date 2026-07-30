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
  staging_max_seq: number | null;
  next_attempt_at: string | null;
}

export interface QueueStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

/** A sending row is retried after this lease expires. Duplicate pushes are idempotent. */
export const STALE_SENDING_LEASE_MS = 30 * 60 * 1_000;
const INITIAL_RETRY_BACKOFF_MS = 1_000;
const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1_000;

function retryBackoffMs(attempt: number): number {
  return Math.min(INITIAL_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_BACKOFF_MS);
}

// -- Queue operations ---------------------------------------------------------

/**
 * Insert a new pending item into the upload queue.
 * Returns true on success, false on failure (fail-open).
 */
export function enqueueUpload(
  db: Database,
  payloadType: string,
  payloadJson: string,
  stagingMaxSeq?: number,
): boolean {
  try {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO upload_queue
         (payload_type, payload_json, status, attempts, created_at, updated_at, staging_max_seq, next_attempt_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?, NULL)`,
      [payloadType, payloadJson, now, now, stagingMaxSeq ?? null],
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
export function getPendingUploads(db: Database, limit = 50, now = new Date()): QueueItem[] {
  try {
    return db
      .query(
        `SELECT id, payload_type, payload_json, status, attempts, created_at, updated_at, last_error,
                staging_max_seq, next_attempt_at
         FROM upload_queue
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(now.toISOString(), limit) as QueueItem[];
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
    const result = db.run(
      `UPDATE upload_queue
       SET status = 'sending', updated_at = ?, next_attempt_at = NULL
       WHERE id IN (${placeholders}) AND status = 'pending'`,
      [now, ...ids],
    );
    return result.changes === ids.length;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] markSending failed:", err);
    }
    return false;
  }
}

/**
 * Return expired in-flight rows to pending so a stopped local process cannot
 * permanently strand uploads. Attempts are intentionally unchanged: an
 * interrupted send is not a failed remote attempt, and the push endpoint
 * treats a replayed push as a duplicate success.
 */
export function recoverStaleSendingUploads(
  db: Database,
  now: Date,
  leaseMs = STALE_SENDING_LEASE_MS,
): number {
  try {
    const cutoff = new Date(now.getTime() - leaseMs).toISOString();
    return db.run(
      `UPDATE upload_queue
       SET status = 'pending', updated_at = ?, last_error = NULL, next_attempt_at = NULL
       WHERE status = 'sending' AND updated_at < ?`,
      [now.toISOString(), cutoff],
    ).changes;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] recoverStaleSendingUploads failed:", err);
    }
    return 0;
  }
}

interface WatermarkRow {
  last_uploaded_id: number;
}

interface QueueDeliveryRow {
  staging_max_seq: number;
  status: string;
}

function readWatermarkRow(db: Database, payloadType: string): WatermarkRow | null {
  return db
    .query("SELECT last_uploaded_id FROM upload_watermarks WHERE payload_type = ?")
    .get(payloadType) as WatermarkRow | null;
}

function outstandingLegacyQueueRows(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(*) as count
       FROM upload_queue
       WHERE staging_max_seq IS NULL AND status IN ('pending', 'sending')`,
    )
    .get() as { count: number };
  return row.count;
}

/**
 * Advance staging delivery through a contiguous sent queue prefix. Legacy
 * queue rows without staging_max_seq block this path only while in flight;
 * terminal legacy failures have no boundary and are superseded by a safely
 * replayed staged prefix.
 * a separate staging_enqueued cursor replays legacy staging safely instead of
 * treating the old canonical enqueue cursor as delivery evidence.
 */
export function reconcileStagingDelivery(db: Database, now = new Date()): number | null {
  try {
    return db.transaction(() => {
      if (outstandingLegacyQueueRows(db) > 0) {
        return readWatermarkRow(db, "staging_delivered")?.last_uploaded_id ?? null;
      }

      const deliveredBefore = readWatermarkRow(db, "staging_delivered")?.last_uploaded_id ?? 0;
      const remainingRows = db
        .query(
          `SELECT staging_max_seq, status
           FROM upload_queue
           WHERE staging_max_seq IS NOT NULL AND staging_max_seq > ?
           ORDER BY staging_max_seq ASC, id ASC`,
        )
        .all(deliveredBefore) as QueueDeliveryRow[];

      let deliveredAfter = deliveredBefore;
      for (const row of remainingRows) {
        if (row.status !== "sent") break;
        deliveredAfter = row.staging_max_seq;
      }

      if (deliveredAfter > deliveredBefore) {
        db.run(
          `INSERT INTO upload_watermarks (payload_type, last_uploaded_id, updated_at)
           VALUES ('staging_delivered', ?, ?)
           ON CONFLICT(payload_type) DO UPDATE SET
             last_uploaded_id = excluded.last_uploaded_id,
             updated_at = excluded.updated_at`,
          [deliveredAfter, now.toISOString()],
        );
      }

      return deliveredAfter > 0 ? deliveredAfter : null;
    })();
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] reconcileStagingDelivery failed:", err);
    }
    return null;
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
    let shouldReconcile = false;

    db.run("BEGIN TRANSACTION");
    try {
      const sendingRows = db
        .query(
          `SELECT id, payload_type, staging_max_seq
           FROM upload_queue
           WHERE id IN (${placeholders}) AND status = 'sending'`,
        )
        .all(...ids) as Array<{
        id: number;
        payload_type: string;
        staging_max_seq: number | null;
      }>;

      // Mark items as sent
      db.run(
        `UPDATE upload_queue
         SET status = 'sent', updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'sending'`,
        [now, ...ids],
      );

      // Update watermarks only for rows that actually transitioned from "sending".
      const maxByType = new Map<string, number>();
      for (const row of sendingRows) {
        const current = maxByType.get(row.payload_type) ?? 0;
        if (row.id > current) {
          maxByType.set(row.payload_type, row.id);
        }
      }

      for (const [payloadType, maxId] of maxByType.entries()) {
        db.run(
          `INSERT INTO upload_watermarks (payload_type, last_uploaded_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(payload_type) DO UPDATE SET
             last_uploaded_id = excluded.last_uploaded_id,
             updated_at = excluded.updated_at`,
          [payloadType, maxId, now],
        );
      }

      shouldReconcile = sendingRows.length > 0;

      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    if (shouldReconcile) {
      reconcileStagingDelivery(db, new Date(now));
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
       SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?, next_attempt_at = NULL
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
 * Record a transient delivery failure without discarding the durable item.
 * The next attempt time is persisted so process restart cannot turn retries
 * into an unbounded hot loop.
 */
export function markRetryableFailure(
  db: Database,
  id: number,
  error: string,
  now = new Date(),
): boolean {
  try {
    const row = db
      .query("SELECT attempts FROM upload_queue WHERE id = ? AND status = 'sending'")
      .get(id) as { attempts: number } | null;
    if (!row) return false;
    const attempt = row.attempts + 1;
    const updatedAt = now.toISOString();
    const nextAttemptAt = new Date(now.getTime() + retryBackoffMs(attempt)).toISOString();
    db.run(
      `UPDATE upload_queue
       SET status = 'pending', attempts = ?, last_error = ?, updated_at = ?, next_attempt_at = ?
       WHERE id = ? AND status = 'sending'`,
      [attempt, error, updatedAt, nextAttemptAt, id],
    );
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload/queue] markRetryableFailure failed:", err);
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
