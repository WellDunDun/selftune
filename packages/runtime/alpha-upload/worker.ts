/**
 * Bounded background worker for the legacy V2 compatibility exporter.
 *
 * Local ingestion only prepares and enqueues a payload. This worker owns the
 * later network attempt, so a slow or unavailable receiver never delays local
 * sync. It deliberately does not know about DuckDB or source ingestion.
 */

import type { FlushSummary } from "../alpha-upload-contract.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;

export interface CompatibilityExportFlushOptions {
  readonly signal: AbortSignal;
  readonly batchSize: number;
}

export type CompatibilityExportFlush = (
  options: CompatibilityExportFlushOptions,
) => Promise<FlushSummary>;

export interface CompatibilityExportTimer {
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (timer: unknown) => void;
}

export interface CompatibilityExportWorkerOptions {
  /** One bounded, remote-only queue attempt. It must preserve retryable rows. */
  readonly flush: CompatibilityExportFlush;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly timer?: CompatibilityExportTimer;
}

export type CompatibilityExportWorkerState = "stopped" | "idle" | "flushing" | "stopping";

export interface CompatibilityExportWorkerStatus {
  readonly state: CompatibilityExportWorkerState;
  readonly lastSummary: FlushSummary | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: string | null;
}

export interface CompatibilityExportWorker {
  /** Starts periodic export. Calling start more than once is safe. */
  start(): void;
  /** Requests an immediate attempt; concurrent callers share the same attempt. */
  requestFlush(): Promise<FlushSummary | null>;
  /** Cancels an in-flight request and waits for it to settle before returning. */
  stop(): Promise<void>;
  status(): CompatibilityExportWorkerStatus;
}

const emptySummary = (): FlushSummary => ({
  sent: 0,
  failed: 0,
  skipped: 0,
  skipped_unchanged: 0,
});

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isNativeTimer(value: unknown): value is ReturnType<typeof setTimeout> {
  return typeof value === "number" || (typeof value === "object" && value !== null);
}

/**
 * Owns no database handles and performs no queue mutations itself. This keeps
 * the operational SQLite queue as the only persistence boundary and lets the
 * daemon provide current credentials at flush time.
 */
export function createCompatibilityExportWorker(
  options: CompatibilityExportWorkerOptions,
): CompatibilityExportWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const timerApi: CompatibilityExportTimer = options.timer ?? {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (timer) => {
      if (isNativeTimer(timer)) clearTimeout(timer);
    },
  };

  let state: CompatibilityExportWorkerState = "stopped";
  let lastSummary: FlushSummary | null = null;
  let lastError: string | null = null;
  let nextAttemptAt: string | null = null;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let active: Promise<FlushSummary | null> | null = null;

  const clearScheduledAttempt = (): void => {
    if (timer !== null) {
      timerApi.cancel(timer);
      timer = null;
    }
    nextAttemptAt = null;
  };

  const scheduleNextAttempt = (): void => {
    if (state !== "idle") return;
    clearScheduledAttempt();
    nextAttemptAt = new Date(Date.now() + intervalMs).toISOString();
    timer = timerApi.schedule(() => {
      timer = null;
      nextAttemptAt = null;
      void requestFlush();
    }, intervalMs);
  };

  const requestFlush = (): Promise<FlushSummary | null> => {
    if (active !== null) return active;
    if (state !== "idle") return Promise.resolve(null);

    clearScheduledAttempt();
    state = "flushing";
    controller = new AbortController();
    const attemptController = controller;

    active = options
      .flush({ signal: attemptController.signal, batchSize })
      .then((summary) => {
        lastSummary = summary;
        lastError = null;
        return summary;
      })
      .catch((cause: unknown) => {
        // The queue implementation has already retained/released its row.
        // A worker boundary must not turn an interrupted network attempt into
        // a local-sync failure.
        lastError = errorMessage(cause);
        return emptySummary();
      })
      .finally(() => {
        active = null;
        controller = null;
        if (state === "flushing") {
          state = "idle";
          scheduleNextAttempt();
        }
      });

    return active;
  };

  return {
    start(): void {
      if (state !== "stopped") return;
      state = "idle";
      void requestFlush();
    },

    requestFlush,

    async stop(): Promise<void> {
      if (state === "stopped") return;
      clearScheduledAttempt();
      state = "stopping";
      controller?.abort();
      await active;
      state = "stopped";
      controller = null;
    },

    status(): CompatibilityExportWorkerStatus {
      return { state, lastSummary, lastError, nextAttemptAt };
    },
  };
}
