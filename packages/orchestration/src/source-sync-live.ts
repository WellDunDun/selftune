import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SourceSync,
  SourceSyncUnavailable,
  type SourceSyncRequest,
  type SourceSyncRunner,
} from "@selftune/source-management/sync";

import { createDefaultSyncOptions } from "./sync.js";
import { syncSourcesLive } from "./sync/live-source.js";

const runSourceSync = Effect.fn("selftune.orchestration.sourceSync.live")(function* (
  request: SourceSyncRequest = {},
) {
  return yield* syncSourcesLive(
    createDefaultSyncOptions({
      force: request.force ?? false,
      dryRun: request.dryRun ?? false,
    }),
  );
});

export const liveSourceSyncRunner: SourceSyncRunner = (request = {}) =>
  Effect.runPromise(runSourceSync(request));

export const SourceSyncLive = Layer.succeed(
  SourceSync,
  SourceSync.of({
    run: (request) =>
      runSourceSync(request).pipe(
        Effect.mapError((cause) =>
          SourceSyncUnavailable.make({
            operation: "sync",
            message: cause.message,
          }),
        ),
      ),
  }),
);
