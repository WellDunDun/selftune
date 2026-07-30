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
import { OPENCLAW_INGEST_MARKER, QUERY_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import { loadMarker, saveMarker } from "@selftune/runtime/utils/jsonl";
import {
  findOpenClawSessions,
  findOpenClawSkillNames,
  parseOpenClawSession,
  writeSession,
} from "./ingestors/openclaw-ingest.js";

/** Imports source-native OpenClaw session JSONL files. */
function syncOpenClawSourceUnchecked(
  request: HarnessSourceSyncRequest,
  onProgress?: HarnessSourceProgressCallback,
): HarnessSourceSyncResult {
  if (!existsSync(request.sourceRoot)) {
    return {
      available: false,
      scanned: 0,
      synced: 0,
      skipped: 0,
      authoritativeFiles: [],
    };
  }

  onProgress?.("scanning OpenClaw sessions...");
  const sinceTs = request.since ? request.since.getTime() : null;
  const sessions = findOpenClawSessions(request.sourceRoot, sinceTs);
  const skillNames = findOpenClawSkillNames(request.sourceRoot);
  const alreadyIngested = request.force ? new Set<string>() : loadMarker(OPENCLAW_INGEST_MARKER);
  const pending = sessions.filter((session) => !alreadyIngested.has(session.sessionId));
  onProgress?.(`found ${sessions.length} sessions, ${pending.length} pending`);

  const newIngested = new Set<string>();
  const onDryRunMessage = onProgress ?? (() => {});
  let synced = 0;
  let skipped = 0;

  for (const sessionFile of pending) {
    const session = parseOpenClawSession(sessionFile.filePath, skillNames);
    if (!session.session_id || !session.timestamp) {
      skipped += 1;
      continue;
    }
    writeSession(
      session,
      request.dryRun,
      QUERY_LOG,
      TELEMETRY_LOG,
      request.skillLogPath,
      undefined,
      onDryRunMessage,
    );
    newIngested.add(sessionFile.sessionId);
    synced += 1;
  }

  if (!request.dryRun && newIngested.size > 0) {
    saveMarker(OPENCLAW_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  return {
    available: true,
    scanned: sessions.length,
    synced,
    skipped,
    authoritativeFiles: sessions.map((session) => session.filePath),
  };
}

export const syncOpenClawSource = Effect.fn("OpenClaw.syncSource")(function* (
  request: HarnessSourceSyncRequest,
  onProgress?: HarnessSourceProgressCallback,
): Effect.fn.Return<HarnessSourceSyncResult, HarnessSourceSyncFailure> {
  return yield* Effect.try({
    try: () => syncOpenClawSourceUnchecked(request, onProgress),
    catch: (cause) => harnessSourceSyncFailure("openclaw", "sync", cause),
  });
});

export const openClawSourceAdapter = {
  id: "openclaw",
  phase: "openclaw",
  sync: syncOpenClawSource,
} satisfies HarnessSourceAdapter;
