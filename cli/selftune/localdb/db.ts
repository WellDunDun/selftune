/**
 * SQLite database lifecycle for selftune local materialized view store.
 *
 * Uses Bun's built-in SQLite driver. The database file lives at
 * ~/.selftune/selftune.db and is treated as a disposable cache —
 * it can always be rebuilt from the authoritative JSONL logs.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { ALL_DDL } from "./schema.js";

/** Default database file path. */
export const DB_PATH = join(SELFTUNE_CONFIG_DIR, "selftune.db");

/**
 * Open (or create) the selftune SQLite database at the given path.
 * Runs all DDL to ensure the schema exists. Uses WAL mode for
 * concurrent read/write safety.
 *
 * Pass ":memory:" for an in-memory database (useful for tests).
 */
export function openDb(dbPath: string = DB_PATH): Database {
  // Ensure parent directory exists for file-based databases
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Run all DDL statements
  for (const ddl of ALL_DDL) {
    db.run(ddl);
  }

  return db;
}

/**
 * Get a metadata value from the _meta table.
 */
export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM _meta WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

/**
 * Set a metadata value in the _meta table.
 */
export function setMeta(db: Database, key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", [key, value]);
}
