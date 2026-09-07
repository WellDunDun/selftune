import { existsSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import type {
  HarnessSourceAdapter,
  HarnessSourceProgressCallback,
  HarnessSourceSyncFailure,
  HarnessSourceSyncRequest,
  HarnessSourceSyncResult,
} from "@selftune/harness-core/source-adapter";
import { harnessSourceSyncFailure } from "@selftune/harness-core/source-adapter";
import { LocalTraceImporter } from "@selftune/observability";
import { CODEX_INGEST_MARKER, QUERY_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import { NORMALIZER_VERSION } from "@selftune/runtime/normalization";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
  type FileIngestionFingerprint,
} from "@selftune/runtime/utils/jsonl";

import {
  findRolloutFiles,
  findSkillNames,
  ingestFile,
  parseRolloutFileAsync,
  type ParsedRollout,
} from "./ingestors/codex-rollout.js";
import { buildLocalTelemetryBatchFromRollout } from "./ingestors/codex-trace-projection.js";

const adapterId = "codex";
const CODEX_SOURCE_PROJECTION_VERSION = "codex-source-v5";

const sourceFailure = (operation: string, cause: unknown) =>
  harnessSourceSyncFailure(adapterId, operation, cause);

const reportProgress = (onProgress: HarnessSourceProgressCallback | undefined, message: string) =>
  Effect.try({
    try: () => onProgress?.(message),
    catch: (cause) => sourceFailure("report Codex sync progress", cause),
  });

const ingestParsedRollout = Effect.fn("Codex.syncSource.ingestParsedRollout")(function* (
  parsed: ParsedRollout,
  fingerprint: FileIngestionFingerprint,
  request: HarnessSourceSyncRequest,
  onDryRunMessage: HarnessSourceProgressCallback,
): Effect.fn.Return<boolean, HarnessSourceSyncFailure, LocalTraceImporter> {
  const canonicalSucceeded = yield* Effect.try({
    try: () =>
      ingestFile(
        parsed,
        request.dryRun,
        QUERY_LOG,
        TELEMETRY_LOG,
        request.skillLogPath,
        undefined,
        onDryRunMessage,
      ),
    catch: (cause) => sourceFailure("write Codex canonical records", cause),
  });
  if (!canonicalSucceeded || request.dryRun) return canonicalSucceeded;

  const analyticalInput = yield* Effect.try({
    try: () => {
      const batch = buildLocalTelemetryBatchFromRollout(parsed);
      if (batch === null) return null;
      return {
        source_kind: "codex" as const,
        source_revision: `${CODEX_SOURCE_PROJECTION_VERSION}:${fingerprint.size}:${fingerprint.mtime_ms}`,
        normalizer_version: NORMALIZER_VERSION,
        batch,
      };
    },
    catch: (cause) => sourceFailure("prepare Codex analytical import", cause),
  });
  if (analyticalInput === null) return true;
  const importer = yield* LocalTraceImporter;
  yield* importer
    .importTrace(analyticalInput)
    .pipe(Effect.mapError((cause) => sourceFailure("import Codex analytical trace", cause)));
  return true;
});

/**
 * Imports authoritative Codex rollout files into the operational store and
 * the rebuildable analytical trace store. A file marker advances only after
 * both stores acknowledge its exact source revision.
 */
const makeSyncCodexSource = (markerPath: string) =>
  Effect.fn("Codex.syncSource")(function* (
    request: HarnessSourceSyncRequest,
    onProgress?: HarnessSourceProgressCallback,
  ): Effect.fn.Return<HarnessSourceSyncResult, HarnessSourceSyncFailure, LocalTraceImporter> {
    yield* reportProgress(onProgress, "scanning Codex rollouts...");
    const source = yield* Effect.try({
      try: () => {
        if (!existsSync(request.sourceRoot)) {
          return {
            available: false as const,
            rolloutFiles: [],
          };
        }
        const rolloutFiles = findRolloutFiles(request.sourceRoot, request.since);
        return {
          available: !(
            rolloutFiles.length === 0 && !existsSync(join(request.sourceRoot, "sessions"))
          ),
          rolloutFiles,
        };
      },
      catch: (cause) => sourceFailure("scan Codex rollouts", cause),
    });
    if (!source.available) {
      return {
        available: false,
        scanned: 0,
        synced: 0,
        skipped: 0,
        authoritativeFiles: [],
      };
    }

    const marker = yield* Effect.try({
      try: () => loadFileIngestionMarker(markerPath),
      catch: (cause) => sourceFailure("load Codex ingestion marker", cause),
    });
    const candidates = yield* Effect.try({
      try: () =>
        source.rolloutFiles.map((path) => ({
          path,
          fingerprint: fingerprintIngestionFile(
            path,
            `${NORMALIZER_VERSION}:${CODEX_SOURCE_PROJECTION_VERSION}`,
          ),
        })),
      catch: (cause) => sourceFailure("fingerprint Codex rollouts", cause),
    });
    const pending = request.force
      ? candidates
      : candidates.filter(
          ({ path, fingerprint }) => !isFileIngestionCurrent(marker, path, fingerprint),
        );
    yield* reportProgress(
      onProgress,
      `found ${source.rolloutFiles.length} rollouts, ${pending.length} pending`,
    );

    const skillNames = yield* Effect.try({
      try: () => findSkillNames(),
      catch: (cause) => sourceFailure("discover Codex skills", cause),
    });
    let markerChanged = false;
    let synced = 0;
    let skipped = 0;
    let processed = 0;
    const onDryRunMessage = onProgress ?? (() => {});

    for (const { path: rolloutFile, fingerprint } of pending) {
      // Parsing is explicitly asynchronous and yields every bounded byte
      // batch. This makes a large source replay interruptible instead of
      // trapping the desktop/CLI event loop in a long synchronous scan.
      const parsed = yield* Effect.tryPromise({
        try: (signal) => parseRolloutFileAsync(rolloutFile, skillNames, signal),
        catch: (cause) => sourceFailure("parse Codex rollout", cause),
      });
      if (parsed === null) {
        if (!request.dryRun) {
          marker.set(rolloutFile, fingerprint);
          markerChanged = true;
        }
        skipped += 1;
      } else {
        const ingested = yield* ingestParsedRollout(parsed, fingerprint, request, onDryRunMessage);
        if (!ingested) {
          skipped += 1;
          yield* reportProgress(
            onProgress,
            `database write failed; leaving ${rolloutFile} pending for retry`,
          );
        } else {
          if (!request.dryRun) {
            marker.set(rolloutFile, fingerprint);
            markerChanged = true;
          }
          synced += 1;
        }
      }
      processed += 1;
      if (processed % 100 === 0 || processed === pending.length) {
        yield* reportProgress(
          onProgress,
          `processed ${processed}/${pending.length} Codex rollouts`,
        );
      }
      yield* Effect.yieldNow;
    }

    if (!request.dryRun && markerChanged) {
      yield* Effect.try({
        try: () => saveFileIngestionMarker(markerPath, marker),
        catch: (cause) => sourceFailure("save Codex ingestion marker", cause),
      });
    }

    return {
      available: true,
      scanned: source.rolloutFiles.length,
      synced,
      skipped,
      authoritativeFiles: source.rolloutFiles,
    };
  });

export function makeCodexSourceAdapter(
  markerPath: string = CODEX_INGEST_MARKER,
): HarnessSourceAdapter<LocalTraceImporter> {
  return {
    id: adapterId,
    phase: "codex",
    sync: makeSyncCodexSource(markerPath),
  };
}

export const codexSourceAdapter = makeCodexSourceAdapter();
export const syncCodexSource = codexSourceAdapter.sync;
