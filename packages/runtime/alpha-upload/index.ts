/* oxlint-disable no-console, no-await-in-loop -- ordered SQLite transitions preserve bounded queue ownership */
/**
 * Local V2 compatibility-export boundary.
 *
 * Preparation is strictly local SQLite work. Delivery is deliberately a
 * separate bounded remote attempt so harness sync never waits on credentials,
 * DNS, HTTP, or retry backoff.
 */

import type { Database } from "bun:sqlite";

import { PushPayloadV2Schema } from "@selftune/telemetry-contract";

import { DEFAULT_CLOUD_API_URL } from "../auth/device-code.js";
import { buildV2PushPayload } from "./build-payloads.js";
import { uploadPushPayload } from "./client.js";
import {
  enqueueUpload,
  getPendingUploads,
  markFailed,
  markRetryableFailure,
  markSending,
  markSent,
  readWatermark,
  reconcileStagingDelivery,
  recoverStaleSendingUploads,
  writeWatermark,
} from "./queue.js";
import { stageCanonicalRecords } from "./stage-canonical.js";

const DEFAULT_ENDPOINT = `${DEFAULT_CLOUD_API_URL}/api/v1/push`;
const MAX_RETRY_ATTEMPTS = 8;
const FLUSH_DEADLINE_MS = 30_000;

export interface PrepareResult {
  enqueued: number;
  types: string[];
  withheld_unsupported_platform: number;
}

/** Local-only inputs. Credentials and endpoint are intentionally absent. */
export interface CompatibilityExportPreparationOptions {
  enrolled: boolean;
  dryRun?: boolean;
  canonicalLogPath?: string;
}

/** Remote-delivery inputs, owned by the background export worker. */
export interface CompatibilityExportFlushOptions {
  enrolled: boolean;
  endpoint?: string;
  dryRun?: boolean;
  apiKey?: string;
  batchSize?: number;
  /** Whole-flush deadline; overridden only by focused tests and explicit manual callers. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

/** Legacy all-in-one options retained only for explicit callers. */
export interface UploadCycleOptions extends CompatibilityExportFlushOptions {
  userId?: string;
  agentType?: string;
  selftuneVersion?: string;
  canonicalLogPath?: string;
}

export interface UploadCycleSummary {
  enrolled: boolean;
  prepared: number;
  sent: number;
  failed: number;
  skipped: number;
}

function emptySummary(enrolled: boolean): UploadCycleSummary {
  return { enrolled, prepared: 0, sent: 0, failed: 0, skipped: 0 };
}

function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function persistedReason(kind: string): string {
  return `compatibility_export:${kind}`;
}

/**
 * Stage, validate, and enqueue deployed PushPayloadV2 envelopes.
 * This function does not resolve credentials, inspect environment endpoints,
 * or call fetch. A dry run is deliberately read-only.
 */
export function prepareCompatibilityExport(
  db: Database,
  options: CompatibilityExportPreparationOptions,
): PrepareResult {
  const result: PrepareResult = { enqueued: 0, types: [], withheld_unsupported_platform: 0 };
  if (!options.enrolled || options.dryRun) return result;

  try {
    stageCanonicalRecords(db, options.canonicalLogPath);
    const afterSeq =
      readWatermark(db, "staging_enqueued") ?? readWatermark(db, "staging_delivered") ?? 0;
    const build = buildV2PushPayload(db, afterSeq);
    if (!build) return result;

    db.transaction(() => {
      for (const withheld of build.withheld) {
        if (
          !writeWatermark(
            db,
            `withheld_unsupported_platform:${withheld.platform}`,
            withheld.lastSeq,
          )
        ) {
          throw new Error("writeWatermark withheld unsupported platform failed");
        }
        result.withheld_unsupported_platform += withheld.count;
      }

      if (build.emit) {
        if (!PushPayloadV2Schema.safeParse(build.payload).success) {
          throw new Error("refusing to enqueue a non-V2 payload");
        }
        if (!enqueueUpload(db, "push", JSON.stringify(build.payload), build.lastSeq)) {
          throw new Error("enqueueUpload failed");
        }
        result.enqueued = 1;
        result.types.push("canonical");
      }

      // A withheld record is terminal for this deployed V2 compatibility path,
      // so it must advance the local cursor and cannot block a later supported row.
      if (!writeWatermark(db, "staging_enqueued", build.lastSeq)) {
        throw new Error("writeWatermark staging_enqueued failed");
      }
      if (!writeWatermark(db, "canonical", build.lastSeq)) {
        throw new Error("writeWatermark canonical failed");
      }
    })();
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload] prepareCompatibilityExport failed:", err);
    }
  }
  return result;
}

/**
 * Make one bounded remote attempt for each currently pending V2 envelope.
 * Retryable failures return to pending with their attempt count persisted;
 * the worker schedules the next attempt and no inline backoff is performed.
 */
export async function flushCompatibilityExport(
  db: Database,
  options: CompatibilityExportFlushOptions,
): Promise<UploadCycleSummary> {
  const summary = emptySummary(options.enrolled);
  if (!options.enrolled) return summary;

  try {
    recoverStaleSendingUploads(db, new Date());
    const endpoint = process.env.SELFTUNE_ALPHA_ENDPOINT ?? options.endpoint ?? DEFAULT_ENDPOINT;
    const items = getPendingUploads(db, options.batchSize ?? 50);
    const flushSignal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.deadlineMs ?? FLUSH_DEADLINE_MS),
        ])
      : AbortSignal.timeout(options.deadlineMs ?? FLUSH_DEADLINE_MS);

    for (const item of items) {
      if (flushSignal.aborted) break;
      if (options.dryRun) {
        summary.skipped++;
        continue;
      }

      const decoded = (() => {
        try {
          return JSON.parse(item.payload_json) as unknown;
        } catch {
          return null;
        }
      })();
      const parsed = PushPayloadV2Schema.safeParse(decoded);
      if (!parsed.success) {
        if (markSending(db, [item.id])) {
          markFailed(db, item.id, persistedReason("invalid_v2_envelope"));
        }
        summary.failed++;
        continue;
      }
      if (!markSending(db, [item.id])) {
        summary.failed++;
        continue;
      }

      const upload = await uploadPushPayload(parsed.data, endpoint, options.apiKey, flushSignal);
      const status = upload._status ?? (upload.success ? 200 : 0);
      if (upload.success || status === 304 || status === 409) {
        if (markSent(db, [item.id])) summary.sent++;
        else summary.failed++;
      } else if (isRetryable(status) && item.attempts < MAX_RETRY_ATTEMPTS) {
        markRetryableFailure(
          db,
          item.id,
          persistedReason(status === 0 ? "retryable_network" : `retryable_http_${status}`),
        );
        summary.skipped++;
        if (flushSignal.aborted) break;
      } else {
        const kind = isRetryable(status) ? "retry_exhausted" : `permanent_http_${status}`;
        markFailed(db, item.id, persistedReason(kind));
        summary.failed++;
      }
    }
    reconcileStagingDelivery(db);
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[alpha-upload] flushCompatibilityExport failed:", err);
    }
  }
  return summary;
}

/**
 * Legacy local preparation API. It intentionally ignores identity parameters:
 * they were never part of the deployed PushPayloadV2 wire contract.
 */
export function prepareUploads(
  db: Database,
  _userId: string,
  _agentType: string,
  _selftuneVersion: string,
  canonicalLogPath?: string,
): PrepareResult {
  return prepareCompatibilityExport(db, { enrolled: true, canonicalLogPath });
}

/** Explicit backwards-compatible composition; normal sync calls preparation only. */
export async function runUploadCycle(
  db: Database,
  options: UploadCycleOptions,
): Promise<UploadCycleSummary> {
  const empty = emptySummary(options.enrolled);
  if (!options.enrolled) return empty;
  const prepared = prepareCompatibilityExport(db, {
    enrolled: true,
    dryRun: options.dryRun,
    canonicalLogPath: options.canonicalLogPath,
  });
  const flushed = await flushCompatibilityExport(db, options);
  return { ...flushed, prepared: prepared.enqueued };
}
