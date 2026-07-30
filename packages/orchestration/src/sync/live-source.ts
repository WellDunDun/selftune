import type { Database } from "bun:sqlite";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { harnessSourceRegistry } from "@selftune/harness-registry/source";
import { getDb } from "@selftune/local-store";
import {
  LocalTraceImportFailure,
  LocalTraceImporter,
} from "@selftune/observability/local-trace-importer";
import { DuckDbAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";

import { syncSources } from "../sync.js";
import {
  establishHistoricalBackfillBoundaries,
  runHistoricalBackfill,
} from "../historical-backfill.js";
import { makeLocalTraceImporterLive } from "./local-trace-importer.js";
import type { SyncDeps, SyncOptions, SyncProgressCallback } from "./model.js";
import { syncInternalFailure } from "./services.js";

const inactiveLocalTraceImporter = LocalTraceImporter.of({
  importTrace: () =>
    Effect.fail(
      LocalTraceImportFailure.make({
        operation: "import local trace",
        message: "Local trace analytics are inactive for this source-sync run.",
      }),
    ),
});

const InactiveLocalTraceImporterLive = Layer.succeed(
  LocalTraceImporter,
  inactiveLocalTraceImporter,
);

/**
 * Production composition for source sync. Keeping the aggregate source
 * registry here prevents imports of the generic sync program from eagerly
 * loading every harness parser.
 */
export const syncSourcesLive = Effect.fn("selftune.orchestration.sync.liveSource")(function* (
  options: SyncOptions,
  deps: SyncDeps<LocalTraceImporter> = {},
  onProgress?: SyncProgressCallback,
  db?: Database,
) {
  const liveDeps: SyncDeps<LocalTraceImporter> = {
    ...deps,
    sourceRegistry: deps.sourceRegistry ?? harnessSourceRegistry,
  };
  const database =
    db ??
    (yield* Effect.try({
      try: getDb,
      catch: (cause) => syncInternalFailure("open source-sync database", cause),
    }));
  const requiresTraceAnalytics =
    !options.dryRun &&
    (options.syncClaude || options.syncCodex || options.syncOpenCode || options.syncPi);
  const traceImporterLayer = requiresTraceAnalytics
    ? Layer.provide(makeLocalTraceImporterLive(database), DuckDbAnalyticalStoreLive)
    : InactiveLocalTraceImporterLive;
  return yield* Effect.gen(function* () {
    // Snapshot the historical cohort before any harness can write newly found
    // source rows. The later bounded pass only reads at or below this mark.
    if (requiresTraceAnalytics) {
      yield* establishHistoricalBackfillBoundaries(database).pipe(
        Effect.mapError((error) =>
          syncInternalFailure("establish historical backfill boundary", error),
        ),
      );
    }
    const result = yield* syncSources(options, liveDeps, onProgress, database);
    if (!requiresTraceAnalytics) return result;

    yield* Effect.try({
      try: () => onProgress?.("backfilling historical trace metadata..."),
      catch: (cause) => syncInternalFailure("report historical backfill progress", cause),
    });
    const startedAt = performance.now();
    const backfill = yield* runHistoricalBackfill(database, { maxBatches: 32 });
    const elapsedMs = Math.round(performance.now() - startedAt);
    yield* Effect.try({
      try: () =>
        onProgress?.(
          `backfilled ${backfill.source_rows_seen} historical rows across ${backfill.batches_read} bounded pages`,
        ),
      catch: (cause) => syncInternalFailure("report historical backfill progress", cause),
    });
    return {
      ...result,
      timings: [...result.timings, { phase: "historical_backfill", elapsed_ms: elapsedMs }],
      total_elapsed_ms: result.total_elapsed_ms + elapsedMs,
    };
  }).pipe(Effect.provide(traceImporterLayer), Effect.scoped);
});
