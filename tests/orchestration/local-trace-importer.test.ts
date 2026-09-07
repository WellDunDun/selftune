import { afterEach, beforeEach, expect, test } from "bun:test";

import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import {
  DuckDbAnalyticalBatch,
  DuckDbAnalyticalIngestReceipt,
  DuckDbAnalyticalStore,
  DuckDbAnalyticalStoreFailure,
  DuckDbAnalyticalStoreHealth,
  LocalTelemetryBatch,
  LocalTelemetryLogRecord,
  LocalTelemetryLogSkillLink,
  LocalTelemetryMetricPoint,
  LocalTelemetryResource,
  LocalTelemetryInstrumentationScope,
  LocalTelemetrySkillLink,
  LocalTelemetrySpan,
  LocalTelemetrySpanLink,
  LocalTraceImporter,
  LocalTraceImportRequest,
} from "@selftune/observability";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const linkId = "abcdef0123456789abcdef0123456789";
const logId = "historical-observation";
const metricId = "historical-duration";
const logLinkId = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
  getDb().run(
    `INSERT INTO sessions (session_id, platform, capture_mode)
     VALUES ('local-trace-importer-session', 'codex', 'rollout')`,
  );
  getDb().run(
    `INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name)
     VALUES ('local-trace-importer-invocation', 'local-trace-importer-session', 'diagnose')`,
  );
});

afterEach(() => {
  _setTestDb(null);
});

const request = LocalTraceImportRequest.make({
  source_kind: "codex",
  source_revision: "100:10",
  normalizer_version: "2026.07.23",
  batch: LocalTelemetryBatch.make({
    schema_version: "1.0.0",
    semantic_convention_version: "1.0.0",
    batch_id: "local-trace-importer-batch",
    spans: [
      LocalTelemetrySpan.make({
        trace_id: traceId,
        span_id: spanId,
        name: "codex rollout",
        started_at: "2026-07-23T10:00:00.000Z",
        ended_at: "2026-07-23T10:00:02.000Z",
        platform: "codex",
        capture_mode: "rollout",
        source_authority: "source_truth",
        trace_boundary: "actionable_turn",
        operation_name: "invoke_agent",
        source_id: "local-trace-importer-source",
        input_tokens: 120,
        output_tokens: 30,
        error_count: 1,
        tool_call_count: 2,
      }),
    ],
    links: [
      LocalTelemetrySkillLink.make({
        link_id: linkId,
        trace_id: traceId,
        span_id: spanId,
        skill_invocation_id: "local-trace-importer-invocation",
      }),
    ],
    logs: [
      LocalTelemetryLogRecord.make({
        log_id: logId,
        trace_id: traceId,
        timestamp: "2026-07-23T10:00:00.000Z",
        event_name: "historical.execution_snapshot_observed",
        severity: "INFO",
      }),
    ],
    metric_points: [
      LocalTelemetryMetricPoint.make({
        metric_id: metricId,
        trace_id: traceId,
        source_kind: "codex",
        log_id: logId,
        observed_at: "2026-07-23T10:00:00.000Z",
        name: "duration_ms",
        value: 2_000,
        unit: "ms",
        temporality: "cumulative",
        evidence_quality: "metadata_only",
        source_id: "execution_fact:local-trace-importer",
        source_reference: "session:local-trace-importer-session",
      }),
    ],
    log_skill_links: [
      LocalTelemetryLogSkillLink.make({
        link_id: logLinkId,
        trace_id: traceId,
        log_id: logId,
        skill_invocation_id: "local-trace-importer-invocation",
      }),
    ],
  }),
});

const recordingStore = (received: DuckDbAnalyticalBatch[], receipts = new Set<string>()) =>
  Layer.succeed(
    DuckDbAnalyticalStore,
    DuckDbAnalyticalStore.of({
      hasExactBatchReceipt: (input) =>
        Schema.decodeUnknownEffect(DuckDbAnalyticalBatch)(input).pipe(
          Effect.map((batch) => receipts.has(batch.batch_id)),
          Effect.orDie,
        ),
      ingest: (input) =>
        Schema.decodeUnknownEffect(DuckDbAnalyticalBatch)(input).pipe(
          Effect.map((batch) => {
            received.push(batch);
            receipts.add(batch.batch_id);
            return DuckDbAnalyticalIngestReceipt.make({
              batch_id: batch.batch_id,
              disposition: "accepted",
              spans_received: batch.spans.length,
              metrics_derived: batch.spans.length * 5,
              links_received: batch.links.length,
              resources_received: batch.resources?.length ?? 0,
              scopes_received: batch.instrumentation_scopes?.length ?? 0,
              logs_received: batch.logs?.length ?? 0,
              metric_points_received: batch.metric_points?.length ?? 0,
              log_skill_links_received: batch.log_skill_links?.length ?? 0,
              span_links_received: batch.span_links?.length ?? 0,
            });
          }),
          Effect.orDie,
        ),
      querySkillSignals: () => Effect.succeed([]),
      queryEvidenceCohortCandidates: () => Effect.succeed([]),
      queryHistoricalSkillTaskReferences: () => Effect.succeed([]),
      queryHistoricalMetricRollups: () =>
        Effect.fail(
          DuckDbAnalyticalStoreFailure.make({
            operation: "test query historical metric rollups",
            message: "unused",
          }),
        ),
      health: () =>
        Effect.succeed(
          DuckDbAnalyticalStoreHealth.make({
            database_path: ":memory:",
            schema_version: 9,
            span_count: 0,
            metric_count: 0,
            link_count: 0,
            resource_count: 0,
            scope_count: 0,
            log_count: 0,
            historical_metric_point_count: 0,
            historical_log_skill_link_count: 0,
            span_link_count: 0,
          }),
        ),
    }),
  );

test("imports a source revision before acknowledging its SQLite checkpoint", async () => {
  const received: DuckDbAnalyticalBatch[] = [];
  const storeLayer = recordingStore(received);
  const importerLayer = Layer.provide(makeLocalTraceImporterLive(getDb()), storeLayer);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const importer = yield* LocalTraceImporter;
      return yield* importer.importTrace(request);
    }).pipe(Effect.provide(importerLayer)),
  );

  expect(received).toHaveLength(1);
  expect(received[0]?.metric_points).toHaveLength(1);
  expect(received[0]?.log_skill_links).toEqual([
    expect.objectContaining({ skill_name: "diagnose", log_id: logId }),
  ]);
  expect(result.skill_failure_signals).toEqual([
    expect.objectContaining({ skill_name: "diagnose", error_count: 1 }),
  ]);
  getDb().run("UPDATE analytical_import_checkpoints SET imported_at = '2000-01-01T00:00:00.000Z'");
  await Effect.runPromise(
    Effect.gen(function* () {
      const importer = yield* LocalTraceImporter;
      return yield* importer.importTrace(request);
    }).pipe(Effect.provide(importerLayer)),
  );
  expect(received).toHaveLength(1);
  expect(
    getDb()
      .query<{ imported_at: string; source_fingerprint: string }, []>(
        "SELECT imported_at, source_fingerprint FROM analytical_import_checkpoints WHERE source_kind = 'codex'",
      )
      .get(),
  ).toEqual({
    imported_at: "2000-01-01T00:00:00.000Z",
    source_fingerprint: "100:10",
  });
});

const importBatch = (input: LocalTraceImportRequest, received: DuckDbAnalyticalBatch[]) =>
  Effect.gen(function* () {
    return yield* (yield* LocalTraceImporter).importTrace(input);
  }).pipe(
    Effect.provide(Layer.provide(makeLocalTraceImporterLive(getDb()), recordingStore(received))),
  );

const minimalBatch = LocalTelemetryBatch.make({
  schema_version: "1.0.0",
  semantic_convention_version: "1.0.0",
  batch_id: "minimal-batch",
  spans: request.batch.spans,
});

test("absent optional collections remain absent in analytical storage", async () => {
  const received: DuckDbAnalyticalBatch[] = [];
  await Effect.runPromise(importBatch({ ...request, batch: minimalBatch }, received));
  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({
    schema_version: "1.0.0",
    batch_id: "minimal-batch",
    source_revision: request.source_revision,
    normalizer_version: request.normalizer_version,
    spans: request.batch.spans,
    links: [],
  });
});

test("explicit empty optional collections remain present", async () => {
  const received: DuckDbAnalyticalBatch[] = [];
  const batch = LocalTelemetryBatch.make({
    ...minimalBatch,
    resources: [],
    instrumentation_scopes: [],
    logs: [],
    metric_points: [],
    log_skill_links: [],
    span_links: [],
  });
  await Effect.runPromise(importBatch({ ...request, batch }, received));
  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({
    schema_version: "1.0.0",
    batch_id: "minimal-batch",
    source_revision: request.source_revision,
    normalizer_version: request.normalizer_version,
    spans: request.batch.spans,
    links: [],
    resources: [],
    instrumentation_scopes: [],
    logs: [],
    metric_points: [],
    log_skill_links: [],
    span_links: [],
  });
});

test("preserves resource, scope, and span-link fields through analytical conversion", async () => {
  const received: DuckDbAnalyticalBatch[] = [];
  const batch = LocalTelemetryBatch.make({
    ...request.batch,
    resources: [
      LocalTelemetryResource.make({
        resource_id: "resource-1",
        service_name: "test-service",
        platform: "codex",
        service_version: "1.2.3",
        deployment_environment: "test",
      }),
    ],
    instrumentation_scopes: [
      LocalTelemetryInstrumentationScope.make({
        scope_id: "scope-1",
        resource_id: "resource-1",
        name: "test-scope",
        version: "1.0",
      }),
    ],
    span_links: [
      LocalTelemetrySpanLink.make({
        link_id: linkId,
        trace_id: traceId,
        span_id: spanId,
        target_trace_id: "abcdef0123456789abcdef0123456789",
        target_span_id: "abcdef0123456789",
        kind: "replay_of",
      }),
    ],
  });
  await Effect.runPromise(importBatch({ ...request, batch }, received));
  expect(received).toHaveLength(1);
  expect(received[0]?.resources).toEqual(batch.resources);
  expect(received[0]?.instrumentation_scopes).toEqual(batch.instrumentation_scopes);
  expect(received[0]?.span_links).toEqual(batch.span_links);
  expect(received[0]?.logs).toEqual(batch.logs);
  expect(received[0]?.metric_points).toEqual(batch.metric_points);
  expect(received[0]?.log_skill_links).toEqual([
    {
      link_id: logLinkId,
      trace_id: traceId,
      log_id: logId,
      skill_invocation_id: "local-trace-importer-invocation",
      skill_name: "diagnose",
    },
  ]);
});

test.each([
  {
    name: "source mismatch",
    input: LocalTraceImportRequest.make({ ...request, source_kind: "pi" }),
    operation: "validate local trace source",
  },
  {
    name: "duplicate span",
    input: LocalTraceImportRequest.make({
      ...request,
      batch: LocalTelemetryBatch.make({
        ...request.batch,
        spans: [...request.batch.spans, ...request.batch.spans],
      }),
    }),
    operation: "validate local trace span identity",
  },
  {
    name: "missing canonical invocation",
    input: LocalTraceImportRequest.make({
      ...request,
      batch: LocalTelemetryBatch.make({
        ...minimalBatch,
        links: [
          LocalTelemetrySkillLink.make({
            link_id: linkId,
            trace_id: traceId,
            span_id: spanId,
            skill_invocation_id: "missing-invocation",
          }),
        ],
      }),
    }),
    operation: "resolve local trace skill invocation",
  },
])(
  "rejects $name without analytical writes or checkpoint advancement",
  async ({ input, operation }) => {
    const received: DuckDbAnalyticalBatch[] = [];
    const result = await Effect.runPromise(importBatch(input, received).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected trace import failure");
    expect(result.failure.operation).toBe(operation);
    expect(received).toEqual([]);
    expect(
      getDb()
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM analytical_import_checkpoints")
        .get(),
    ).toEqual({ count: 0 });
  },
);
