import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  makeDuckDbAnalyticalStoreLive,
  type DuckDbAppendValue,
  type DuckDbConnection,
  type DuckDbInstanceFactory,
} from "./duckdb-store.js";

const desktopResourceDirectory = process.env.SELFTUNE_DESKTOP_RESOURCE_DIR;
const packagedDesktopResourceDirectory =
  desktopResourceDirectory === undefined || desktopResourceDirectory.length === 0
    ? undefined
    : desktopResourceDirectory;
const duckDbModule =
  packagedDesktopResourceDirectory === undefined
    ? await import(["@duckdb", "node-api"].join("/"))
    : await import(
        pathToFileURL(
          join(packagedDesktopResourceDirectory, "node_modules/@duckdb/node-api/lib/index.js"),
        ).href
      );
const { DuckDBInstance, DuckDBTimestampValue } = duckDbModule as typeof import("@duckdb/node-api");

/** Bounded desktop analytical-store memory; DuckDB never receives an unlimited process budget. */
export const DUCKDB_LOCAL_MEMORY_LIMIT = "512MB";

function appendScalar(
  appender: import("@duckdb/node-api").DuckDBAppender,
  value: DuckDbAppendValue,
) {
  if (value === null) {
    appender.appendNull();
  } else if (typeof value === "number") {
    if (Number.isInteger(value)) {
      appender.appendBigInt(BigInt(value));
    } else {
      appender.appendDouble(value);
    }
  } else if (typeof value === "string") {
    appender.appendVarchar(value);
  } else {
    appender.appendTimestamp(new DuckDBTimestampValue(value.micros));
  }
}

/**
 * The only production bridge to DuckDB's Node API. It is intentionally kept
 * behind the analytical-store contract so callers cannot acquire arbitrary
 * DuckDB connections or couple operational code to the driver.
 */
const duckDbNodeApiFactory: DuckDbInstanceFactory = {
  open: async (databasePath) => {
    const instance = await DuckDBInstance.create(databasePath, {
      memory_limit: DUCKDB_LOCAL_MEMORY_LIMIT,
      preserve_insertion_order: "false",
      threads: "2",
    });
    return {
      closeSync: () => instance.closeSync(),
      connect: async () => {
        const nativeConnection = await instance.connect();
        const connection: DuckDbConnection = {
          appendRows: async (table, rows) => {
            if (rows.length === 0) return;
            const appender = await nativeConnection.createAppender(table);
            try {
              for (const row of rows) {
                for (const value of row) appendScalar(appender, value);
                appender.endRow();
              }
              appender.flushSync();
            } finally {
              appender.closeSync();
            }
          },
          closeSync: () => nativeConnection.closeSync(),
          run: (sql, parameters) => nativeConnection.run(sql, parameters),
        };
        return connection;
      },
    };
  },
};

export const makeDuckDbNodeApiAnalyticalStoreLive = (databasePath?: string) =>
  makeDuckDbAnalyticalStoreLive(duckDbNodeApiFactory, databasePath);

export const DuckDbAnalyticalStoreLive = makeDuckDbNodeApiAnalyticalStoreLive();
