import { join, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Expected a file-backed DuckDB path.");
const resourceRoot = process.env.SELFTUNE_DESKTOP_RESOURCE_DIR;
if (!resourceRoot) throw new Error("Expected the packaged Desktop resource directory.");
const { DuckDBInstance } = (await import(
  pathToFileURL(toNamespacedPath(join(resourceRoot, "node_modules/@duckdb/node-api/lib/index.js")))
    .href
)) as typeof import("@duckdb/node-api");

const instance = await DuckDBInstance.create(databasePath);
const connection = await instance.connect();
try {
  await connection.run("CREATE TABLE packaged_duckdb_probe (value INTEGER)");
  await connection.run("INSERT INTO packaged_duckdb_probe VALUES (1)");
  const reader = await connection.runAndReadAll("SELECT value FROM packaged_duckdb_probe");
  if (reader.getRowObjects().length !== 1) throw new Error("DuckDB probe did not persist a row.");
} finally {
  connection.closeSync();
  instance.closeSync();
}
