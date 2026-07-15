import * as Effect from "effect/Effect";

import {
  SourceSync,
  type SourceSyncRequest,
  type SourceSyncRunner,
} from "@selftune/runtime/source-sync";

import { makeSourceSyncLayer } from "./source-sync-layer.js";
import { runSourceSync } from "./sync.js";

export const SourceSyncLive = makeSourceSyncLayer(runSourceSync);

const runWithSourceSync = Effect.fn("SelfTune.syncSourceTruth")(function* (
  request: SourceSyncRequest,
) {
  const sourceSync = yield* SourceSync;
  return yield* sourceSync.run(request);
});

export const liveSourceSyncRunner: SourceSyncRunner = (request = {}) =>
  Effect.runSync(runWithSourceSync(request).pipe(Effect.provide(SourceSyncLive)));
