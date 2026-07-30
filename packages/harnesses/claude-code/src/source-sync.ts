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
import { LocalTraceImporter, LocalTraceImportRequest } from "@selftune/observability";
import { CLAUDE_CODE_MARKER, QUERY_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import { NORMALIZER_VERSION } from "@selftune/runtime/normalization";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
} from "@selftune/runtime/utils/jsonl";

import { findTranscriptFiles, parseSession, writeSession } from "./ingestors/claude-replay.js";
import { buildLocalTelemetryBatchFromSession } from "./ingestors/claude-trace-projection.js";

/**
 * Imports authoritative Claude Code transcripts into the operational store.
 *
 * A transcript is marked only after parsing or writing it has completed, so an
 * interrupted run leaves all unacknowledged source files retryable.
 */
const adapterId = "claude_code";
const CLAUDE_SOURCE_PROJECTION_VERSION = "claude-source-v2";

const sourceFailure = (operation: string, cause: unknown) =>
  harnessSourceSyncFailure(adapterId, operation, cause);

const reportProgress = (onProgress: HarnessSourceProgressCallback | undefined, message: string) =>
  Effect.try({
    try: () => onProgress?.(message),
    catch: (cause) => sourceFailure("report Claude Code sync progress", cause),
  });

const makeSyncClaudeCodeSource = (markerPath: string) =>
  Effect.fn("ClaudeCode.syncSource")(function* (
    request: HarnessSourceSyncRequest,
    onProgress?: HarnessSourceProgressCallback,
  ): Effect.fn.Return<HarnessSourceSyncResult, HarnessSourceSyncFailure, LocalTraceImporter> {
    yield* reportProgress(onProgress, "scanning Claude transcripts...");
    const source = yield* Effect.try({
      try: () => ({
        available: existsSync(request.sourceRoot),
        transcriptFiles: findTranscriptFiles(request.sourceRoot, request.since),
      }),
      catch: (cause) => sourceFailure("scan Claude transcripts", cause),
    });
    if (!source.available) {
      return { available: false, scanned: 0, synced: 0, skipped: 0, authoritativeFiles: [] };
    }

    const marker = yield* Effect.try({
      try: () => loadFileIngestionMarker(markerPath),
      catch: (cause) => sourceFailure("load Claude Code ingestion marker", cause),
    });
    const candidates = yield* Effect.try({
      try: () =>
        source.transcriptFiles.map((path) => ({
          path,
          fingerprint: fingerprintIngestionFile(
            path,
            `${NORMALIZER_VERSION}:${CLAUDE_SOURCE_PROJECTION_VERSION}`,
          ),
        })),
      catch: (cause) => sourceFailure("fingerprint Claude transcripts", cause),
    });
    const pending = request.force
      ? candidates
      : candidates.filter(
          ({ path, fingerprint }) => !isFileIngestionCurrent(marker, path, fingerprint),
        );
    yield* reportProgress(
      onProgress,
      `found ${source.transcriptFiles.length} transcripts, ${pending.length} pending`,
    );

    let markerChanged = false;
    let synced = 0;
    let skipped = 0;
    const onDryRunMessage = onProgress ?? (() => {});

    for (const { path: transcriptFile, fingerprint } of pending) {
      const parsed = yield* Effect.try({
        try: () => parseSession(transcriptFile),
        catch: (cause) => sourceFailure("parse Claude transcript", cause),
      });
      if (!parsed) {
        if (!request.dryRun) {
          marker.set(transcriptFile, fingerprint);
          markerChanged = true;
        }
        skipped += 1;
        continue;
      }

      yield* Effect.try({
        try: () =>
          writeSession(
            parsed,
            request.dryRun,
            QUERY_LOG,
            TELEMETRY_LOG,
            request.skillLogPath,
            undefined,
            onDryRunMessage,
          ),
        catch: (cause) => sourceFailure("write Claude Code canonical records", cause),
      });
      if (request.dryRun) {
        synced += 1;
        continue;
      }

      const importer = yield* LocalTraceImporter;
      const importRequest = LocalTraceImportRequest.make({
        source_kind: "claude_code",
        source_revision: `${CLAUDE_SOURCE_PROJECTION_VERSION}:${fingerprint.size}:${fingerprint.mtime_ms}`,
        normalizer_version: NORMALIZER_VERSION,
        batch: buildLocalTelemetryBatchFromSession(parsed),
      });
      yield* importer
        .importTrace(importRequest)
        .pipe(
          Effect.mapError((cause) => sourceFailure("import Claude Code analytical trace", cause)),
        );
      marker.set(transcriptFile, fingerprint);
      markerChanged = true;
      synced += 1;
    }

    if (!request.dryRun && markerChanged) {
      yield* Effect.try({
        try: () => saveFileIngestionMarker(markerPath, marker),
        catch: (cause) => sourceFailure("save Claude Code ingestion marker", cause),
      });
    }

    return {
      available: true,
      scanned: source.transcriptFiles.length,
      synced,
      skipped,
      authoritativeFiles: source.transcriptFiles,
    };
  });

export function makeClaudeCodeSourceAdapter(
  markerPath: string = CLAUDE_CODE_MARKER,
): HarnessSourceAdapter<LocalTraceImporter> {
  return { id: adapterId, phase: "claude", sync: makeSyncClaudeCodeSource(markerPath) };
}

export const claudeCodeSourceAdapter = makeClaudeCodeSourceAdapter();
export const syncClaudeCodeSource = claudeCodeSourceAdapter.sync;
