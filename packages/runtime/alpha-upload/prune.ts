import type { Database } from "bun:sqlite";

import {
  recoverStaleSendingUploads,
  reconcileStagingDelivery,
  STALE_SENDING_LEASE_MS,
} from "./queue.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SENT_RETENTION_DAYS = 7;
const FAILED_RETENTION_DAYS = 30;
const STAGING_RETENTION_DAYS = 7;

export interface UploadArtifactPruneCounts {
  readonly uploadQueue: {
    readonly sent: number;
    readonly failed: number;
    readonly total: number;
  };
  readonly canonicalUploadStaging: number;
}

export interface UploadArtifactMaintenanceCounts extends UploadArtifactPruneCounts {
  readonly recoveredSending: number;
}

/**
 * Recover interrupted uploads, reconcile a provable delivery watermark, then
 * delete only terminal artifacts whose staged data is known delivered.
 */
export function maintainUploadArtifacts(
  db: Database,
  now: Date,
  sendingLeaseMs = STALE_SENDING_LEASE_MS,
): UploadArtifactMaintenanceCounts {
  const recoveredSending = recoverStaleSendingUploads(db, now, sendingLeaseMs);
  reconcileStagingDelivery(db, now);
  return {
    ...pruneUploadArtifacts(db, now),
    recoveredSending,
  };
}

/**
 * Delete expired terminal upload queue artifacts and delivered canonical staging rows.
 * The staging watermark advances only through a contiguous sent queue prefix. Sent
 * rows above that prefix and failed staging-backed rows remain as delivery evidence.
 */
export function pruneUploadArtifacts(db: Database, now: Date): UploadArtifactPruneCounts {
  const sentCutoff = new Date(now.getTime() - SENT_RETENTION_DAYS * DAY_MS).toISOString();
  const failedCutoff = new Date(now.getTime() - FAILED_RETENTION_DAYS * DAY_MS).toISOString();
  const stagingCutoff = new Date(now.getTime() - STAGING_RETENTION_DAYS * DAY_MS).toISOString();

  return db.transaction(() => {
    const deliveredStaging = db
      .query(
        `SELECT last_uploaded_id
         FROM upload_watermarks
         WHERE payload_type = 'staging_delivered'`,
      )
      .get() as { last_uploaded_id: number } | null;
    const sent = db.run(
      `DELETE FROM upload_queue
       WHERE status = 'sent' AND updated_at < ?
         AND (
           staging_max_seq IS NULL
           OR (? IS NOT NULL AND staging_max_seq <= ?)
         )`,
      [
        sentCutoff,
        deliveredStaging?.last_uploaded_id ?? null,
        deliveredStaging?.last_uploaded_id ?? 0,
      ],
    ).changes;
    const failed = db.run(
      `DELETE FROM upload_queue
       WHERE status = 'failed' AND updated_at < ? AND staging_max_seq IS NULL`,
      [failedCutoff],
    ).changes;
    const canonicalUploadStaging =
      deliveredStaging === null
        ? 0
        : db.run(
            `DELETE FROM canonical_upload_staging
             WHERE staged_at < ? AND local_seq <= ?`,
            [stagingCutoff, deliveredStaging.last_uploaded_id],
          ).changes;

    return {
      uploadQueue: { sent, failed, total: sent + failed },
      canonicalUploadStaging,
    };
  })();
}
