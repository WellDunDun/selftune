/**
 * Alpha upload orchestration module.
 *
 * Coordinates the full upload cycle:
 *   1. Stage canonical records from JSONL + evolution evidence into staging table
 *   2. Read new staged records since watermark via single cursor
 *   3. Build a V2 canonical push payload
 *   4. Enqueue it in the local upload queue
 *   5. Flush the queue to POST /api/v1/push
 *
 * Guards:
 *   - Only runs when alpha enrolled (config.alpha?.enrolled === true)
 *   - Fail-open: never throws, returns empty summary on errors
 *   - Reads endpoint from config or SELFTUNE_ALPHA_ENDPOINT env var
 */

import type { Database } from "bun:sqlite";

import type {
  QueueItem as ContractQueueItem,
  FlushSummary,
  QueueOperations,
} from "../alpha-upload-contract.js";
import { buildV2PushPayload } from "./build-payloads.js";
import { flushQueue } from "./flush.js";
import {
  enqueueUpload,
  getPendingUploads,
  markFailed,
  markSending,
  markSent,
  readWatermark,
  writeWatermark,
} from "./queue.js";
import { stageCanonicalRecords } from "./stage-canonical.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://api.selftune.dev/api/v1/push";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrepareResult {
  enqueued: number;
  types: string[];
}

export interface UploadCycleOptions {
  enrolled: boolean;
  userId?: string;
  agentType?: string;
  selftuneVersion?: string;
  endpoint?: string;
  dryRun?: boolean;
  apiKey?: string;
  /** Override canonical log path (for testing). */
  canonicalLogPath?: string;
}

export interface UploadCycleSummary {
  enrolled: boolean;
  prepared: number;
  sent: number;
  failed: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// prepareUploads -- stage, build V2 payload, enqueue
// ---------------------------------------------------------------------------

/**
 * Stage canonical records, read new staged rows since watermark,
 * build a single V2 push payload, and enqueue it. Never throws.
 */
export function prepareUploads(
  db: Database,
  _userId: string,
  _agentType: string,
  _selftuneVersion: string,
  canonicalLogPath?: string,
): PrepareResult {
  const result: PrepareResult = { enqueued: 0, types: [] };

  try {
    // Step 1: Stage canonical records from JSONL + evolution evidence
    stageCanonicalRecords(db, canonicalLogPath);

    // Step 2: Read watermark (single cursor for all record types)
    const afterSeq = readWatermark(db, "canonical") ?? undefined;

    // Step 3: Build payload from staging table
    const build = buildV2PushPayload(db, afterSeq);

    if (!build) return result;

    // Step 4: Enqueue the payload + advance watermark atomically
    const tx = db.transaction(() => {
      const ok = enqueueUpload(db, "push", JSON.stringify(build.payload));
      if (!ok) {
        throw new Error("enqueueUpload failed");
      }

      if (!writeWatermark(db, "canonical", build.lastSeq)) {
        throw new Error("writeWatermark failed");
      }

      result.enqueued = 1;
      result.types.push("canonical");
    });
    tx();
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload] prepareUploads failed:", err);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// runUploadCycle -- the full cycle: prepare -> flush -> return summary
// ---------------------------------------------------------------------------

/**
 * Run a full upload cycle: stage + read new data, enqueue it, flush to remote.
 * Guards on enrollment -- returns empty summary if not enrolled.
 * Never throws.
 */
export async function runUploadCycle(
  db: Database,
  options: UploadCycleOptions,
): Promise<UploadCycleSummary> {
  const emptySummary: UploadCycleSummary = {
    enrolled: options.enrolled,
    prepared: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  // Guard: must be enrolled
  if (!options.enrolled) {
    return emptySummary;
  }

  try {
    const userId = options.userId ?? "unknown";
    const agentType = options.agentType ?? "unknown";
    const selftuneVersion = options.selftuneVersion ?? "0.0.0";
    const endpoint = process.env.SELFTUNE_ALPHA_ENDPOINT ?? options.endpoint ?? DEFAULT_ENDPOINT;
    const dryRun = options.dryRun ?? false;
    const apiKey = options.apiKey;

    // Step 1: Prepare -- stage, build V2 payload, enqueue
    const prepared = prepareUploads(
      db,
      userId,
      agentType,
      selftuneVersion,
      options.canonicalLogPath,
    );

    // Step 2: Flush -- drain the queue to the remote endpoint
    const queueOps: QueueOperations = {
      getPending: (limit: number) => getPendingUploads(db, limit) as ContractQueueItem[],
      markSending: (id: number) => markSending(db, [id]),
      markSent: (id: number) => markSent(db, [id]),
      markFailed: (id: number, error?: string) => markFailed(db, id, error ?? "unknown"),
    };

    const flush: FlushSummary = await flushQueue(queueOps, endpoint, {
      dryRun,
      apiKey,
    });

    return {
      enrolled: true,
      prepared: prepared.enqueued,
      sent: flush.sent,
      failed: flush.failed,
      skipped: flush.skipped,
    };
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload] runUploadCycle failed:", err);
    }
    return emptySummary;
  }
}
