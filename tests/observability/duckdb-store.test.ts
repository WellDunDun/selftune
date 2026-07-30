import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  DuckDbAnalyticalStore,
  makeDuckDbAnalyticalStoreLive,
  type DuckDbConnection,
  type DuckDbInstanceFactory,
  type DuckDbQueryResult,
} from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import * as Effect from "effect/Effect";

type Statement = {
  readonly parameters: Readonly<Record<string, null | number | string>> | undefined;
  readonly sql: string;
};

function queryResult(rows: ReadonlyArray<Record<string, unknown>>): DuckDbQueryResult {
  return { getRowObjects: async () => rows };
}

function makeFactory(statements: Statement[]): DuckDbInstanceFactory {
  const batches = new Map<string, { normalizerVersion: string; sourceRevision: string }>();
  const connection: DuckDbConnection = {
    appendRows: async (table, rows) => {
      statements.push({ sql: `APPEND ${table}`, parameters: { row_count: rows.length } });
    },
    closeSync: () => undefined,
    run: async (sql, parameters) => {
      statements.push({ sql, parameters });
      if (sql.includes("SELECT source_revision, normalizer_version")) {
        const batchId = parameters?.batch_id;
        const batch = batchId === undefined ? undefined : batches.get(String(batchId));
        return queryResult(
          batch === undefined
            ? []
            : [
                {
                  normalizer_version: batch.normalizerVersion,
                  source_revision: batch.sourceRevision,
                },
              ],
        );
      }
      if (sql.includes("INSERT INTO observability_ingested_batches")) {
        const batchId = parameters?.batch_id;
        const normalizerVersion = parameters?.normalizer_version;
        const sourceRevision = parameters?.source_revision;
        if (
          batchId !== undefined &&
          normalizerVersion !== undefined &&
          sourceRevision !== undefined
        ) {
          batches.set(String(batchId), {
            normalizerVersion: String(normalizerVersion),
            sourceRevision: String(sourceRevision),
          });
        }
      }
      if (sql.includes("GROUP BY link.skill_name")) {
        return queryResult([
          {
            skill_name: "diagnose",
            invocation_count: 1,
            trace_count: 1,
            error_trace_count: 1,
            duration_ms: 5_000,
            input_tokens: 120,
            output_tokens: 30,
            error_count: 2,
            tool_call_count: 1,
          },
        ]);
      }
      if (sql.includes("FROM observability_historical_metric_rollups")) {
        return queryResult([
          {
            trace_id: "a".repeat(32),
            source_id: "execution_fact:latest",
            metric_name: "input_tokens",
            observed_at: "2026-07-23T10:01:00.000Z",
            value: 240,
            unit: "count",
            temporality: "cumulative",
            evidence_quality: "source_exact",
            source_reference: "historical/session-1",
          },
        ]);
      }
      if (sql.includes("SELECT DISTINCT") && sql.includes("skill_invocation_id")) {
        return queryResult([
          {
            trace_id: "a".repeat(32),
            span_id: "b".repeat(16),
            skill_invocation_id: "invocation-codex-001",
            source_id: "rollout-codex-001",
            source_revision: "rollout-sha-001",
            model: "gpt-5",
            duration_ms: 5_000,
            input_tokens: 120,
            output_tokens: 30,
            error_count: 2,
            tool_call_count: 1,
          },
        ]);
      }
      if (sql.includes("AS span_count") && sql.includes("AS metric_count")) {
        return queryResult([
          {
            span_count: 1,
            metric_count: 5,
            link_count: 1,
            resource_count: 0,
            scope_count: 0,
            log_count: 0,
            span_link_count: 0,
            historical_metric_point_count: 0,
            historical_log_skill_link_count: 0,
          },
        ]);
      }
      return queryResult([]);
    },
  };
  return {
    open: async () => ({ closeSync: () => undefined, connect: async () => connection }),
  };
}

const batch = {
  schema_version: "1.0.0",
  batch_id: "batch-codex-001",
  source_revision: "rollout-sha-001",
  normalizer_version: "codex-rollout-v1",
  spans: [
    {
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      name: "invoke_agent",
      started_at: "2026-07-23T10:00:00.000Z",
      ended_at: "2026-07-23T10:00:05.000Z",
      platform: "codex",
      capture_mode: "rollout",
      source_authority: "source_truth",
      trace_boundary: "actionable_turn",
      operation_name: "invoke_agent",
      source_id: "rollout-codex-001",
      provider: "openai",
      model: "gpt-5",
      input_tokens: 120,
      output_tokens: 30,
      error_count: 2,
      tool_call_count: 1,
    },
  ],
  links: [
    {
      link_id: "c".repeat(32),
      span_id: "b".repeat(16),
      trace_id: "a".repeat(32),
      skill_invocation_id: "invocation-codex-001",
      skill_name: "diagnose",
    },
  ],
};

test("creates the analytical schema, derives metrics, and ignores a replayed batch", async () => {
  const statements: Statement[] = [];
  const layer = makeDuckDbAnalyticalStoreLive(makeFactory(statements), ":memory:");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      const accepted = yield* store.ingest(batch);
      const duplicate = yield* store.ingest(batch);
      const signals = yield* store.querySkillSignals();
      const health = yield* store.health();
      return { accepted, duplicate, signals, health };
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  expect(result.accepted).toEqual({
    batch_id: "batch-codex-001",
    disposition: "accepted",
    spans_received: 1,
    metrics_derived: 5,
    links_received: 1,
    resources_received: 0,
    scopes_received: 0,
    logs_received: 0,
    metric_points_received: 0,
    log_skill_links_received: 0,
    span_links_received: 0,
  });
  expect(result.duplicate.disposition).toBe("duplicate");
  expect(result.signals).toEqual([
    {
      skill_name: "diagnose",
      invocation_count: 1,
      trace_count: 1,
      error_trace_count: 1,
      duration_ms: 5_000,
      input_tokens: 120,
      output_tokens: 30,
      error_count: 2,
      tool_call_count: 1,
    },
  ]);
  expect(result.health).toEqual({
    database_path: ":memory:",
    schema_version: 9,
    span_count: 1,
    metric_count: 5,
    link_count: 1,
    resource_count: 0,
    scope_count: 0,
    log_count: 0,
    span_link_count: 0,
    historical_metric_point_count: 0,
    historical_log_skill_link_count: 0,
  });
  expect(
    statements.filter((statement) => statement.sql === "APPEND observability_metrics"),
  ).toHaveLength(1);
  expect(
    statements.filter((statement) => statement.sql === "APPEND observability_trace_skill_links"),
  ).toHaveLength(1);
  expect(
    statements.filter((statement) => statement.sql === "APPEND observability_spans"),
  ).toHaveLength(1);
});

test("rejects a reversed span timestamp before beginning an analytical transaction", async () => {
  const statements: Statement[] = [];
  const layer = makeDuckDbAnalyticalStoreLive(makeFactory(statements), ":memory:");
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      return yield* store.ingest({
        ...batch,
        spans: [{ ...batch.spans[0], ended_at: "2026-07-23T09:59:59.000Z" }],
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  expect(result._tag).toBe("Failure");
  expect(statements.filter((statement) => statement.sql === "BEGIN TRANSACTION")).toHaveLength(0);
});

test("selects concrete source references for a supported repeated-error pattern", async () => {
  const statements: Statement[] = [];
  const layer = makeDuckDbAnalyticalStoreLive(makeFactory(statements), ":memory:");
  const candidates = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      return yield* store.queryEvidenceCohortCandidates({
        pattern: {
          pattern_id: "execution-pattern-diagnose",
          kind: "repeated_correlated_errors",
          skill_id: "diagnose",
          skill_name: "Diagnose",
        },
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  expect(candidates).toEqual([
    {
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      skill_invocation_id: "invocation-codex-001",
      source_id: "rollout-codex-001",
      source_revision: "rollout-sha-001",
      model: "gpt-5",
      duration_ms: 5_000,
      input_tokens: 120,
      output_tokens: 30,
      error_count: 2,
      tool_call_count: 1,
    },
  ]);
  expect(statements.some((statement) => statement.sql.includes("SELECT DISTINCT"))).toBe(true);
});

test("returns only the latest cumulative historical snapshot instead of summing it", async () => {
  const statements: Statement[] = [];
  const layer = makeDuckDbAnalyticalStoreLive(makeFactory(statements), ":memory:");
  const rollups = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      return yield* store.queryHistoricalMetricRollups({ limit: 16 });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  expect(rollups).toEqual({
    items: [
      {
        trace_id: "a".repeat(32),
        source_id: "execution_fact:latest",
        metric_name: "input_tokens",
        observed_at: "2026-07-23T10:01:00.000Z",
        value: 240,
        unit: "count",
        temporality: "cumulative",
        evidence_quality: "source_exact",
        source_reference: "historical/session-1",
      },
    ],
  });
  expect(statements.some((statement) => statement.sql.includes("SUM("))).toBe(false);
});

test("updates materialized rollups from the bounded staging point set", async () => {
  const statements: Statement[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest({
        schema_version: "1.0.0",
        batch_id: "bounded-rollup-batch",
        source_revision: "bounded-rollup-source",
        normalizer_version: "historical-v1",
        spans: [],
        links: [],
        metric_points: [
          {
            metric_id: "bounded-rollup-metric",
            trace_id: "c".repeat(32),
            observed_at: "2026-07-23T10:00:00.000Z",
            name: "input_tokens",
            value: 100,
            unit: "count",
            temporality: "cumulative",
            source_kind: "codex",
            evidence_quality: "source_exact",
            source_id: "execution_fact:bounded",
            source_reference: "raw/bounded",
          },
        ],
      });
    }).pipe(
      Effect.provide(makeDuckDbAnalyticalStoreLive(makeFactory(statements), ":memory:")),
      Effect.scoped,
    ),
  );
  expect(
    statements.some(
      (statement) =>
        statement.sql.includes("INSERT INTO observability_historical_metric_rollups") &&
        statement.sql.includes("FROM observability_historical_metric_rollup_staging") &&
        !statement.sql.includes("observability_historical_metric_points"),
    ),
  ).toBe(true);
});

test("rejects more historical points than the staging input bound before writing", async () => {
  const statements: Statement[] = [];
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      return yield* store.ingest({
        schema_version: "1.0.0",
        batch_id: "oversized-rollup-batch",
        source_revision: "oversized-rollup-source",
        normalizer_version: "historical-v1",
        spans: [],
        links: [],
        metric_points: Array.from({ length: 257 }, (_, index) => ({
          metric_id: `oversized-metric-${index}`,
          trace_id: "c".repeat(32),
          observed_at: "2026-07-23T10:00:00.000Z",
          name: "input_tokens",
          value: index,
          unit: "count",
          temporality: "cumulative",
          source_kind: "codex",
          evidence_quality: "source_exact",
          source_id: `execution_fact:oversized-${index}`,
          source_reference: `raw/oversized-${index}`,
        })),
      });
    }).pipe(
      Effect.provide(makeDuckDbAnalyticalStoreLive(makeFactory(statements), ":memory:")),
      Effect.scoped,
    ),
  );

  expect(result._tag).toBe("Failure");
  expect(
    statements.some(
      (statement) => statement.sql === "APPEND observability_historical_metric_rollup_staging",
    ),
  ).toBe(false);
});

test("rolls two execution snapshots for one trace down to the newest point", async () => {
  const traceId = "c".repeat(32);
  const pointBatch = (id: string, observedAt: string, sourceId: string, value: number) => ({
    schema_version: "1.0.0",
    batch_id: `historical-${id}`,
    source_revision: id,
    normalizer_version: "historical-v1",
    spans: [],
    links: [],
    metric_points: [
      {
        metric_id: `metric-${id}`,
        trace_id: traceId,
        observed_at: observedAt,
        name: "input_tokens",
        value,
        unit: "count",
        temporality: "cumulative",
        source_kind: "codex",
        evidence_quality: "source_exact",
        source_id: sourceId,
        source_reference: `raw/${sourceId}`,
      },
    ],
  });
  const rollups = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest(
        pointBatch("first", "2026-07-23T10:00:00.000Z", "execution_fact:first", 120),
      );
      yield* store.ingest(
        pointBatch("second", "2026-07-23T10:01:00.000Z", "execution_fact:second", 240),
      );
      return yield* store.queryHistoricalMetricRollups({ limit: 1 });
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(":memory:")), Effect.scoped),
  );

  expect(rollups.items).toHaveLength(1);
  expect(rollups.items[0]).toMatchObject({
    source_id: "execution_fact:second",
    value: 240,
    observed_at: "2026-07-23T10:01:00.000000Z",
  });
});

test("keeps the newest materialized point across out-of-order imports and deterministic ties", async () => {
  const traceId = "d".repeat(32);
  const pointBatch = (id: string, observedAt: string, metricId: string, value: number) => ({
    schema_version: "1.0.0",
    batch_id: `ordered-${id}`,
    source_revision: id,
    normalizer_version: "historical-v1",
    spans: [],
    links: [],
    metric_points: [
      {
        metric_id: metricId,
        trace_id: traceId,
        observed_at: observedAt,
        name: "input_tokens",
        value,
        unit: "count",
        temporality: "cumulative",
        source_kind: "codex",
        evidence_quality: "source_exact",
        source_id: `execution_fact:${id}`,
        source_reference: `raw/${id}`,
      },
    ],
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest(pointBatch("new", "2026-07-23T10:01:00.000Z", "metric-new", 240));
      yield* store.ingest(pointBatch("old", "2026-07-23T10:00:00.000Z", "metric-old", 120));
      yield* store.ingest(pointBatch("tie-low", "2026-07-23T10:01:00.000Z", "metric-a", 241));
      yield* store.ingest(pointBatch("tie-high", "2026-07-23T10:01:00.000Z", "metric-z", 242));
      const first = yield* store.queryHistoricalMetricRollups({ limit: 1 });
      const replay = yield* store.ingest(
        pointBatch("tie-high", "2026-07-23T10:01:00.000Z", "metric-z", 242),
      );
      const second = yield* store.queryHistoricalMetricRollups({ limit: 1 });
      return { first, replay, second };
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(":memory:")), Effect.scoped),
  );

  expect(result.first.items).toMatchObject([{ source_id: "execution_fact:tie-high", value: 242 }]);
  expect(result.replay.disposition).toBe("duplicate");
  expect(result.second).toEqual(result.first);
});

test("rebuilds rollups when a revised batch removes its newest historical metric", async () => {
  const traceId = "d".repeat(32);
  const pointBatch = (
    batchId: string,
    sourceRevision: string,
    observedAt: string,
    metricId: string,
    value: number,
  ) => ({
    schema_version: "1.0.0",
    batch_id: batchId,
    source_revision: sourceRevision,
    normalizer_version: "historical-v1",
    spans: [],
    links: [],
    metric_points: [
      {
        metric_id: metricId,
        trace_id: traceId,
        observed_at: observedAt,
        name: "input_tokens",
        value,
        unit: "count",
        temporality: "cumulative",
        source_kind: "codex",
        evidence_quality: "source_exact",
        source_id: `execution_fact:${batchId}`,
        source_reference: `raw/${batchId}`,
      },
    ],
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest(
        pointBatch("older-batch", "older-r1", "2026-07-23T10:00:00.000Z", "metric-old", 100),
      );
      yield* store.ingest(
        pointBatch("revised-batch", "newer-r1", "2026-07-23T10:01:00.000Z", "metric-new", 200),
      );
      yield* store.ingest({
        schema_version: "1.0.0",
        batch_id: "revised-batch",
        source_revision: "newer-r2",
        normalizer_version: "historical-v1",
        spans: [],
        links: [],
        metric_points: [],
      });
      return yield* store.queryHistoricalMetricRollups({ limit: 1 });
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(":memory:")), Effect.scoped),
  );

  expect(result.items).toMatchObject([{ source_id: "execution_fact:older-batch", value: 100 }]);
});

test("materialized historical rollups equal a deterministic rebuild from raw points", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-rollup-rebuild-"));
  const databasePath = join(directory, "observability.duckdb");
  const traceId = "e".repeat(32);
  const pointBatch = (id: string, observedAt: string, metricId: string, value: number) => ({
    schema_version: "1.0.0",
    batch_id: `rebuild-${id}`,
    source_revision: id,
    normalizer_version: "historical-v1",
    spans: [],
    links: [],
    metric_points: [
      {
        metric_id: metricId,
        trace_id: traceId,
        observed_at: observedAt,
        name: "duration_ms",
        value,
        unit: "ms",
        temporality: "cumulative",
        source_kind: "codex",
        evidence_quality: "source_exact",
        source_id: `execution_fact:${id}`,
        source_reference: `raw/${id}`,
      },
    ],
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DuckDbAnalyticalStore;
        yield* store.ingest(pointBatch("old", "2026-07-23T10:00:00.000Z", "metric-old", 100));
        yield* store.ingest(pointBatch("new", "2026-07-23T10:01:00.000Z", "metric-new", 200));
        yield* store.ingest(pointBatch("tie", "2026-07-23T10:01:00.000Z", "metric-z", 201));
      }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
    );
    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    try {
      const materialized = await connection.run(`SELECT metric_id, value
        FROM observability_historical_metric_rollups
        ORDER BY trace_id, metric_name`);
      const rebuilt = await connection.run(`SELECT metric_id, value
        FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY trace_id, metric_name
            ORDER BY observed_at DESC, metric_id DESC
          ) AS point_rank
          FROM observability_historical_metric_points
        ) AS latest
        WHERE point_rank = 1
        ORDER BY trace_id, metric_name`);
      expect(await materialized.getRowObjects()).toEqual(await rebuilt.getRowObjects());
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("v8 rebuilds materialized rollups deterministically for an existing v7 point corpus", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-rollup-v7-upgrade-"));
  const databasePath = join(directory, "observability.duckdb");
  const traceId = "f".repeat(32);
  const pointBatch = (id: string, metricId: string, value: number) => ({
    schema_version: "1.0.0",
    batch_id: `upgrade-${id}`,
    source_revision: id,
    normalizer_version: "historical-v1",
    spans: [],
    links: [],
    metric_points: [
      {
        metric_id: metricId,
        trace_id: traceId,
        observed_at: "2026-07-23T10:00:00.000Z",
        name: "input_tokens",
        value,
        unit: "count",
        temporality: "cumulative",
        source_kind: "codex",
        evidence_quality: "source_exact",
        source_id: `execution_fact:${id}`,
        source_reference: `raw/${id}`,
      },
    ],
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DuckDbAnalyticalStore;
        yield* store.ingest(pointBatch("low", "metric-a", 100));
        yield* store.ingest(pointBatch("high", "metric-z", 200));
      }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
    );
    const inspectionInstance = await DuckDBInstance.create(databasePath);
    const inspectionConnection = await inspectionInstance.connect();
    try {
      await inspectionConnection.run("DROP TABLE observability_historical_metric_rollups");
      await inspectionConnection.run(
        "DELETE FROM observability_schema_migrations WHERE version = 8",
      );
      await inspectionConnection.run(
        "DELETE FROM observability_schema_migrations WHERE version = 9",
      );
    } finally {
      inspectionConnection.closeSync();
      inspectionInstance.closeSync();
    }
    const rollups = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DuckDbAnalyticalStore;
        return yield* store.queryHistoricalMetricRollups({ limit: 1 });
      }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
    );
    expect(rollups.items).toMatchObject([{ source_id: "execution_fact:high", value: 200 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("releases a partially acquired instance before retrying a failed connection", async () => {
  const events: string[] = [];
  let openCount = 0;
  const factory: DuckDbInstanceFactory = {
    open: async () => {
      openCount += 1;
      const instanceId = openCount;
      events.push(`open:${instanceId}`);
      return {
        closeSync: () => events.push(`instance.close:${instanceId}`),
        connect: async () => {
          events.push(`connect:${instanceId}`);
          if (instanceId === 1) throw new Error("connection unavailable");
          return {
            appendRows: async () => undefined,
            closeSync: () => events.push(`connection.close:${instanceId}`),
            run: async () => queryResult([]),
          };
        },
      };
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* DuckDbAnalyticalStore;
    }).pipe(Effect.provide(makeDuckDbAnalyticalStoreLive(factory, ":memory:")), Effect.scoped),
  );

  expect(events).toEqual([
    "open:1",
    "connect:1",
    "instance.close:1",
    "open:2",
    "connect:2",
    "connection.close:2",
    "instance.close:2",
  ]);
});

test("releases the connection and instance when schema migration fails", async () => {
  const events: string[] = [];
  const factory: DuckDbInstanceFactory = {
    open: async () => {
      events.push("open");
      return {
        closeSync: () => events.push("instance.close"),
        connect: async () => {
          events.push("connect");
          return {
            appendRows: async () => undefined,
            closeSync: () => events.push("connection.close"),
            run: async () => {
              events.push("migrate");
              throw new Error("migration failed");
            },
          };
        },
      };
    },
  };

  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* DuckDbAnalyticalStore;
    }).pipe(Effect.provide(makeDuckDbAnalyticalStoreLive(factory, ":memory:")), Effect.scoped),
  );

  expect(result._tag).toBe("Failure");
  expect(events).toEqual(["open", "connect", "migrate", "connection.close", "instance.close"]);
});
