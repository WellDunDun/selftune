/**
 * Alpha upload orchestration module.
 *
 * Coordinates the full upload cycle:
 *   1. Read new rows since watermark from SQLite
 *   2. Build AlphaUploadEnvelope payloads
 *   3. Enqueue them in the local upload queue
 *   4. Flush the queue to the remote endpoint
 *
 * Guards:
 *   - Only runs when alpha enrolled (config.alpha?.enrolled === true)
 *   - Fail-open: never throws, returns empty summary on errors
 *   - Reads endpoint from config or SELFTUNE_ALPHA_ENDPOINT env var
 */

import type { Database } from "bun:sqlite";

import type { FlushSummary, QueueItem as ContractQueueItem, QueueOperations } from "../alpha-upload-contract.js";
import {
  buildSessionPayloads,
  buildInvocationPayloads,
  buildEvolutionPayloads,
} from "./build-payloads.js";
import { enqueueUpload, readWatermark, writeWatermark, getPendingUploads, markSending, markSent, markFailed } from "./queue.js";
import { flushQueue } from "./flush.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://alpha-ingest.selftune.dev/ingest";

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
}

export interface UploadCycleSummary {
  enrolled: boolean;
  prepared: number;
  sent: number;
  failed: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// prepareUploads — read new rows, build payloads, enqueue them
// ---------------------------------------------------------------------------

/**
 * Read new rows since watermark from SQLite, build payloads, and enqueue
 * them into the upload queue. Never throws.
 */
export function prepareUploads(
  db: Database,
  userId: string,
  agentType: string,
  selftuneVersion: string,
): PrepareResult {
  const result: PrepareResult = { enqueued: 0, types: [] };

  try {
    // -- Sessions ----------------------------------------------------------
    const sessionWm = readWatermark(db, "sessions") ?? undefined;
    const sessionBuild = buildSessionPayloads(
      db,
      userId,
      agentType,
      selftuneVersion,
      sessionWm,
    );
    if (sessionBuild) {
      const ok = enqueueUpload(
        db,
        "sessions",
        JSON.stringify(sessionBuild.envelope),
      );
      if (ok) {
        result.enqueued++;
        result.types.push("sessions");
        writeWatermark(db, "sessions", sessionBuild.lastId);
      }
    }

    // -- Invocations -------------------------------------------------------
    const invocationWm = readWatermark(db, "invocations") ?? undefined;
    const invocationBuild = buildInvocationPayloads(
      db,
      userId,
      agentType,
      selftuneVersion,
      invocationWm,
    );
    if (invocationBuild) {
      const ok = enqueueUpload(
        db,
        "invocations",
        JSON.stringify(invocationBuild.envelope),
      );
      if (ok) {
        result.enqueued++;
        result.types.push("invocations");
        writeWatermark(db, "invocations", invocationBuild.lastId);
      }
    }

    // -- Evolution ---------------------------------------------------------
    const evolutionWm = readWatermark(db, "evolution") ?? undefined;
    const evolutionBuild = buildEvolutionPayloads(
      db,
      userId,
      agentType,
      selftuneVersion,
      evolutionWm,
    );
    if (evolutionBuild) {
      const ok = enqueueUpload(
        db,
        "evolution",
        JSON.stringify(evolutionBuild.envelope),
      );
      if (ok) {
        result.enqueued++;
        result.types.push("evolution");
        writeWatermark(db, "evolution", evolutionBuild.lastId);
      }
    }
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload] prepareUploads failed:", err);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// runUploadCycle — the full cycle: prepare → flush → return summary
// ---------------------------------------------------------------------------

/**
 * Run a full upload cycle: read new data, enqueue it, flush to remote.
 * Guards on enrollment — returns empty summary if not enrolled.
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
    const endpoint =
      process.env.SELFTUNE_ALPHA_ENDPOINT ??
      options.endpoint ??
      DEFAULT_ENDPOINT;
    const dryRun = options.dryRun ?? false;

    // Step 1: Prepare — read new rows, build payloads, enqueue
    const prepared = prepareUploads(db, userId, agentType, selftuneVersion);

    // Step 2: Flush — drain the queue to the remote endpoint
    const queueOps: QueueOperations = {
      getPending: (limit: number) => getPendingUploads(db, limit) as ContractQueueItem[],
      markSending: (id: number) => { markSending(db, [id]); },
      markSent: (id: number) => { markSent(db, [id]); },
      markFailed: (id: number, error?: string) => { markFailed(db, id, error ?? "unknown"); },
    };

    const flush: FlushSummary = await flushQueue(queueOps, endpoint, {
      dryRun,
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
