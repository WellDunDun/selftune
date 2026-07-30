import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  _setTestDb,
  acknowledgeAnalyticalImport,
  AnalyticalImportCheckpoint,
  getDb,
  isAnalyticalImportCurrent,
  openDb,
} from "@selftune/local-store";
import * as Effect from "effect/Effect";

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
});

test("acknowledges analytical imports only after the matching source revision succeeds", () => {
  const firstRevision = AnalyticalImportCheckpoint.make({
    source_kind: "codex_rollout",
    source_identity: "trace-batch-01",
    source_fingerprint: "size=100;mtime=1",
    normalizer_version: "2026.07.23",
  });
  const changedRevision = AnalyticalImportCheckpoint.make({
    ...firstRevision,
    source_fingerprint: "size=120;mtime=2",
  });

  expect(Effect.runSync(isAnalyticalImportCurrent(getDb(), firstRevision))).toBe(false);

  Effect.runSync(acknowledgeAnalyticalImport(getDb(), firstRevision, "2026-07-23T12:00:00.000Z"));

  expect(Effect.runSync(isAnalyticalImportCurrent(getDb(), firstRevision))).toBe(true);
  expect(Effect.runSync(isAnalyticalImportCurrent(getDb(), changedRevision))).toBe(false);
});
