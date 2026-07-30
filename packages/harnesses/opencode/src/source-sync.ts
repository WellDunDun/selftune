import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
import { OPENCODE_INGEST_MARKER, QUERY_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import { NORMALIZER_VERSION } from "@selftune/runtime/normalization";

import {
  findSkillNames,
  readSessionsFromJsonFiles,
  readSessionsFromSqlite,
  type ParsedSession,
  writeSession,
} from "./ingestors/opencode-ingest.js";
import { buildLocalTelemetryBatchFromOpenCode } from "./ingestors/opencode-trace-projection.js";

const adapterId = "opencode";
const OPENCODE_SOURCE_PROJECTION_VERSION = "opencode-source-v6";

interface SessionRevisionMarker {
  readonly marker_version: 6;
  readonly sessions: Readonly<Record<string, string>>;
  readonly source_fingerprint?: string;
  readonly scanned_sessions?: number;
}

interface LoadedSessionRevisions {
  readonly revisions: Map<string, string>;
  readonly sourceFingerprint?: string;
  readonly scannedSessions: number;
}

function sourceFailure(operation: string, cause: unknown): HarnessSourceSyncFailure {
  return harnessSourceSyncFailure(adapterId, operation, cause);
}

function stableRevision(session: ParsedSession): string {
  const normalizedFacts = JSON.stringify({
    session_id: session.session_id,
    timestamp: session.timestamp,
    source_ended_at: session.source_ended_at,
    source: session.source,
    tool_calls: Object.entries(session.tool_calls).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
    total_tool_calls: session.total_tool_calls,
    skills_triggered: session.skills_triggered,
    skill_detections: session.skill_detections,
    assistant_turns: session.assistant_turns,
    errors_encountered: session.errors_encountered,
    transcript_chars: session.transcript_chars,
    model_provider: session.model_provider,
    model: session.model,
    input_tokens: session.input_tokens,
    output_tokens: session.output_tokens,
    normalizer_version: NORMALIZER_VERSION,
    source_projection_version: OPENCODE_SOURCE_PROJECTION_VERSION,
  });
  return createHash("sha256").update(normalizedFacts).digest("hex");
}

function isRevisionMarker(value: unknown): value is SessionRevisionMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = Object.fromEntries(Object.entries(value));
  if (
    record.marker_version !== 6 ||
    typeof record.sessions !== "object" ||
    record.sessions === null ||
    Array.isArray(record.sessions)
  ) {
    return false;
  }
  if (
    record.source_fingerprint !== undefined &&
    (typeof record.source_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.source_fingerprint))
  ) {
    return false;
  }
  return Object.values(record.sessions).every(
    (revision) => typeof revision === "string" && /^[0-9a-f]{64}$/.test(revision),
  );
}

function loadSessionRevisions(path: string): LoadedSessionRevisions {
  if (!existsSync(path)) return { revisions: new Map(), scannedSessions: 0 };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRevisionMarker(parsed)) return { revisions: new Map(), scannedSessions: 0 };
    return {
      revisions: new Map(Object.entries(parsed.sessions)),
      ...(typeof parsed.source_fingerprint === "string"
        ? { sourceFingerprint: parsed.source_fingerprint }
        : {}),
      scannedSessions:
        typeof parsed.scanned_sessions === "number" &&
        Number.isInteger(parsed.scanned_sessions) &&
        parsed.scanned_sessions >= 0
          ? parsed.scanned_sessions
          : 0,
    };
  } catch {
    return { revisions: new Map(), scannedSessions: 0 };
  }
}

function saveSessionRevisions(
  path: string,
  revisions: ReadonlyMap<string, string>,
  sourceFingerprint: string | undefined,
  scannedSessions: number,
): void {
  const sessions = Object.fromEntries(
    [...revisions.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const marker: SessionRevisionMarker = {
    marker_version: 6,
    sessions,
    ...(sourceFingerprint ? { source_fingerprint: sourceFingerprint } : {}),
    scanned_sessions: scannedSessions,
  };
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2), "utf8");
}

function fingerprintOpenCodeDatabase(dbPath: string, skillNames: ReadonlySet<string>): string {
  const hash = createHash("sha256");
  hash.update("selftune.opencode.database.v2");
  hash.update("\u0000");
  hash.update(NORMALIZER_VERSION);
  hash.update("\u0000");
  hash.update(OPENCODE_SOURCE_PROJECTION_VERSION);
  for (const skillName of [...skillNames].toSorted()) {
    hash.update("\u0000");
    hash.update(skillName);
  }
  for (const path of [dbPath, `${dbPath}-wal`]) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    hash.update("\u0000");
    hash.update(path.endsWith("-wal") ? "wal" : "database");
    hash.update("\u0000");
    hash.update(String(stat.size));
    hash.update("\u0000");
    hash.update(String(stat.mtimeMs));
  }
  return hash.digest("hex");
}

const reportProgress = (onProgress: HarnessSourceProgressCallback | undefined, message: string) =>
  Effect.try({
    try: () => onProgress?.(message),
    catch: (cause) => sourceFailure("report OpenCode sync progress", cause),
  });

const ingestSession = Effect.fn("OpenCode.syncSource.ingestSession")(function* (
  session: ParsedSession,
  revision: string,
  request: HarnessSourceSyncRequest,
  onDryRunMessage: HarnessSourceProgressCallback,
): Effect.fn.Return<void, HarnessSourceSyncFailure, LocalTraceImporter> {
  yield* Effect.try({
    try: () =>
      writeSession(
        session,
        request.dryRun,
        QUERY_LOG,
        TELEMETRY_LOG,
        request.skillLogPath,
        undefined,
        onDryRunMessage,
      ),
    catch: (cause) => sourceFailure("write OpenCode canonical records", cause),
  });
  if (request.dryRun) return;

  const importer = yield* LocalTraceImporter;
  yield* importer
    .importTrace(
      LocalTraceImportRequest.make({
        source_kind: "opencode",
        source_revision: revision,
        normalizer_version: NORMALIZER_VERSION,
        batch: buildLocalTelemetryBatchFromOpenCode(session),
      }),
    )
    .pipe(Effect.mapError((cause) => sourceFailure("import OpenCode analytical trace", cause)));
});

const makeSyncOpenCodeSource = (markerPath: string) =>
  Effect.fn("OpenCode.syncSource")(function* (
    request: HarnessSourceSyncRequest,
    onProgress?: HarnessSourceProgressCallback,
  ): Effect.fn.Return<HarnessSourceSyncResult, HarnessSourceSyncFailure, LocalTraceImporter> {
    if (!existsSync(request.sourceRoot)) {
      return {
        available: false,
        scanned: 0,
        synced: 0,
        skipped: 0,
        authoritativeFiles: [],
      };
    }
    yield* reportProgress(onProgress, "scanning OpenCode sessions...");
    const dbPath = join(request.sourceRoot, "opencode.db");
    const storageDir = join(request.sourceRoot, "storage");
    const hasDatabase = existsSync(dbPath);
    const hasStorage = existsSync(storageDir);
    if (!hasDatabase && !hasStorage) {
      return {
        available: false,
        scanned: 0,
        synced: 0,
        skipped: 0,
        authoritativeFiles: [],
      };
    }
    const skillNames = yield* Effect.try({
      try: () => findSkillNames(),
      catch: (cause) => sourceFailure("discover OpenCode skills", cause),
    });
    const loaded = yield* Effect.try({
      try: () => loadSessionRevisions(markerPath),
      catch: (cause) => sourceFailure("load OpenCode ingestion marker", cause),
    });
    const sourceFingerprint = yield* Effect.try({
      try: () => (hasDatabase ? fingerprintOpenCodeDatabase(dbPath, skillNames) : undefined),
      catch: (cause) => sourceFailure("fingerprint OpenCode database", cause),
    });
    if (
      !request.force &&
      request.since === undefined &&
      sourceFingerprint !== undefined &&
      loaded.sourceFingerprint === sourceFingerprint
    ) {
      yield* reportProgress(onProgress, "OpenCode database is unchanged");
      return {
        available: true,
        scanned: loaded.scannedSessions,
        synced: 0,
        skipped: 0,
        authoritativeFiles: [dbPath],
      };
    }

    const source = yield* Effect.try({
      try: () => {
        const sinceTs = request.since ? request.since.getTime() / 1000 : null;
        const sessions = hasDatabase
          ? readSessionsFromSqlite(dbPath, sinceTs, skillNames, onProgress)
          : hasStorage
            ? readSessionsFromJsonFiles(storageDir, sinceTs, skillNames)
            : [];
        return { dbPath, storageDir, sessions };
      },
      catch: (cause) => sourceFailure("scan OpenCode sessions", cause),
    });
    const revisions = loaded.revisions;
    const candidates = source.sessions.map((session) => ({
      session,
      revision: stableRevision(session),
    }));
    const pending = request.force
      ? candidates
      : candidates.filter(
          ({ session, revision }) => revisions.get(session.session_id) !== revision,
        );
    yield* reportProgress(
      onProgress,
      `found ${source.sessions.length} sessions, ${pending.length} pending`,
    );

    let synced = 0;
    let markerChanged =
      sourceFingerprint !== undefined && sourceFingerprint !== loaded.sourceFingerprint;
    const onDryRunMessage = onProgress ?? (() => {});
    for (const { session, revision } of pending) {
      yield* ingestSession(session, revision, request, onDryRunMessage);
      if (!request.dryRun) {
        revisions.set(session.session_id, revision);
        markerChanged = true;
      }
      synced += 1;
    }
    if (!request.dryRun && markerChanged) {
      yield* Effect.try({
        try: () =>
          saveSessionRevisions(markerPath, revisions, sourceFingerprint, source.sessions.length),
        catch: (cause) => sourceFailure("save OpenCode ingestion marker", cause),
      });
    }
    return {
      available: true,
      scanned: source.sessions.length,
      synced,
      skipped: 0,
      authoritativeFiles: hasDatabase
        ? [source.dbPath]
        : source.sessions.map((session) => session.transcript_path),
    };
  });

export function makeOpenCodeSourceAdapter(
  markerPath: string = OPENCODE_INGEST_MARKER,
): HarnessSourceAdapter<LocalTraceImporter> {
  return {
    id: adapterId,
    phase: adapterId,
    sync: makeSyncOpenCodeSource(markerPath),
  };
}

export const openCodeSourceAdapter = makeOpenCodeSourceAdapter();
export const syncOpenCodeSource = openCodeSourceAdapter.sync;
