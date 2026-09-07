import assert from "node:assert/strict";
import { Schema } from "effect";
import { MigrationJournal } from "@selftune/local-store/migrations";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle as createDrizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { getDrizzleDb, openDb } from "@selftune/local-store";
import embeddedMigrations from "@selftune/local-store/embedded-migrations";
import { sessions } from "@selftune/local-store/schema";

const temporaryRoots: string[] = [];
const migrationFiles = new Map(Object.entries(embeddedMigrations));
const expectedMigrationCount = Object.keys(embeddedMigrations).filter((path) =>
  /^\d+_.+\.sql$/.test(path),
).length;

function createLegacyDatabase(path: string): void {
  const legacy = new Database(path);
  legacy.run(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT,
      ended_at TEXT,
      platform TEXT,
      model TEXT,
      completion_status TEXT,
      source_session_kind TEXT,
      agent_cli TEXT,
      workspace_path TEXT,
      repo_remote TEXT,
      branch TEXT,
      schema_version TEXT,
      normalized_at TEXT
    )
  `);
  legacy.run("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  legacy.run("INSERT INTO sessions (session_id, platform) VALUES (?, ?)", [
    "legacy-session",
    "claude_code",
  ]);
  legacy.close();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Drizzle local database", () => {
  it("rejects malformed journal metadata before migrations can use it", () => {
    const journal = Schema.decodeUnknownSync(Schema.fromJsonString(MigrationJournal))(
      embeddedMigrations["meta/_journal.json"],
    );
    expect(() =>
      Schema.decodeUnknownSync(MigrationJournal)({
        ...journal,
        entries: [{ ...journal.entries[0], when: "not a timestamp" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MigrationJournal)({ ...journal, entries: [null] }),
    ).toThrow();
  });
  it("runs the generated baseline and exposes typed reads and writes", () => {
    const sqlite = openDb(":memory:");
    try {
      const drizzle = getDrizzleDb(sqlite);
      drizzle.insert(sessions).values({ session_id: "drizzle-session", platform: "codex" }).run();

      const row = drizzle
        .select({ id: sessions.session_id, platform: sessions.platform })
        .from(sessions)
        .where(eq(sessions.session_id, "drizzle-session"))
        .get();
      const migrationCount = sqlite
        .query<{ count: number }, string[]>("SELECT COUNT(*) AS count FROM __selftune_migrations")
        .get();

      expect(row).toEqual({ id: "drizzle-session", platform: "codex" });
      expect(migrationCount?.count).toBe(expectedMigrationCount);
    } finally {
      sqlite.close();
    }
  });

  it("preserves a pre-Drizzle database and stamps the baseline once", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-legacy-db-"));
    temporaryRoots.push(root);
    const path = join(root, "selftune.db");
    createLegacyDatabase(path);

    const migrated = openDb(path);
    const preserved = migrated
      .query("SELECT session_id, platform FROM sessions WHERE session_id = ?")
      .get("legacy-session");
    const sessionColumns = migrated
      .query<
        {
          name: string;
        },
        string[]
      >("PRAGMA table_info(sessions)")
      .all();
    migrated.close();

    const reopened = openDb(path);
    const migrationCount = reopened
      .query<{ count: number }, string[]>("SELECT COUNT(*) AS count FROM __selftune_migrations")
      .get();
    reopened.close();

    expect(preserved).toEqual({ session_id: "legacy-session", platform: "claude_code" });
    expect(sessionColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["normalizer_version", "capture_mode", "raw_source_ref"]),
    );
    expect(migrationCount?.count).toBe(expectedMigrationCount);
  });

  it("adopts a partially migrated database with numeric column names", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-partial-db-"));
    temporaryRoots.push(root);
    const path = join(root, "selftune.db");
    createLegacyDatabase(path);

    const legacy = new Database(path);
    legacy.run(`
      CREATE TABLE canonical_upload_staging (
        local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        session_id TEXT,
        prompt_id TEXT,
        normalized_at TEXT,
        staged_at TEXT NOT NULL,
        content_sha256 TEXT
      )
    `);
    legacy.close();

    const migrated = openDb(path);
    const columns = migrated
      .query<
        {
          name: string;
        },
        string[]
      >("PRAGMA table_info(canonical_upload_staging)")
      .all();
    const migrationCount = migrated
      .query<{ count: number }, string[]>("SELECT COUNT(*) AS count FROM __selftune_migrations")
      .get();
    migrated.close();

    expect(columns.filter((column) => column.name === "content_sha256")).toHaveLength(1);
    expect(migrationCount?.count).toBe(expectedMigrationCount);
  });

  it("retires an unjournaled SQLite trace prototype and keeps only its checkpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-trace-prototype-db-"));
    temporaryRoots.push(root);
    const path = join(root, "selftune.db");
    createLegacyDatabase(path);
    const prototype = new Database(path);
    prototype.run("CREATE TABLE local_trace_metrics (metric_id TEXT PRIMARY KEY)");
    prototype.close();

    const migrated = openDb(path);
    const traceTables = migrated
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'local_trace_%' ORDER BY name`,
      )
      .all();
    const checkpointExists = migrated
      .query(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table' AND name = 'analytical_import_checkpoints'`,
      )
      .get();
    migrated.close();

    expect(traceTables).toEqual([]);
    expect(checkpointExists).toEqual({ present: 1 });
  });

  it("upgrades the previous Drizzle schema with the durable evaluation draft store", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-previous-drizzle-db-"));
    temporaryRoots.push(root);
    const path = join(root, "selftune.db");
    const previousMigrations = join(root, "previous-migrations");
    const previousMeta = join(previousMigrations, "meta");
    mkdirSync(previousMeta, { recursive: true });

    const journal = Schema.decodeUnknownSync(Schema.fromJsonString(MigrationJournal))(
      embeddedMigrations["meta/_journal.json"],
    );
    const previousEntries = journal.entries.slice(0, -1);
    writeFileSync(
      join(previousMeta, "_journal.json"),
      JSON.stringify({ ...journal, entries: previousEntries }),
    );
    for (const entry of previousEntries) {
      const migrationPath = `${entry.tag}.sql`;
      const sql = migrationFiles.get(migrationPath);
      assert.ok(sql, `Missing migration ${migrationPath}`);
      writeFileSync(join(previousMigrations, migrationPath), sql);
    }

    const previous = new Database(path);
    migrate(createDrizzle({ client: previous }), {
      migrationsFolder: previousMigrations,
      migrationsTable: "__selftune_migrations",
    });
    previous.run(
      `INSERT INTO upload_queue
         (payload_type, payload_json, status, attempts, created_at, updated_at)
       VALUES ('push', '{}', 'sent', 0, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    );
    previous.run(
      `CREATE UNIQUE INDEX evaluation_submission_drafts_identity_unique
       ON evaluation_submission_drafts (pattern_id, cohort_fingerprint, skill_revision)`,
    );
    previous.close();

    const migrated = openDb(path);
    const columns = migrated
      .query<
        {
          name: string;
        },
        string[]
      >("PRAGMA table_info(upload_queue)")
      .all();
    const row = migrated.query("SELECT staging_max_seq FROM upload_queue").get();
    const installerTables = migrated
      .query<{ name: string }, string[]>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'skill_install_%' ORDER BY name`,
      )
      .all();
    const evaluationDraftColumns = migrated
      .query<
        {
          name: string;
        },
        string[]
      >("PRAGMA table_info(evaluation_submission_drafts)")
      .all();
    const legacyEvaluationDraftIdentityIndex = migrated
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'evaluation_submission_drafts_identity_unique'`,
      )
      .get();
    const signalCandidateColumns = migrated
      .query<
        {
          name: string;
        },
        string[]
      >("PRAGMA table_info(correction_signal_candidates)")
      .all();
    const studyDraftColumns = migrated
      .query<
        {
          name: string;
        },
        string[]
      >("PRAGMA table_info(correction_study_drafts)")
      .all();
    const migrationCount = migrated
      .query<{ count: number }, string[]>("SELECT COUNT(*) AS count FROM __selftune_migrations")
      .get();
    const latestMigration = migrated
      .query<{ created_at: number }, string[]>(
        "SELECT MAX(created_at) AS created_at FROM __selftune_migrations",
      )
      .get();
    migrated.close();

    expect(columns.map((column) => column.name)).toContain("staging_max_seq");
    expect(row).toEqual({ staging_max_seq: null });
    expect(installerTables.map((table) => table.name)).toEqual([
      "skill_install_commit_locks",
      "skill_install_operation_steps",
      "skill_install_operations",
      "skill_install_receipt_files",
      "skill_install_receipts",
    ]);
    expect(evaluationDraftColumns.map((column) => column.name)).toEqual([
      "draft_id",
      "pattern_id",
      "cohort_fingerprint",
      "skill_name",
      "skill_revision",
      "payload_json",
      "lifecycle",
      "cloud_run_id",
      "created_at",
      "updated_at",
    ]);
    expect(latestMigration).toEqual({ created_at: 1786088000000 });
    expect(legacyEvaluationDraftIdentityIndex).toBeNull();
    expect(signalCandidateColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["candidate_id", "idempotency_key", "manifest_digest"]),
    );
    expect(studyDraftColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["draft_id", "candidate_id", "study_payload_digest"]),
    );
    expect(migrationCount?.count).toBe(expectedMigrationCount);
  });

  it("forwards the preview correction-study schema without losing durable evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-correction-study-preview-"));
    temporaryRoots.push(root);
    const path = join(root, "selftune.db");
    const preview = new Database(path);
    const journal = Schema.decodeUnknownSync(Schema.fromJsonString(MigrationJournal))(
      embeddedMigrations["meta/_journal.json"],
    );
    const finalizedMigration = journal.entries.find(
      (entry) => entry.tag === "0013_unique_micromax",
    );
    const previewMigrationWhen = 1785267238769;
    if (!finalizedMigration) throw new Error("Expected the finalized correction-study migration.");

    preview.run(`
      CREATE TABLE __selftune_migrations (
        id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at NUMERIC
      )
    `);
    preview.run("INSERT INTO __selftune_migrations (hash, created_at) VALUES (?, ?)", [
      "preview-correction-study",
      previewMigrationWhen,
    ]);
    preview.run(`
      CREATE TABLE correction_episodes (
        episode_id TEXT PRIMARY KEY NOT NULL,
        capture_key TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        harness TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        pre_revision TEXT NOT NULL,
        post_revision TEXT,
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
    preview.run(`
      CREATE TABLE correction_evidence_ledger_entries (
        evidence_id TEXT PRIMARY KEY NOT NULL,
        episode_id TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        manifest_json TEXT NOT NULL,
        verifier_payload_json TEXT NOT NULL,
        trial_payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
    preview.run(`
      CREATE TABLE promoted_study_cases (
        case_id TEXT PRIMARY KEY NOT NULL,
        episode_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        pre_revision TEXT NOT NULL,
        post_revision TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        verifier_payload_json TEXT NOT NULL,
        trial_payload_json TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        promoted_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    const revision = "a".repeat(64);
    const timestamp = "2026-07-29T00:00:00.000Z";
    preview.run(
      `INSERT INTO correction_episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "episode-001",
        "capture-001",
        "repair-skill",
        "/workspace/repair/SKILL.md",
        "codex",
        "session-001",
        revision,
        null,
        "{}",
        "{}",
        "{}",
        "E0.5",
        "captured",
        null,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    preview.run(
      `INSERT INTO correction_evidence_ledger_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "evidence-001",
        "episode-001",
        "evidence-key-001",
        "E0.5",
        "recorded",
        null,
        "{}",
        "{}",
        "{}",
        timestamp,
      ],
    );
    preview.run(
      `INSERT INTO promoted_study_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "case-001",
        "episode-001",
        "evidence-001",
        "repair-skill",
        revision,
        revision,
        "{}",
        "{}",
        "{}",
        "E1",
        "active",
        null,
        timestamp,
        timestamp,
      ],
    );
    preview.close();

    const migrated = openDb(path);
    let migratedClosed = false;
    try {
      const episodeColumns = migrated
        .query<
          {
            name: string;
            notnull: number;
          },
          string[]
        >("PRAGMA table_info(correction_episodes)")
        .all();
      const episode = migrated
        .query("SELECT skill_id, post_revision FROM correction_episodes WHERE episode_id = ?")
        .get("episode-001");
      const evidence = migrated
        .query("SELECT skill_id FROM correction_evidence_ledger_entries WHERE evidence_id = ?")
        .get("evidence-001");
      const studyCase = migrated
        .query("SELECT skill_id FROM promoted_study_cases WHERE case_id = ?")
        .get("case-001");
      migrated.run(
        `INSERT INTO correction_episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "episode-002",
          "capture-002",
          "skill-002",
          "another-skill",
          "/workspace/another/SKILL.md",
          "codex",
          "session-002",
          revision,
          revision,
          "{}",
          "{}",
          "{}",
          "E1",
          "promoted",
          null,
          timestamp,
          timestamp,
          timestamp,
        ],
      );
      const inserted = migrated
        .query("SELECT skill_id FROM correction_episodes WHERE episode_id = ?")
        .get("episode-002");
      const finalizedReceipt = migrated
        .query("SELECT hash, created_at FROM __selftune_migrations WHERE created_at = ?")
        .get(finalizedMigration.when);
      migrated.close();
      migratedClosed = true;

      const reopened = openDb(path);
      const finalizedReceiptsAfterReopen = reopened
        .query("SELECT COUNT(*) AS count FROM __selftune_migrations WHERE created_at = ?")
        .get(finalizedMigration.when);
      reopened.close();

      expect(episodeColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "skill_id", notnull: 1 }),
          expect.objectContaining({ name: "post_revision", notnull: 1 }),
        ]),
      );
      expect(episode).toEqual({ skill_id: "legacy:repair-skill", post_revision: revision });
      expect(evidence).toEqual({ skill_id: "legacy:repair-skill" });
      expect(studyCase).toEqual({ skill_id: "legacy:repair-skill" });
      expect(inserted).toEqual({ skill_id: "skill-002" });
      expect(finalizedReceipt).toEqual({
        hash: createHash("sha256")
          .update(embeddedMigrations["0013_unique_micromax.sql"])
          .digest("hex"),
        created_at: finalizedMigration.when,
      });
      expect(finalizedReceiptsAfterReopen).toEqual({ count: 1 });
    } finally {
      if (!migratedClosed) migrated.close();
    }
  });

  it("serializes migration startup across independent processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-concurrent-db-"));
    temporaryRoots.push(root);
    const path = join(root, "selftune.db");
    const lockPath = `${path}.migration-lock`;
    createLegacyDatabase(path);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), "test-owner");

    const dbModule = pathToFileURL(
      join(import.meta.dirname, "../../packages/local-store/src/db.ts"),
    ).href;
    const readyPaths = Array.from({ length: 4 }, (_, index) => join(root, `ready-${index}`));
    const children = readyPaths.map((readyPath) => {
      const source = `
        import { writeFileSync } from "node:fs";
        import { openDb } from ${JSON.stringify(dbModule)};
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        const db = openDb(${JSON.stringify(path)});
        db.close();
      `;
      return Bun.spawn([process.execPath, "-e", source], {
        cwd: join(import.meta.dirname, "../.."),
        stderr: "pipe",
        stdout: "pipe",
      });
    });

    try {
      const readyDeadline = Date.now() + 5_000;
      while (!readyPaths.every(existsSync) && Date.now() < readyDeadline) {
        await Bun.sleep(10);
      }
      expect(readyPaths.every(existsSync)).toBe(true);
      await Bun.sleep(50);
      const earlyExits = await Promise.all(
        children.flatMap((child, index) =>
          child.exitCode === null
            ? []
            : [
                new Response(child.stderr)
                  .text()
                  .then((stderr) => ({ index, exitCode: child.exitCode, stderr })),
              ],
        ),
      );
      expect(earlyExits).toEqual([]);
    } finally {
      rmSync(lockPath, { force: true, recursive: true });
    }

    const results = await Promise.all(
      children.map(async (child) => {
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stderr };
      }),
    );
    expect(results).toEqual(results.map(() => ({ exitCode: 0, stderr: "" })));
    expect(existsSync(lockPath)).toBe(false);

    const migrated = new Database(path);
    const migrationCount = migrated
      .query<{ count: number }, string[]>("SELECT COUNT(*) AS count FROM __selftune_migrations")
      .get();
    migrated.close();
    expect(migrationCount?.count).toBe(expectedMigrationCount);
  });

  it("keeps the compiled migration payload byte-identical to committed files", () => {
    const migrationsRoot = join(import.meta.dirname, "../../packages/local-store/src/drizzle");
    for (const [relativePath, contents] of migrationFiles) {
      expect(readFileSync(join(migrationsRoot, relativePath), "utf8")).toBe(contents);
    }
  });
});
