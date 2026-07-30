import { existsSync } from "node:fs";

import { Effect } from "effect";

import type {
  HarnessSourceAdapter,
  HarnessSourceProgressCallback,
  HarnessSourceSyncFailure,
  HarnessSourceSyncRequest,
  HarnessSourceSyncResult,
} from "@selftune/harness-core/source-adapter";
import { harnessSourceSyncFailure } from "@selftune/harness-core/source-adapter";
import { LocalTraceImportRequest, LocalTraceImporter } from "@selftune/observability";
import { PI_INGEST_MARKER } from "@selftune/runtime/constants";
import { NORMALIZER_VERSION } from "@selftune/runtime/normalization";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
  type FileIngestionFingerprint,
} from "@selftune/runtime/utils/jsonl";

import {
  findPiSessions,
  findPiSkillNames,
  parsePiSession,
  writeSession,
} from "./ingestors/pi-ingest.js";
import { buildLocalTelemetryBatchFromPiSession } from "./ingestors/pi-trace-projection.js";

const adapterId = "pi";
const PI_SOURCE_PROJECTION_VERSION = "pi-source-v3";
const sourceFailure = (operation: string, cause: unknown) =>
  harnessSourceSyncFailure(adapterId, operation, cause);

const reportProgress = (onProgress: HarnessSourceProgressCallback | undefined, message: string) =>
  Effect.try({
    try: () => onProgress?.(message),
    catch: (cause) => sourceFailure("report Pi sync progress", cause),
  });

const ingestParsedSession = Effect.fn("Pi.syncSource.ingestParsedSession")(function* (
  session: ReturnType<typeof parsePiSession>,
  fingerprint: FileIngestionFingerprint,
  request: HarnessSourceSyncRequest,
  onDryRunMessage: HarnessSourceProgressCallback,
): Effect.fn.Return<void, HarnessSourceSyncFailure, LocalTraceImporter> {
  yield* Effect.try({
    try: () => writeSession(session, request.dryRun, onDryRunMessage),
    catch: (cause) => sourceFailure("write Pi canonical records", cause),
  });
  if (request.dryRun) return;

  const importer = yield* LocalTraceImporter;
  const importRequest = LocalTraceImportRequest.make({
    source_kind: "pi",
    source_revision: `${PI_SOURCE_PROJECTION_VERSION}:${fingerprint.size}:${fingerprint.mtime_ms}`,
    normalizer_version: NORMALIZER_VERSION,
    batch: buildLocalTelemetryBatchFromPiSession(session),
  });
  yield* importer
    .importTrace(importRequest)
    .pipe(Effect.mapError((cause) => sourceFailure("import Pi analytical trace", cause)));
});

const makeSyncPiSource = (markerPath: string) =>
  Effect.fn("Pi.syncSource")(function* (
    request: HarnessSourceSyncRequest,
    onProgress?: HarnessSourceProgressCallback,
  ): Effect.fn.Return<HarnessSourceSyncResult, HarnessSourceSyncFailure, LocalTraceImporter> {
    yield* reportProgress(onProgress, "scanning Pi sessions...");
    if (!existsSync(request.sourceRoot)) {
      return { available: false, scanned: 0, synced: 0, skipped: 0, authoritativeFiles: [] };
    }
    const sessions = yield* Effect.try({
      try: () => findPiSessions(request.sourceRoot, request.since?.getTime() ?? null),
      catch: (cause) => sourceFailure("scan Pi sessions", cause),
    });
    const marker = yield* Effect.try({
      try: () => loadFileIngestionMarker(markerPath),
      catch: (cause) => sourceFailure("load Pi ingestion marker", cause),
    });
    const candidates = yield* Effect.try({
      try: () =>
        sessions.map(({ filePath }) => ({
          path: filePath,
          fingerprint: fingerprintIngestionFile(
            filePath,
            `${NORMALIZER_VERSION}:${PI_SOURCE_PROJECTION_VERSION}`,
          ),
        })),
      catch: (cause) => sourceFailure("fingerprint Pi sessions", cause),
    });
    const pending = request.force
      ? candidates
      : candidates.filter(
          ({ path, fingerprint }) => !isFileIngestionCurrent(marker, path, fingerprint),
        );
    yield* reportProgress(
      onProgress,
      `found ${sessions.length} sessions, ${pending.length} pending`,
    );

    const skillNames = yield* Effect.try({
      try: () => findPiSkillNames(),
      catch: (cause) => sourceFailure("discover Pi skills", cause),
    });
    let markerChanged = false;
    let synced = 0;
    let skipped = 0;
    const onDryRunMessage = onProgress ?? (() => {});
    for (const { path, fingerprint } of pending) {
      const session = yield* Effect.try({
        try: () => parsePiSession(path, skillNames),
        catch: (cause) => sourceFailure("parse Pi session", cause),
      });
      if (!session.session_id || !session.timestamp) {
        if (!request.dryRun) {
          marker.set(path, fingerprint);
          markerChanged = true;
        }
        skipped += 1;
        continue;
      }
      yield* ingestParsedSession(session, fingerprint, request, onDryRunMessage);
      if (!request.dryRun) {
        marker.set(path, fingerprint);
        markerChanged = true;
      }
      synced += 1;
    }
    if (!request.dryRun && markerChanged) {
      yield* Effect.try({
        try: () => saveFileIngestionMarker(markerPath, marker),
        catch: (cause) => sourceFailure("save Pi ingestion marker", cause),
      });
    }
    return {
      available: true,
      scanned: sessions.length,
      synced,
      skipped,
      authoritativeFiles: sessions.map(({ filePath }) => filePath),
    };
  });

export function makePiSourceAdapter(
  markerPath: string = PI_INGEST_MARKER,
): HarnessSourceAdapter<LocalTraceImporter> {
  return { id: adapterId, phase: "pi", sync: makeSyncPiSource(markerPath) };
}

export const piSourceAdapter = makePiSourceAdapter();
export const syncPiSource = piSourceAdapter.sync;
