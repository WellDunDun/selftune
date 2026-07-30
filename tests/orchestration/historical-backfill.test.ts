import { afterEach, beforeEach, expect, test } from "bun:test";

import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import {
  LocalTraceImporter,
  LocalTraceImportResult,
  LocalTraceImportRequest,
} from "@selftune/observability";
import {
  establishHistoricalBackfillBoundaries,
  HistoricalBackfillFailure,
  runHistoricalBackfill,
} from "@selftune/orchestration/historical-backfill";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const imports: LocalTraceImportRequest[] = [];

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
  imports.length = 0;
  for (const [id, platform] of [
    ["01-claude", "claude_code"],
    ["02-codex", "codex"],
    ["03-opencode", "opencode"],
    ["04-pi", "pi"],
    ["05-openclaw", "openclaw"],
  ]) {
    getDb().run(
      `INSERT INTO sessions (session_id, platform, started_at, ended_at, capture_mode)
       VALUES (?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z', 'session')`,
      [id, platform],
    );
  }
  getDb().run(
    `INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name, occurred_at)
     VALUES ('codex-skill', '02-codex', 'diagnose', '2026-07-01T00:00:00.000Z')`,
  );
  getDb().run(
    `INSERT INTO prompts (prompt_id, session_id, occurred_at)
     VALUES ('codex-prompt', '02-codex', '2026-07-01T00:00:00.000Z')`,
  );
  getDb().run(
    `INSERT INTO execution_facts (execution_fact_id, session_id, occurred_at)
     VALUES ('codex-fact', '02-codex', '2026-07-01T00:00:00.000Z')`,
  );
});

afterEach(() => _setTestDb(null));

const importerLayer = Layer.succeed(
  LocalTraceImporter,
  LocalTraceImporter.of({
    importTrace: (input) =>
      Schema.decodeUnknownEffect(LocalTraceImportRequest)(input).pipe(
        Effect.map((request) => {
          imports.push(request);
          return LocalTraceImportResult.make({ skill_failure_signals: [] });
        }),
        Effect.orDie,
      ),
  }),
);

const run = (options = {}) =>
  Effect.runPromise(runHistoricalBackfill(getDb(), options).pipe(Effect.provide(importerLayer)));

const establish = () => Effect.runPromise(establishHistoricalBackfillBoundaries(getDb()));

test("reads canonical SQLite source tables in bounded deterministic keysets and withholds OpenClaw", async () => {
  const result = await run({ batchSize: 2 });

  expect(result).toMatchObject({
    batches_read: 6,
    source_rows_seen: 8,
    withheld_unsupported_platform: 1,
  });
  expect(result.cursors).toEqual({
    sessions: "5",
    prompts: "1",
    skill_invocations: "1",
    execution_facts: "1",
  });
  expect(imports.map((item) => item.source_kind)).toContain("claude_code");
  expect(imports.map((item) => item.source_kind)).toContain("pi");
  expect(
    getDb()
      .query(
        "SELECT COUNT(*) AS count FROM analytical_import_checkpoints WHERE source_kind = 'historical-backfill'",
      )
      .get(),
  ).toEqual({ count: 4 });
});

test("replays the same stable batch after interruptions before import and before its cursor acknowledgement", async () => {
  const fail = (operation: string) =>
    HistoricalBackfillFailure.make({
      operation,
      message: "injected interruption",
    });
  await expect(
    run({
      batchSize: 2,
      hooks: { beforeImport: () => Effect.fail(fail("before import")) },
    }),
  ).rejects.toThrow("injected interruption");
  expect(imports).toHaveLength(0);

  await expect(
    run({
      batchSize: 2,
      hooks: { afterImport: () => Effect.fail(fail("after receipt")) },
    }),
  ).rejects.toThrow("injected interruption");
  const replayId = imports[0]?.batch.batch_id;
  expect(replayId).toBeDefined();
  await run({ batchSize: 2, maxBatches: 1 });
  expect(imports.filter((item) => item.batch.batch_id === replayId)).toHaveLength(2);
});

test("acknowledges only after all public imports return, then resumes at the next keyset", async () => {
  await expect(
    run({
      batchSize: 2,
      hooks: {
        beforeCheckpoint: () =>
          Effect.fail(
            HistoricalBackfillFailure.make({
              operation: "checkpoint",
              message: "after receipt",
            }),
          ),
      },
    }),
  ).rejects.toThrow("after receipt");
  expect(
    getDb()
      .query(
        "SELECT COUNT(*) AS count FROM analytical_import_checkpoints WHERE source_kind = 'historical-backfill'",
      )
      .get(),
  ).toEqual({ count: 0 });

  await run({ batchSize: 2, maxBatches: 1 });
  expect(
    getDb()
      .query(
        "SELECT source_fingerprint FROM analytical_import_checkpoints WHERE source_kind = 'historical-backfill' AND source_identity = 'sqlite-canonical-keyset:sessions'",
      )
      .get(),
  ).toEqual({ source_fingerprint: "2" });
  const resumed = await run({ batchSize: 2 });
  expect(resumed).toMatchObject({
    batches_read: 5,
    cursors: { sessions: "5" },
  });
});

test("canonical source-row insertion order does not change backfill batch identities", async () => {
  await run({ batchSize: 2, maxBatches: 1 });
  const first = imports.map((item) => item.batch.batch_id);
  getDb().run(
    "DELETE FROM analytical_import_checkpoints WHERE source_kind = 'historical-backfill'",
  );
  imports.length = 0;
  await run({ batchSize: 2, maxBatches: 1 });
  expect(imports.map((item) => item.batch.batch_id)).toEqual(first);
});

test("uses a pre-sync high-water boundary so later live rows are not imported historically", async () => {
  await establish();
  getDb().run(
    `INSERT INTO sessions (session_id, platform, started_at, ended_at, capture_mode)
     VALUES ('00-live-after-boundary', 'codex', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:01.000Z', 'session')`,
  );
  getDb().run(
    `INSERT INTO prompts (prompt_id, session_id, occurred_at)
     VALUES ('00-live-prompt', '00-live-after-boundary', '2026-07-02T00:00:00.000Z')`,
  );
  getDb().run(
    `INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name, occurred_at)
     VALUES ('00-live-invocation', '00-live-after-boundary', 'diagnose', '2026-07-02T00:00:00.000Z')`,
  );
  getDb().run(
    `INSERT INTO execution_facts (execution_fact_id, session_id, occurred_at, duration_ms)
     VALUES ('00-live-fact', '00-live-after-boundary', '2026-07-02T00:00:00.000Z', 1)`,
  );

  const result = await run({ batchSize: 256 });

  expect(result.source_rows_seen).toBe(8);
  const sourceIds = imports.flatMap((request) => [
    ...request.batch.spans.flatMap((span) =>
      span.source_id === undefined ? [] : [span.source_id],
    ),
    ...request.batch.logs.flatMap((log) => (log.source_id === undefined ? [] : [log.source_id])),
    ...request.batch.metric_points.flatMap((point) =>
      point.source_id === undefined ? [] : [point.source_id],
    ),
  ]);
  expect(sourceIds).not.toContain("session:00-live-after-boundary");
  expect(sourceIds).not.toContain("prompt:00-live-prompt");
  expect(sourceIds).not.toContain("skill_invocation:00-live-invocation");
  expect(sourceIds).not.toContain("execution_fact:00-live-fact");
});

test("restart and normalizer cursor changes reuse the original high-water boundary", async () => {
  await establish();
  getDb().run(
    `INSERT INTO sessions (session_id, platform, started_at, ended_at, capture_mode)
     VALUES ('00-live-after-boundary', 'codex', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:01.000Z', 'session')`,
  );
  getDb().run(
    `UPDATE analytical_import_checkpoints SET normalizer_version = 'future'
      WHERE source_kind = 'historical-backfill'`,
  );

  await run({ batchSize: 256, restart: true });

  expect(
    getDb()
      .query(
        `SELECT source_fingerprint FROM analytical_import_checkpoints
          WHERE source_kind = 'historical-backfill-boundary'
            AND source_identity = 'sqlite-canonical-high-water:sessions'`,
      )
      .get(),
  ).toEqual({ source_fingerprint: "5" });
  expect(
    imports
      .flatMap((request) => request.batch.spans)
      .some((span) => span.trace_id === "00-live-after-boundary"),
  ).toBeFalse();
});
