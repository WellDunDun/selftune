import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import embeddedMigrations from "./embedded-migrations.gen.js";
import type * as localSchema from "./drizzle-schema.js";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "./legacy-schema.js";

const MIGRATIONS_TABLE = "__selftune_migrations";
const SOURCE_MIGRATIONS_FOLDER = join(import.meta.dirname, "drizzle");
const LEGACY_TABLES = ["_meta", "sessions", "session_telemetry", "skill_usage"] as const;
const RETIRED_SQLITE_TRACE_TABLES = [
  "local_trace_skill_links",
  "local_trace_metrics",
  "local_trace_spans",
] as const;
const SQLITE_TRACE_PROTOTYPE_MIGRATION = "0007_yellow_phil_sheldon";
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const STALE_MIGRATION_LOCK_MS = 5 * 60_000;
const migrationLockWaiter = new Int32Array(new SharedArrayBuffer(4));

export const MigrationJournal = Schema.Struct({
  version: Schema.String,
  dialect: Schema.Literal("sqlite"),
  entries: Schema.Array(
    Schema.Struct({
      idx: Schema.Number,
      version: Schema.String,
      tag: Schema.String,
      when: Schema.Number,
      breakpoints: Schema.Boolean,
    }),
  ),
});

const baselineSql = embeddedMigrations["0000_local_runtime_baseline.sql"];
const migrationJournal = Schema.decodeUnknownSync(Schema.fromJsonString(MigrationJournal))(
  embeddedMigrations["meta/_journal.json"],
);
const baselineEntry = migrationJournal.entries[0];
const finalizedCorrectionStudyMigration = (() => {
  const entry = migrationJournal.entries.find(
    (candidate) => candidate.tag === "0013_unique_micromax",
  );
  if (!entry) throw new Error("SelfTune's finalized correction-study migration is missing.");
  return entry;
})();
const finalizedCorrectionStudySql = embeddedMigrations["0013_unique_micromax.sql"];

if (!baselineEntry || baselineEntry.tag !== "0000_local_runtime_baseline") {
  throw new Error("SelfTune's embedded Drizzle migration journal is invalid.");
}
if (!finalizedCorrectionStudySql) {
  throw new Error("SelfTune's finalized correction-study migration is missing.");
}

let embeddedMigrationsFolder: string | null = null;

function tableExists(db: Database, table: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !==
    null
  );
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all();
  return rows.some((row) => row.name === column);
}

function hasAppliedDrizzleMigration(db: Database): boolean {
  if (!tableExists(db, MIGRATIONS_TABLE)) return false;
  return db.query(`SELECT 1 FROM "${MIGRATIONS_TABLE}" LIMIT 1`).get() !== null;
}

function hasLegacySchema(db: Database): boolean {
  return LEGACY_TABLES.some((table) => tableExists(db, table));
}

/**
 * An unreleased SQLite trace prototype could create tables before its Drizzle
 * journal row existed. Those facts are rebuildable from durable harness
 * sources and now belong in DuckDB. Clear only the unjournaled prototype so
 * generated migrations can converge the database to the current schema.
 */
function retireUnjournaledSQLiteTracePrototype(db: Database): void {
  const prototypeEntry = migrationJournal.entries.find(
    (entry) => entry.tag === SQLITE_TRACE_PROTOTYPE_MIGRATION,
  );
  if (!prototypeEntry) {
    throw new Error("SelfTune's SQLite trace-prototype migration entry is missing.");
  }
  const latestApplied = tableExists(db, MIGRATIONS_TABLE)
    ? (db
        .query<{ created_at: number | string | null }, []>(
          `SELECT MAX(created_at) AS created_at FROM "${MIGRATIONS_TABLE}"`,
        )
        .get()?.created_at ?? null)
    : null;
  if (latestApplied !== null && Number(latestApplied) >= prototypeEntry.when) return;

  for (const table of RETIRED_SQLITE_TRACE_TABLES) {
    db.run(`DROP TABLE IF EXISTS "${table}"`);
  }
}

function applyLegacyColumnMigration(db: Database, statement: string): void {
  const match = /^ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)\b/i.exec(
    statement,
  );
  if (!match) {
    throw new Error(`Unsupported legacy schema migration: ${statement}`);
  }
  const [, table, column] = match;
  if (!table || !column || columnExists(db, table, column)) return;
  try {
    db.run(statement);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/duplicate column/i.test(message) && columnExists(db, table, column)) return;
    throw cause;
  }
}

function acquireMigrationLock(db: Database): () => void {
  if (!db.filename || db.filename === ":memory:") return () => {};

  const lockPath = `${db.filename}.migration-lock`;
  const ownerPath = join(lockPath, "owner");
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(ownerPath, token, { mode: 0o600 });
      } catch (cause) {
        rmSync(lockPath, { force: true, recursive: true });
        throw cause;
      }
      return () => {
        try {
          if (readFileSync(ownerPath, "utf8") === token) {
            rmSync(lockPath, { force: true, recursive: true });
          }
        } catch {
          // A stale-lock recovery may already have replaced this owner.
        }
      };
    } catch (cause) {
      if (!Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))(cause)) throw cause;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MIGRATION_LOCK_MS) {
          rmSync(lockPath, { force: true, recursive: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the SelfTune database migration lock: ${lockPath}`, {
          cause,
        });
      }
      Atomics.wait(migrationLockWaiter, 0, 0, 25);
    }
  }
}

function stampBaselineMigration(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  const hash = createHash("sha256").update(baselineSql).digest("hex");
  db.run(`INSERT INTO "${MIGRATIONS_TABLE}" (hash, created_at) VALUES (?, ?)`, [
    hash,
    baselineEntry.when,
  ]);
}

/**
 * Bring databases created by pre-Drizzle SelfTune releases to their final
 * legacy shape, then place them at the generated Drizzle baseline. This gate
 * is intentionally separate from future generated migrations.
 */
function migrateLegacyDatabase(db: Database): void {
  if (hasAppliedDrizzleMigration(db) || !hasLegacySchema(db)) return;

  for (const statement of ALL_DDL) db.run(statement);
  for (const statement of MIGRATIONS) applyLegacyColumnMigration(db, statement);
  for (const statement of POST_MIGRATION_INDEXES) db.run(statement);
  stampBaselineMigration(db);
}

/**
 * The first correction-study preview was released before `skill_id` became a
 * durable identity and before explicit corrections required a post-edit
 * revision. SQLite cannot express this upgrade as one conditional SQL file:
 * fresh installs already have the final 0013 columns, while preview installs
 * do not. Upgrade only the preview shape before Drizzle records the forward
 * 0014 receipt. The whole table replacement is transactional, so a failed
 * migration never leaves child evidence pointing at a partial parent table.
 */
function upgradeCorrectionStudyPreviewSchema(db: Database): void {
  const tables = [
    "correction_episodes",
    "correction_evidence_ledger_entries",
    "promoted_study_cases",
  ] as const;
  if (!tables.every((table) => tableExists(db, table))) return;

  const needsUpgrade =
    !columnExists(db, "correction_episodes", "skill_id") ||
    !columnExists(db, "correction_evidence_ledger_entries", "skill_id") ||
    !columnExists(db, "promoted_study_cases", "skill_id");
  if (!needsUpgrade) return;

  const episodeSkillId = columnExists(db, "correction_episodes", "skill_id")
    ? "episode.skill_id"
    : "'legacy:' || episode.skill_name";
  const evidenceSkillId = columnExists(db, "correction_evidence_ledger_entries", "skill_id")
    ? "evidence.skill_id"
    : episodeSkillId;
  const caseSkillId = columnExists(db, "promoted_study_cases", "skill_id")
    ? "study_case.skill_id"
    : "'legacy:' || study_case.skill_name";

  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE __selftune_new_correction_episodes (
        episode_id TEXT PRIMARY KEY NOT NULL,
        capture_key TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        harness TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        pre_revision TEXT NOT NULL,
        post_revision TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        correction_intent_json TEXT NOT NULL,
        trace_payload_json TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        captured_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      INSERT INTO __selftune_new_correction_episodes
      SELECT
        episode.episode_id,
        episode.capture_key,
        ${episodeSkillId},
        episode.skill_name,
        episode.skill_path,
        episode.harness,
        episode.source_session_id,
        episode.pre_revision,
        COALESCE(episode.post_revision, episode.pre_revision),
        episode.manifest_json,
        episode.correction_intent_json,
        episode.trace_payload_json,
        episode.evidence_level,
        episode.status,
        episode.reason,
        episode.captured_at,
        episode.created_at,
        episode.updated_at
      FROM correction_episodes AS episode
    `);
    db.run(`
      CREATE TABLE __selftune_new_correction_evidence (
        evidence_id TEXT PRIMARY KEY NOT NULL,
        skill_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        manifest_json TEXT NOT NULL,
        verifier_payload_json TEXT NOT NULL,
        trial_payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES __selftune_new_correction_episodes(episode_id) ON DELETE CASCADE
      )
    `);
    db.run(`
      INSERT INTO __selftune_new_correction_evidence
      SELECT
        evidence.evidence_id,
        ${evidenceSkillId},
        evidence.episode_id,
        evidence.evidence_key,
        evidence.evidence_level,
        evidence.status,
        evidence.reason,
        evidence.manifest_json,
        evidence.verifier_payload_json,
        evidence.trial_payload_json,
        evidence.recorded_at
      FROM correction_evidence_ledger_entries AS evidence
      JOIN correction_episodes AS episode ON episode.episode_id = evidence.episode_id
    `);
    db.run(`
      CREATE TABLE __selftune_new_promoted_study_cases (
        case_id TEXT PRIMARY KEY NOT NULL,
        episode_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        pre_revision TEXT NOT NULL,
        post_revision TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        verifier_payload_json TEXT NOT NULL,
        trial_payload_json TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        promoted_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES __selftune_new_correction_episodes(episode_id) ON DELETE RESTRICT,
        FOREIGN KEY (evidence_id) REFERENCES __selftune_new_correction_evidence(evidence_id) ON DELETE RESTRICT
      )
    `);
    db.run(`
      INSERT INTO __selftune_new_promoted_study_cases
      SELECT
        study_case.case_id,
        study_case.episode_id,
        study_case.evidence_id,
        study_case.skill_name,
        ${caseSkillId},
        study_case.pre_revision,
        study_case.post_revision,
        study_case.manifest_json,
        study_case.verifier_payload_json,
        study_case.trial_payload_json,
        study_case.evidence_level,
        study_case.status,
        study_case.reason,
        study_case.promoted_at,
        study_case.created_at
      FROM promoted_study_cases AS study_case
    `);
    db.run("DROP TABLE promoted_study_cases");
    db.run("DROP TABLE correction_evidence_ledger_entries");
    db.run("DROP TABLE correction_episodes");
    db.run("ALTER TABLE __selftune_new_correction_episodes RENAME TO correction_episodes");
    db.run(
      "ALTER TABLE __selftune_new_correction_evidence RENAME TO correction_evidence_ledger_entries",
    );
    db.run("ALTER TABLE __selftune_new_promoted_study_cases RENAME TO promoted_study_cases");
    db.run(
      "CREATE UNIQUE INDEX correction_episodes_capture_key_unique ON correction_episodes (capture_key)",
    );
    db.run(
      "CREATE INDEX idx_correction_episodes_skill ON correction_episodes (skill_id, updated_at)",
    );
    db.run(
      "CREATE INDEX idx_correction_episodes_status ON correction_episodes (status, updated_at)",
    );
    db.run(
      "CREATE INDEX idx_correction_episodes_source_session ON correction_episodes (source_session_id)",
    );
    db.run(
      "CREATE UNIQUE INDEX correction_evidence_ledger_episode_key_unique ON correction_evidence_ledger_entries (episode_id, evidence_key)",
    );
    db.run(
      "CREATE INDEX idx_correction_evidence_ledger_episode ON correction_evidence_ledger_entries (episode_id, recorded_at)",
    );
    db.run(
      "CREATE INDEX idx_correction_evidence_ledger_status ON correction_evidence_ledger_entries (status, recorded_at)",
    );
    db.run(
      "CREATE UNIQUE INDEX promoted_study_cases_episode_unique ON promoted_study_cases (episode_id)",
    );
    db.run(
      "CREATE INDEX idx_promoted_study_cases_skill ON promoted_study_cases (skill_id, promoted_at)",
    );
    db.run("CREATE INDEX idx_promoted_study_cases_evidence ON promoted_study_cases (evidence_id)");
    db.run(
      `INSERT INTO "${MIGRATIONS_TABLE}" (hash, created_at)
       SELECT ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM "${MIGRATIONS_TABLE}" WHERE created_at = ?
       )`,
      [
        createHash("sha256").update(finalizedCorrectionStudySql).digest("hex"),
        finalizedCorrectionStudyMigration.when,
        finalizedCorrectionStudyMigration.when,
      ],
    );
    db.run("COMMIT");
  } catch (cause) {
    try {
      db.run("ROLLBACK");
    } catch {
      // The failing statement may already have rolled back the transaction.
    }
    throw cause;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

function resolveMigrationsFolder(): string {
  if (existsSync(join(SOURCE_MIGRATIONS_FOLDER, "meta", "_journal.json"))) {
    return SOURCE_MIGRATIONS_FOLDER;
  }
  if (embeddedMigrationsFolder) return embeddedMigrationsFolder;

  const folder = mkdtempSync(join(tmpdir(), "selftune-drizzle-"));
  for (const [relativePath, contents] of Object.entries(embeddedMigrations)) {
    const path = join(folder, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  embeddedMigrationsFolder = folder;
  return folder;
}

export function migrateLocalDatabase(
  sqlite: Database,
  drizzleDb: BunSQLiteDatabase<typeof localSchema>,
): void {
  const releaseLock = acquireMigrationLock(sqlite);
  try {
    // WAL activation can require recovery locks, so it belongs inside the same
    // cross-process critical section as schema migration.
    sqlite.run("PRAGMA journal_mode = WAL");
    migrateLegacyDatabase(sqlite);
    retireUnjournaledSQLiteTracePrototype(sqlite);
    upgradeCorrectionStudyPreviewSchema(sqlite);
    migrate(drizzleDb, {
      migrationsFolder: resolveMigrationsFolder(),
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    releaseLock();
  }
}
