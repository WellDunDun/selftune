/**
 * Schema migration runner for the selftune badge service.
 *
 * Uses a simple version tracking approach. Migrations are applied
 * in order and tracked in a migrations table.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function runMigrations(db: Database): void {
  // Ensure migrations tracking table exists
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db
      .query("SELECT version FROM schema_migrations")
      .all()
      .map((r: any) => r.version as number),
  );

  // Migration 1: Initial schema
  if (!applied.has(1)) {
    const schemaPath = join(import.meta.dir, "schema.sql");
    const sql = readFileSync(schemaPath, "utf-8");
    db.exec(sql);
    db.run("INSERT INTO schema_migrations (version) VALUES (?)", [1]);
  }
}
