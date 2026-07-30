import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { SourceSync, type SyncResult } from "@selftune/source-management/sync";

import { makeSourceSyncLayer } from "../src/source-sync-layer.js";

const successfulResult: SyncResult = {
  since: null,
  dry_run: false,
  sources: {
    claude: { available: true, scanned: 2, synced: 1, skipped: 1 },
    codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
    opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
    openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
    pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
  },
  repair: {
    ran: true,
    repaired_sessions: 1,
    repaired_records: 1,
    codex_repaired_records: 0,
  },
  creator_contributions: {
    ran: false,
    eligible_skills: 0,
    built_signals: 0,
    staged_signals: 0,
  },
  timings: [],
  total_elapsed_ms: 12,
};

describe("SourceSync layer", () => {
  it.layer(makeSourceSyncLayer(async () => successfulResult))(
    "provides sync through a capability",
    (it) => {
      it.effect("returns the source-truth result", () =>
        Effect.gen(function* () {
          const sourceSync = yield* SourceSync;
          const result = yield* sourceSync.run({ force: true });
          assert.strictEqual(result.sources.claude.synced, 1);
          assert.strictEqual(result.repair.repaired_records, 1);
        }),
      );
    },
  );

  it.layer(
    makeSourceSyncLayer(async () => {
      throw new Error("transcript store unavailable");
    }),
  )("typed failure", (it) => {
    it.effect("maps implementation failures into SourceSyncUnavailable", () =>
      Effect.gen(function* () {
        const sourceSync = yield* SourceSync;
        const error = yield* Effect.flip(sourceSync.run({}));
        assert.strictEqual(error._tag, "SourceSyncUnavailable");
        assert.include(error.message, "transcript store unavailable");
      }),
    );
  });
});
