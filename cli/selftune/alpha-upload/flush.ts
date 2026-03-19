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
import { uploadPushPayload } from "./client.js";

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

  const summary: FlushSummary = { sent: 0, failed: 0, skipped: 0 };

  const items = queue.getPending(batchSize);

  if (items.length === 0) {
    return summary;
  }

  for (const item of items) {
    if (item.attempts >= maxRetries) {
      queue.markFailed(item.id, "exhausted retries");
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
      queue.markFailed(item.id, "corrupt payload JSON");
      summary.failed++;
      continue;
    }

    queue.markSending(item.id);

    let succeeded = false;
    const attemptsRemaining = maxRetries - item.attempts;

    for (let attempt = 0; attempt < attemptsRemaining; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
      }

      const result = await uploadPushPayload(payload, endpoint, apiKey);
      const status = getStatus(result as unknown as Record<string, unknown>);

      if (result.success) {
        queue.markSent(item.id);
        summary.sent++;
        succeeded = true;
        break;
      }

      // 409 Conflict = duplicate push_id, treat as success
      if (status === 409) {
        queue.markSent(item.id);
        summary.sent++;
        succeeded = true;
        break;
      }

      // Auth errors are non-retryable
      if (isAuthError(status)) {
        const authMessage =
          status === 401
            ? "Authentication failed: invalid or missing API key. Run 'selftune init --alpha --alpha-key <key>' to set your API key."
            : "Authorization denied: your API key does not have permission to upload. Contact support or verify your enrollment.";
        queue.markFailed(item.id, authMessage);
        summary.failed++;
        succeeded = true;
        break;
      }

      if (!isRetryable(status)) {
        queue.markFailed(item.id, result.errors[0]);
        summary.failed++;
        succeeded = true;
        break;
      }
    }

    if (!succeeded) {
      queue.markFailed(item.id, "exhausted retries");
      summary.failed++;
    }
  }

  return summary;
}
