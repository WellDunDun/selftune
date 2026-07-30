import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDbAnalyticalStore } from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import * as Effect from "effect/Effect";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const resource = {
  resource_id: "resource-otlp-shared",
  service_name: "agent-host",
  service_namespace: "selftune",
  service_instance_id: "local-agent-1",
  deployment_environment: "development",
  platform: "otlp" as const,
};
const scope = {
  scope_id: "scope-otlp-shared",
  resource_id: resource.resource_id,
  name: "agent.instrumentation",
};
const traceId = "a".repeat(32);

const traceBatch = (batchId: string, spanId: string, sourceRevision: string) => ({
  schema_version: "1.0.0" as const,
  batch_id: batchId,
  source_revision: sourceRevision,
  normalizer_version: "otlp-v1",
  spans: [
    {
      trace_id: traceId,
      span_id: spanId,
      name: "invoke_agent",
      started_at: "2026-07-23T10:00:00.000Z",
      ended_at: "2026-07-23T10:00:05.000Z",
      platform: "otlp" as const,
      capture_mode: "otlp" as const,
      source_authority: "external" as const,
      trace_boundary: "actionable_turn" as const,
      operation_name: "invoke_agent",
      source_id: `source-${spanId}`,
      resource_id: resource.resource_id,
      scope_id: scope.scope_id,
      input_tokens: 0,
      output_tokens: 0,
      error_count: 0,
      tool_call_count: 0,
    },
  ],
  links: [],
  resources: [resource],
  instrumentation_scopes: [scope],
});

test("keeps repeated OTLP dimensions batch-scoped through revision and replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-repeat-dimensions-"));
  directories.push(directory);
  const first = traceBatch("batch-otlp-first", "1".repeat(16), "revision-1");
  const second = traceBatch("batch-otlp-second", "2".repeat(16), "revision-1");
  const revisedFirst = traceBatch("batch-otlp-first", "1".repeat(16), "revision-2");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      const firstReceipt = yield* store.ingest(first);
      const secondReceipt = yield* store.ingest(second);
      const revisionReceipt = yield* store.ingest(revisedFirst);
      const replayReceipt = yield* store.ingest(revisedFirst);
      return {
        firstReceipt,
        secondReceipt,
        revisionReceipt,
        replayReceipt,
        health: yield* store.health(),
      };
    }).pipe(
      Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(join(directory, "observability.duckdb"))),
      Effect.scoped,
    ),
  );

  expect(
    [result.firstReceipt, result.secondReceipt, result.revisionReceipt].every(
      (receipt) => receipt.disposition === "accepted",
    ),
  ).toBe(true);
  expect(result.replayReceipt.disposition).toBe("duplicate");
  expect(result.health).toMatchObject({ span_count: 2, resource_count: 2, scope_count: 2 });
});

test("accepts a logs-only OTLP batch correlated to an earlier trace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-logs-only-"));
  directories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const trace = traceBatch("batch-otlp-trace", "3".repeat(16), "revision-1");
  const logs = {
    ...traceBatch("batch-otlp-logs", "4".repeat(16), "revision-1"),
    spans: [],
    resources: [],
    instrumentation_scopes: [],
    logs: [
      {
        log_id: "log-otlp-later",
        trace_id: traceId,
        span_id: "3".repeat(16),
        timestamp: "2026-07-23T10:00:02.000Z",
        event_name: "selftune.progress",
      },
    ],
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest(trace);
      const accepted = yield* store.ingest(logs);
      const replay = yield* store.ingest(logs);
      return { accepted, replay, health: yield* store.health() };
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
  );

  expect(result.accepted.disposition).toBe("accepted");
  expect(result.replay.disposition).toBe("duplicate");
  expect(result.health).toMatchObject({ span_count: 1, log_count: 1 });
});

test("keeps same span IDs in separate traces distinct for metrics and skill signals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-trace-span-identity-"));
  directories.push(directory);
  const sameSpanId = "5".repeat(16);
  const first = {
    ...traceBatch("batch-trace-first", sameSpanId, "revision-1"),
    spans: [
      { ...traceBatch("batch-trace-first", sameSpanId, "revision-1").spans[0], input_tokens: 1 },
    ],
    links: [
      {
        link_id: "6".repeat(32),
        trace_id: traceId,
        span_id: sameSpanId,
        skill_invocation_id: "invoke-first",
        skill_name: "diagnose",
      },
    ],
  };
  const secondTraceId = "b".repeat(32);
  const second = {
    ...traceBatch("batch-trace-second", sameSpanId, "revision-1"),
    spans: [
      {
        ...traceBatch("batch-trace-second", sameSpanId, "revision-1").spans[0],
        trace_id: secondTraceId,
        input_tokens: 2,
      },
    ],
    links: [
      {
        link_id: "7".repeat(32),
        trace_id: secondTraceId,
        span_id: sameSpanId,
        skill_invocation_id: "invoke-second",
        skill_name: "diagnose",
      },
    ],
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest(first);
      yield* store.ingest(second);
      return { health: yield* store.health(), signals: yield* store.querySkillSignals() };
    }).pipe(
      Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(join(directory, "observability.duckdb"))),
      Effect.scoped,
    ),
  );

  expect(result.health).toMatchObject({ span_count: 2, metric_count: 10, link_count: 2 });
  expect(result.signals).toContainEqual(
    expect.objectContaining({
      skill_name: "diagnose",
      invocation_count: 2,
      trace_count: 2,
      duration_ms: 10_000,
      input_tokens: 3,
    }),
  );
});
