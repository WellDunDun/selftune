/**
 * SQLite database lifecycle for selftune local materialized view store.
 *
 * Uses Drizzle over Bun's built-in SQLite driver. The database file lives at
 * ~/.selftune/selftune.db. In dual-write mode (Phase 1+), hooks write
 * directly to SQLite alongside JSONL. The database is the primary query
 * store; JSONL serves as an append-only backup that can be exported and
 * used to repopulate a fresh DB when a manual recovery is required.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { _meta as meta } from "./drizzle-schema.js";
import * as schema from "./drizzle-schema.js";
import { migrateLocalDatabase } from "./migrations.js";
import { SELFTUNE_LOCAL_DATABASE_PATH } from "@selftune/config/paths";

/** Default database file path. */
export const DB_PATH = SELFTUNE_LOCAL_DATABASE_PATH;

function createDrizzleDatabase(sqlite: Database) {
  return drizzle({ client: sqlite, schema });
}

export type LocalDrizzleDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface LocalDatabaseHandle {
  readonly sqlite: Database;
  readonly drizzle: LocalDrizzleDatabase;
}

export class LocalDatabaseError extends Data.TaggedError("LocalDatabaseError")<{
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const drizzleDatabases = new WeakMap<Database, LocalDrizzleDatabase>();

/**
 * Open (or create) the selftune SQLite database at the given path.
 * Applies committed Drizzle migrations and uses WAL mode for concurrent
 * read/write safety. Existing pre-Drizzle files pass through a one-time
 * compatibility gate before joining the generated migration chain.
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
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");

    getDrizzleDb(db);
  } catch (err) {
    drizzleDatabases.delete(db);
    try {
      db.close();
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }

  return db;
}

/** Return the typed Drizzle handle sharing the supplied Bun SQLite connection. */
export function getDrizzleDb(db: Database = getDb()): LocalDrizzleDatabase {
  const existing = drizzleDatabases.get(db);
  if (existing) return existing;

  const drizzleDb = createDrizzleDatabase(db);
  migrateLocalDatabase(db, drizzleDb);
  drizzleDatabases.set(db, drizzleDb);
  return drizzleDb;
}

// -- Singleton ----------------------------------------------------------------

let _singletonDb: Database | null = null;
let singletonLeaseCount = 0;
let singletonLeaseOwnsConnection = false;

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

export interface SingletonDatabaseLease extends LocalDatabaseHandle {
  readonly release: () => void;
}

/**
 * Lease the singleton without closing a connection that was already owned by
 * another host. The final lease closes only a connection created by the lease
 * group itself.
 */
export function acquireSingletonDatabaseLease(): SingletonDatabaseLease {
  const hadConnection = _singletonDb !== null;
  const sqlite = getDb();
  if (!hadConnection && singletonLeaseCount === 0) singletonLeaseOwnsConnection = true;
  singletonLeaseCount += 1;
  let released = false;

  return {
    sqlite,
    drizzle: getDrizzleDb(sqlite),
    release: () => {
      if (released) return;
      released = true;
      singletonLeaseCount = Math.max(0, singletonLeaseCount - 1);
      if (singletonLeaseCount === 0 && singletonLeaseOwnsConnection) {
        singletonLeaseOwnsConnection = false;
        closeSingleton();
      }
    },
  };
}

/**
 * Close the singleton connection. Called on process exit or server shutdown.
 */
export function closeSingleton(): void {
  const db = _singletonDb;
  _singletonDb = null;
  singletonLeaseOwnsConnection = false;
  if (db) {
    drizzleDatabases.delete(db);
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
    drizzleDatabases.delete(_singletonDb);
    try {
      _singletonDb.close();
    } catch {
      /* no-op in tests */
    }
  }
  _singletonDb = db;
  singletonLeaseCount = 0;
  singletonLeaseOwnsConnection = false;
}

/** Get a metadata value from the _meta table. */
export function getMeta(db: Database, key: string): string | null {
  const row = getDrizzleDb(db)
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, key))
    .get();
  return row?.value ?? null;
}

/**
 * Set a metadata value in the _meta table.
 */
export function setMeta(db: Database, key: string, value: string): void {
  getDrizzleDb(db)
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}

/** Effect-owned database lifecycle for long-running local hosts. */
export class LocalDatabaseService extends Context.Service<
  LocalDatabaseService,
  LocalDatabaseHandle
>()("@selftune/local-store/LocalDatabaseService") {}

export function makeLocalDatabaseLive(dbPath: string = DB_PATH) {
  return Layer.effect(LocalDatabaseService)(
    Effect.acquireRelease(
      Effect.try({
        try: (): LocalDatabaseHandle => {
          const sqlite = openDb(dbPath);
          return { sqlite, drizzle: getDrizzleDb(sqlite) };
        },
        catch: (cause) =>
          new LocalDatabaseError({
            path: dbPath,
            message: `Unable to open the local SelfTune database at ${dbPath}.`,
            cause,
          }),
      }),
      ({ sqlite }) =>
        Effect.sync(() => {
          drizzleDatabases.delete(sqlite);
          try {
            sqlite.close();
          } catch {
            /* best-effort release */
          }
        }),
    ),
  );
}

export const LocalDatabaseLive = makeLocalDatabaseLive();
