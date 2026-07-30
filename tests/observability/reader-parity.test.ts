import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DuckDBInstance } from "@duckdb/node-api";

import {
  compareTraceEvidencePages,
  makeCompatibilitySqliteTraceEvidenceReader,
  makeDuckDbTraceEvidenceReader,
  makeRollbackSafeReaderSelector,
  measureTraceEvidenceReader,
  type CompatibilitySqliteQuery,
} from "@selftune/observability/reader-parity";
import type { DuckDbConnection } from "@selftune/observability/duckdb-store";

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    observed_at: `2026-07-23T10:00:${String(index).padStart(2, "0")}.000Z`,
    source_id: `execution_fact:${index}`,
    evidence_id: `execution_fact:${index}:duration_ms`,
    source_kind: "codex",
    source_reference: `source-${index}`,
    metric_name: "duration_ms",
    metric_value: index + 1,
    metric_unit: "ms",
    evidence_quality: "source_exact",
    trace_id: "a".repeat(32),
    span_id: null,
    log_id: `log-${index}`,
    skill_name: "diagnose",
    metric_temporality: "cumulative",
  }));

const sqlite = (source: ReadonlyArray<Record<string, unknown>>): CompatibilitySqliteQuery => ({
  query: (sql, parameters) => {
    expect(sql).toContain("LIMIT $limit_plus_one");
    const limit = Number(parameters.$limit_plus_one);
    return source.slice(0, limit);
  },
});

const duck = (source: ReadonlyArray<Record<string, unknown>>): DuckDbConnection => ({
  appendRows: async () => undefined,
  closeSync: () => undefined,
  run: async (sql, parameters) => {
    expect(sql).toContain("observability_historical_metric_points");
    const limit = Number(parameters?.limit_plus_one);
    return { getRowObjects: async () => source.slice(0, limit) };
  },
});

const fixedMemoryUsage = () => ({ rss: 128 * 1024 * 1024 }) as NodeJS.MemoryUsage;

test("compares like-for-like cumulative points without claiming unavailable identities", async () => {
  const source = rows(3);
  const compatibility = makeCompatibilitySqliteTraceEvidenceReader(sqlite(source), "current");
  const analytical = makeDuckDbTraceEvidenceReader(duck(source), "current");
  const request = { limit: 2 };
  const [left, right] = await Promise.all([
    compatibility.readPage(request),
    analytical.readPage(request),
  ]);
  const proof = compareTraceEvidencePages(left, right, true);

  expect(left.items).toHaveLength(2);
  expect(left.items[0]?.trace_id).toBeUndefined();
  expect(left.items[0]?.metric_temporality).toBe("cumulative");
  expect(right.items[0]?.trace_id).toBe("a".repeat(32));
  expect(proof).toMatchObject({
    comparable_rows: 2,
    matching_rows: 2,
    fresh: true,
    current_checkpoint: true,
    mismatches: [],
  });
});

test("keeps constant visible output bounded across 1x and 10x corpora", async () => {
  const request = { limit: 16 };
  const one = await measureTraceEvidenceReader(
    makeDuckDbTraceEvidenceReader(duck(rows(100)), "current"),
    request,
    fixedMemoryUsage,
  );
  const ten = await measureTraceEvidenceReader(
    makeDuckDbTraceEvidenceReader(duck(rows(1_000)), "current"),
    request,
    fixedMemoryUsage,
  );

  expect(one.page.items).toHaveLength(16);
  expect(ten.page.items).toHaveLength(16);
  expect(ten.measurement.facts_visited).toBeLessThanOrEqual(17);
  expect(ten.measurement.response_bytes).toBe(one.measurement.response_bytes);
  expect(ten.measurement.process_rss_bytes).toBe(one.measurement.process_rss_bytes);
  expect(ten.measurement.sqlite_checkpoint_state).toBe("current");
});

test("refuses empty, stale, or mismatched proof and supports an immediate rollback", async () => {
  const compatibility = makeCompatibilitySqliteTraceEvidenceReader(sqlite(rows(1)), "current");
  const analytical = makeDuckDbTraceEvidenceReader(duck(rows(1)), "current");
  const selector = makeRollbackSafeReaderSelector(compatibility);
  const valid = compareTraceEvidencePages(
    await compatibility.readPage({ limit: 1 }),
    await analytical.readPage({ limit: 1 }),
    true,
  );
  expect(selector.promote(analytical, { ...valid, comparable_rows: 0 })).toBe(false);
  expect(selector.promote(analytical, valid)).toBe(true);
  expect(selector.active().kind).toBe("duckdb");
  selector.rollback();
  expect(selector.active().kind).toBe("compatibility_sqlite");
});

test("parity uses the same execution-fact cursor identity in real SQLite and DuckDB", async () => {
  const sqliteDb = new Database(":memory:");
  sqliteDb.run("CREATE TABLE sessions (session_id TEXT, platform TEXT, raw_source_ref TEXT)");
  sqliteDb.run(
    "CREATE TABLE execution_facts (id INTEGER, execution_fact_id TEXT, session_id TEXT, occurred_at TEXT, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tool_calls INTEGER, errors_encountered INTEGER, raw_source_ref TEXT)",
  );
  sqliteDb.run("INSERT INTO sessions VALUES ('s1', 'codex', 'raw/session-1')");
  sqliteDb.run(
    "INSERT INTO execution_facts VALUES (1, 'fact-1', 's1', '2026-07-23T10:00:00.000Z', 10, NULL, NULL, NULL, NULL, 'raw/fact-1')",
  );
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    "CREATE TABLE observability_historical_metric_points (metric_id VARCHAR, trace_id VARCHAR, span_id VARCHAR, log_id VARCHAR, observed_at TIMESTAMP, metric_name VARCHAR, value DOUBLE, unit VARCHAR, temporality VARCHAR, evidence_quality VARCHAR, source_id VARCHAR, source_kind VARCHAR, source_reference VARCHAR, batch_id VARCHAR)",
  );
  await connection.run(
    "CREATE TABLE observability_historical_log_skill_links (log_id VARCHAR, skill_name VARCHAR)",
  );
  await connection.run(
    "INSERT INTO observability_historical_metric_points VALUES ('hashed-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL, TIMESTAMP '2026-07-23 10:00:00', 'duration_ms', 10, 'ms', 'cumulative', 'source_exact', 'execution_fact:fact-1', 'codex', 'raw/fact-1', 'b1')",
  );
  await connection.run(
    "INSERT INTO observability_historical_metric_points VALUES ('extra-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL, TIMESTAMP '2026-07-23 10:00:00', 'assistant_turns', 3, 'count', 'cumulative', 'source_exact', 'execution_fact:fact-1', 'codex', 'raw/fact-1', 'b1')",
  );
  const compatibility = makeCompatibilitySqliteTraceEvidenceReader(
    {
      query: (sql, parameters) => sqliteDb.query(sql).all(parameters) as Record<string, unknown>[],
    },
    "current",
  );
  const analytical = makeDuckDbTraceEvidenceReader(
    {
      appendRows: async () => undefined,
      closeSync: () => connection.closeSync(),
      run: (sql, parameters) => connection.run(sql, parameters),
    },
    "current",
  );
  const proof = compareTraceEvidencePages(
    await compatibility.readPage({ limit: 1 }),
    await analytical.readPage({ limit: 1 }),
    true,
  );
  connection.closeSync();
  instance.closeSync();
  sqliteDb.close();

  expect(proof).toMatchObject({ comparable_rows: 1, matching_rows: 1, mismatches: [] });
});
