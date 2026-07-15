/**
 * SQLite database lifecycle for selftune local materialized view store.
 *
 * Uses Bun's built-in SQLite driver. The database file lives at
 * ~/.selftune/selftune.db. In dual-write mode (Phase 1+), hooks write
 * directly to SQLite alongside JSONL. The database is the primary query
 * store; JSONL serves as an append-only backup that can be exported and
 * used to repopulate a fresh DB when a manual recovery is required.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "./schema.js";

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

  try {
    // Enable WAL mode for better concurrent access
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");

    // Run all DDL statements
    for (const ddl of ALL_DDL) {
      db.run(ddl);
    }

    // Run migrations (ALTER TABLE ADD COLUMN — safe to re-run, fails silently if column exists)
    for (const migration of MIGRATIONS) {
      try {
        db.run(migration);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("duplicate column")) continue; // expected on subsequent runs
        throw new Error(
          `Schema migration failed: ${msg}. Export first with 'selftune export', then remove '${dbPath}' and rerun 'selftune sync --force'. If you need legacy/export JSONL backfill, run 'selftune recover --full --force'.`,
        );
      }
    }

    // Create indexes that depend on migration columns
    for (const idx of POST_MIGRATION_INDEXES) {
      try {
        db.run(idx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) continue; // expected on subsequent runs
        throw new Error(
          `Schema index creation failed: ${msg}. Export first with 'selftune export', then remove '${dbPath}' and rerun 'selftune sync --force'. If you need legacy/export JSONL backfill, run 'selftune recover --full --force'.`,
        );
      }
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }

  return db;
}

// -- Singleton ----------------------------------------------------------------

let _singletonDb: Database | null = null;

/**
 * Get (or create) the shared singleton database connection.
 * Hooks, ingestors, and CLI commands should use this instead of openDb()
 * to avoid repeated open/close overhead (~0.5ms per cycle).
 */
export function getDb(): Database {
  if (_singletonDb) return _singletonDb;
  _singletonDb = openDb();
  return _singletonDb;
}

/**
 * Close the singleton connection. Called on process exit or server shutdown.
 */
export function closeSingleton(): void {
  const db = _singletonDb;
  _singletonDb = null;
  if (db) {
    try {
      db.close();
    } catch {
      /* already nulled — safe to ignore */
    }
  }
}

/**
 * Test escape hatch — inject a memory db (or null to reset).
 * Use with `openDb(":memory:")` for isolated test databases.
 */
export function _setTestDb(db: Database | null): void {
  if (_singletonDb && _singletonDb !== db) {
    try {
      _singletonDb.close();
    } catch {
      /* no-op in tests */
    }
  }
  _singletonDb = db;
}

/** Get a metadata value from the _meta table. */
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
