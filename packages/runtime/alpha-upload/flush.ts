/**
 * Alpha upload flush engine.
 *
 * Drains the local upload queue by reading pending items, uploading
 * them via the HTTP client, and updating their status. Implements
 * retry with exponential backoff for transient (5xx/network) failures.
 *
 * Special status handling:
 *   - 409 (duplicate push_id) is treated as success
 *   - 401/403 (auth failures) are non-retryable with descriptive errors
 *   - 4xx (client errors) are not retried
 */

import type { FlushSummary, QueueOperations } from "../alpha-upload-contract.js";
import { headRecord, uploadPushPayload } from "./client.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for the flush engine. */
export interface FlushOptions {
  /** Maximum number of items to read per flush batch (default: 50). */
  batchSize?: number;
  /** Maximum upload attempts per item before marking permanently failed (default: 5). */
  maxRetries?: number;
  /** When true, log what would be sent without making HTTP calls (default: false). */
  dryRun?: boolean;
  /** API key for Bearer auth on the cloud endpoint. */
  apiKey?: string;
  /** When set, run HEAD checks against this endpoint before pushing. */
  headCheckEndpoint?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true for HTTP status codes that are transient and worth retrying. */
function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** Returns true for auth errors that should not be retried. */
function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calculate exponential backoff with cap. */
function backoffMs(attempt: number): number {
  const ms = INITIAL_BACKOFF_MS * 2 ** attempt;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/** Extract HTTP status from result. */
function getStatus(result: Record<string, unknown>): number {
  return (result as { _status?: number })._status ?? (result.success ? 200 : 0);
}

// ---------------------------------------------------------------------------
// Flush engine
// ---------------------------------------------------------------------------

/**
 * Flush the upload queue -- read pending items, upload them, update status.
 */
export async function flushQueue(
  queue: QueueOperations,
  endpoint: string,
  options?: FlushOptions,
): Promise<FlushSummary> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const dryRun = options?.dryRun ?? false;
  const apiKey = options?.apiKey;
  const headCheckEndpoint = options?.headCheckEndpoint;

  const summary: FlushSummary = { sent: 0, failed: 0, skipped: 0, skipped_unchanged: 0 };

  const items = queue.getPending(batchSize);

  if (items.length === 0) {
    return summary;
  }

  // -- HEAD check phase: identify records that already exist unchanged ------
  const unchangedIds = new Set<number>();
  if (headCheckEndpoint) {
    const headChecks = items.map(async (item) => {
      try {
        const parsed = JSON.parse(item.payload_json) as { push_id?: string };
        const pushId = parsed.push_id;
        if (!pushId) return { id: item.id, skip: false };
        const result = await headRecord(headCheckEndpoint, pushId, undefined, apiKey);
        return { id: item.id, skip: result.exists && result.unchanged };
      } catch {
        // Fail-open: if HEAD check itself errors, don't skip
        return { id: item.id, skip: false };
      }
    });

    const results = await Promise.allSettled(headChecks);
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.skip) {
        unchangedIds.add(result.value.id);
      }
    }

    // Mark unchanged items as sent in the queue without actually pushing
    for (const item of items) {
      if (unchangedIds.has(item.id)) {
        if (!queue.markSending(item.id)) continue;
        if (queue.markSent(item.id)) {
          summary.skipped_unchanged++;
        } else {
          summary.failed++;
        }
      }
    }
  }

  for (const item of items) {
    if (unchangedIds.has(item.id)) continue;
    const markFailedSafely = (message: string): void => {
      if (!queue.markFailed(item.id, message)) {
        console.error(`[alpha upload] Failed to persist queue failure state for item ${item.id}`);
      }
    };

    if (item.attempts >= maxRetries) {
      markFailedSafely("exhausted retries");
      summary.failed++;
      continue;
    }

    if (dryRun) {
      summary.skipped++;
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(item.payload_json) as Record<string, unknown>;
    } catch {
      markFailedSafely("corrupt payload JSON");
      summary.failed++;
      continue;
    }

    if (!queue.markSending(item.id)) {
      console.error(`[alpha upload] Failed to mark queue item ${item.id} as sending`);
      summary.failed++;
      continue;
    }

    let succeeded = false;
    const attemptsRemaining = maxRetries - item.attempts;

    for (let attempt = 0; attempt < attemptsRemaining; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
      }

      const result = await uploadPushPayload(payload, endpoint, apiKey);
      const status = getStatus(result as unknown as Record<string, unknown>);

      if (result.success) {
        if (!queue.markSent(item.id)) {
          markFailedSafely("local queue state update failed after successful upload");
          summary.failed++;
        } else {
          summary.sent++;
        }
        succeeded = true;
        break;
      }

      // 304 Not Modified = content unchanged (dedup), 409 Conflict = duplicate push_id
      // Both are treated as success — the server already has this data.
      if (status === 304 || status === 409) {
        if (!queue.markSent(item.id)) {
          markFailedSafely("local queue state update failed after duplicate/unchanged upload");
          summary.failed++;
        } else {
          summary.sent++;
        }
        succeeded = true;
        break;
      }

      // Auth errors are non-retryable
      if (isAuthError(status)) {
        const authMessage =
          status === 401
            ? "Authentication failed: invalid or missing API key. Run 'selftune init --alpha --alpha-email <email>' to re-authenticate via browser."
            : "Authorization denied: your API key does not have permission to upload. Run 'selftune doctor' to verify enrollment and cloud link, then re-run 'selftune init --alpha --alpha-email <email> --force' to re-authenticate.";
        markFailedSafely(authMessage);
        summary.failed++;
        succeeded = true;
        break;
      }

      if (!isRetryable(status)) {
        markFailedSafely(result.errors[0] ?? `Upload failed with HTTP ${status}`);
        summary.failed++;
        succeeded = true;
        break;
      }
    }

    if (!succeeded) {
      markFailedSafely("exhausted retries");
      summary.failed++;
    }
  }

  return summary;
}
