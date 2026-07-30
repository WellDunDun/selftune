import { expect, test } from "bun:test";

import {
  DuckDbAnalyticalStore,
  makeDuckDbAnalyticalStoreLive,
  type DuckDbInstanceFactory,
  type DuckDbQueryResult,
} from "@selftune/observability/duckdb-store";
import * as Effect from "effect/Effect";

const emptyResult = (): DuckDbQueryResult => ({ getRowObjects: async () => [] });

test("runs the historical v4 rebuild once, then applies v5-v9 migrations", async () => {
  const statements: string[] = [];
  let version = 3;
  const factory: DuckDbInstanceFactory = {
    open: async () => ({
      closeSync: () => undefined,
      connect: async () => ({
        appendRows: async () => undefined,
        closeSync: () => undefined,
        run: async (sql) => {
          statements.push(sql);
          if (sql.includes("SELECT MAX(version)")) {
            return { getRowObjects: async () => [{ version }] };
          }
          if (sql.includes("VALUES (5)")) version = 5;
          if (sql.includes("VALUES (6)")) version = 6;
          if (sql.includes("VALUES (7)")) version = 7;
          if (sql.includes("VALUES (8)")) version = 8;
          if (sql.includes("VALUES (9)")) version = 9;
          return emptyResult();
        },
      }),
    }),
  };
  const openStore = () =>
    Effect.gen(function* () {
      yield* DuckDbAnalyticalStore;
    }).pipe(Effect.provide(makeDuckDbAnalyticalStoreLive(factory, ":memory:")), Effect.scoped);

  await Effect.runPromise(openStore());
  const firstOpenStatementCount = statements.length;
  await Effect.runPromise(openStore());

  expect(version).toBe(9);
  expect(
    statements.filter((statement) =>
      statement.includes("DROP TABLE IF EXISTS observability_spans_v4"),
    ),
  ).toHaveLength(1);
  expect(
    statements.filter((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS observability_historical_metric_rollups"),
    ),
  ).toHaveLength(1);
  expect(
    statements.some(
      (statement) =>
        statement.includes("INSERT INTO observability_historical_metric_rollups") &&
        statement.includes("ORDER BY observed_at DESC, metric_id DESC"),
    ),
  ).toBe(true);
  expect(
    statements.some((statement) =>
      statement.includes("DROP INDEX IF EXISTS observability_historical_metric_points_latest"),
    ),
  ).toBe(true);
  expect(
    statements.some((statement) =>
      statement.includes("DROP INDEX IF EXISTS observability_historical_metric_points_batch"),
    ),
  ).toBe(true);
  expect(
    statements.some((statement) =>
      statement.includes(
        "CREATE TABLE IF NOT EXISTS observability_historical_metric_rollup_staging",
      ),
    ),
  ).toBe(true);
  expect(
    statements.some(
      (statement) =>
        statement.includes(
          "CREATE INDEX IF NOT EXISTS observability_historical_metric_points_latest",
        ) ||
        statement.includes(
          "CREATE INDEX IF NOT EXISTS observability_historical_metric_points_batch",
        ),
    ),
  ).toBe(false);
  expect(
    statements.filter((statement) => statement.includes("INSERT INTO observability_spans_v4")),
  ).toHaveLength(1);
  expect(
    statements.filter((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS observability_historical_metric_points"),
    ),
  ).toHaveLength(1);
  expect(
    statements.filter((statement) =>
      statement.includes("ADD COLUMN IF NOT EXISTS conversation_id"),
    ),
  ).toHaveLength(1);
  expect(
    statements.filter((statement) => statement.includes("ADD COLUMN IF NOT EXISTS tool_name")),
  ).toHaveLength(1);
  expect(statements.slice(firstOpenStatementCount)).toEqual([
    expect.stringContaining("CREATE TABLE IF NOT EXISTS observability_schema_migrations"),
    expect.stringContaining("SELECT MAX(version)"),
  ]);
});

test("does not apply historical migrations to a future schema version", async () => {
  const statements: string[] = [];
  const factory: DuckDbInstanceFactory = {
    open: async () => ({
      closeSync: () => undefined,
      connect: async () => ({
        appendRows: async () => undefined,
        closeSync: () => undefined,
        run: async (sql) => {
          statements.push(sql);
          if (sql.includes("SELECT MAX(version)")) {
            return { getRowObjects: async () => [{ version: 10 }] };
          }
          return emptyResult();
        },
      }),
    }),
  };

  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* DuckDbAnalyticalStore;
    }).pipe(Effect.provide(makeDuckDbAnalyticalStoreLive(factory, ":memory:")), Effect.scoped),
  );

  expect(result._tag).toBe("Failure");
  expect(statements).toHaveLength(2);
  expect(statements.some((statement) => statement.includes("observability_spans_v4"))).toBe(false);
  expect(statements.some((statement) => statement.startsWith("ALTER TABLE"))).toBe(false);
});
