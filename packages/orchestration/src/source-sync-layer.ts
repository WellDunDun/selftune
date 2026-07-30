import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SourceSync,
  SourceSyncUnavailable,
  type SourceSyncRequest,
  type SourceSyncRunner,
} from "@selftune/source-management/sync";

export function makeSourceSyncLayer(run: SourceSyncRunner) {
  return Layer.succeed(
    SourceSync,
    SourceSync.of({
      run: Effect.fn("SourceSync.run")(function* (request: SourceSyncRequest) {
        return yield* Effect.tryPromise({
          try: () => run(request),
          catch: (cause) =>
            SourceSyncUnavailable.make({
              operation: "sync",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    }),
  );
}
