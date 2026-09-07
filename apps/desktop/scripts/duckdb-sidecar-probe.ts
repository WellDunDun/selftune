import { join } from "node:path";
import { pathToFileURL } from "node:url";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Expected a file-backed DuckDB path.");
const resourceRoot = process.env.SELFTUNE_DESKTOP_RESOURCE_DIR;
if (!resourceRoot) throw new Error("Expected the packaged Desktop resource directory.");
// SAFETY: This fixed SDK entrypoint has @duckdb/node-api's declarations; a file URL
// loses static module resolution. The probe exercises its instance, connection, and reader below.
const { DuckDBInstance } = (await import(
  pathToFileURL(join(resourceRoot, "node_modules/@duckdb/node-api/lib/index.js")).href
)) as typeof import("@duckdb/node-api");

const instance = await DuckDBInstance.create(databasePath);
const connection = await instance.connect();
try {
  await connection.run("CREATE TABLE packaged_duckdb_probe (value INTEGER)");
  await connection.run("INSERT INTO packaged_duckdb_probe VALUES (1)");
  const reader = await connection.runAndReadAll("SELECT value FROM packaged_duckdb_probe");
  const rows = reader.getRowObjects();
  if (rows.length !== 1 || rows[0]?.value !== 1) {
    throw new Error("DuckDB probe did not persist the expected value.");
  }
} finally {
  connection.closeSync();
  instance.closeSync();
}
