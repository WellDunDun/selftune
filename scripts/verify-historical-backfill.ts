/* oxlint-disable no-console, no-await-in-loop -- this is an explicit acceptance runner */
/**
 * #189 acceptance runner. It opens the supplied source (including the live DB)
 * readonly, projects only accepted metadata into a disposable SQLite database,
 * and writes analytics only under a fresh temp dir.
 *
 * bun scripts/verify-historical-backfill.ts --sqlite-backup /safe/selftune.db
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { Database as ReadonlyDatabase, type SQLQueryBindings } from "bun:sqlite";
import { DuckDBInstance } from "@duckdb/node-api";
import { openDb } from "@selftune/local-store";
import { DuckDbAnalyticalStore, LocalTraceImporter } from "@selftune/observability";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import {
  compareTraceEvidencePages,
  makeCompatibilitySqliteTraceEvidenceReader,
  makeDuckDbTraceEvidenceReader,
} from "@selftune/observability/reader-parity";
import { runHistoricalBackfill } from "@selftune/orchestration/historical-backfill";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type LocalDatabase = ReturnType<typeof openDb>;

const liveDatabasePath = resolve(homedir(), ".selftune", "selftune.db");
const requiredPlatforms = ["codex", "claude_code", "opencode", "pi"] as const;

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const queryCount = (database: LocalDatabase, sql: string, parameters: SQLQueryBindings[] = []) => {
  const row = database.query<{ count: number }, SQLQueryBindings[]>(sql).get(...parameters);
  if (row === null) throw new Error("Count query returned no row.");
  return row.count;
};

const quotedIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const duplicateFactsToTenTimes = (database: LocalDatabase) => {
  const columns = database.query<{ name: string }, []>("PRAGMA table_info(execution_facts)").all();
  const names = columns.map(({ name }) => name).filter((name) => name !== "id");
  const select = names
    .map((name) =>
      name === "execution_fact_id" || name === "prompt_id" ? "NULL" : quotedIdentifier(name),
    )
    .join(", ");
  const originalMaxId = queryCount(
    database,
    "SELECT COALESCE(MAX(id), 0) AS count FROM execution_facts",
  );
  const target = names.map(quotedIdentifier).join(", ");
  for (let index = 0; index < 9; index += 1) {
    database.run(
      `INSERT INTO execution_facts (${target}) SELECT ${select} FROM execution_facts WHERE id <= ?`,
      [originalMaxId],
    );
  }
};

const platformCounts = (database: LocalDatabase) =>
  Object.fromEntries(
    database
      .query<{ platform: string | null; count: number }, []>(
        "SELECT platform, COUNT(*) AS count FROM sessions GROUP BY platform ORDER BY platform",
      )
      .all()
      .map((row) => [row.platform ?? "unknown", row.count]),
  );

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const CanonicalIdEvidence = Schema.Struct({
  session_spans: Count,
  prompt_logs: Count,
  invocation_logs: Count,
  execution_logs: Count,
  metric_points: Count,
  log_skill_links: Count,
});

const inspectAnalyticalEvidence = async (database: LocalDatabase, path: string) => {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  try {
    const duck = {
      appendRows: async () => undefined,
      closeSync: () => undefined,
      run: (sql: string, parameters?: Record<string, number | string | null>) =>
        connection.run(sql, parameters),
    };
    const ids = await connection
      .run(`SELECT
        CAST((SELECT COUNT(*) FROM observability_spans
          WHERE source_id LIKE 'session:%' AND evidence_quality = 'source_exact') AS DOUBLE)
          AS session_spans,
        CAST((SELECT COUNT(*) FROM observability_logs
          WHERE source_id LIKE 'prompt:%' AND evidence_quality = 'metadata_only') AS DOUBLE)
          AS prompt_logs,
        CAST((SELECT COUNT(*) FROM observability_logs
          WHERE source_id LIKE 'skill_invocation:%' AND evidence_quality = 'metadata_only') AS DOUBLE)
          AS invocation_logs,
        CAST((SELECT COUNT(*) FROM observability_logs
          WHERE source_id LIKE 'execution_fact:%' AND evidence_quality = 'metadata_only') AS DOUBLE)
          AS execution_logs,
        CAST((SELECT COUNT(*) FROM observability_historical_metric_points
          WHERE source_id LIKE 'execution_fact:%' AND evidence_quality = 'source_exact') AS DOUBLE)
          AS metric_points,
        CAST((SELECT COUNT(*) FROM observability_historical_log_skill_links
          WHERE skill_invocation_id <> '') AS DOUBLE) AS log_skill_links`)
      .then(async (result) =>
        Schema.decodeUnknownSync(CanonicalIdEvidence)((await result.getRowObjects())[0]),
      );
    const compatibility = makeCompatibilitySqliteTraceEvidenceReader(
      {
        query: (sql, parameters) => database.query(sql).all(parameters),
      },
      "current",
    );
    const analytical = makeDuckDbTraceEvidenceReader(duck, "current");
    const [left, right] = await Promise.all([
      compatibility.readPage({ limit: 64 }),
      analytical.readPage({ limit: 64 }),
    ]);
    return { ids, parity: compareTraceEvidencePages(left, right, true) };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
};

const metricColumns = new Map(
  Object.entries({
    duration_ms: "duration_ms",
    input_tokens: "input_tokens",
    output_tokens: "output_tokens",
    tool_call_count: "total_tool_calls",
    error_count: "errors_encountered",
    assistant_turns: "assistant_turns",
    files_changed: "files_changed",
    lines_added: "lines_added",
    lines_removed: "lines_removed",
    lines_modified: "lines_modified",
    cached_input_tokens: "cached_input_tokens",
    reasoning_output_tokens: "reasoning_output_tokens",
    cost_usd: "cost_usd",
    artifact_count: "artifact_count",
  }),
);

const rollupsMatchCanonicalSource = (
  database: LocalDatabase,
  rollups: ReadonlyArray<{ source_id: string; metric_name: string; value: number }>,
) =>
  rollups.every((rollup) => {
    const column = metricColumns.get(rollup.metric_name);
    if (column === undefined || !rollup.source_id.startsWith("execution_fact:")) return false;
    const identity = rollup.source_id.slice("execution_fact:".length);
    const row = identity.startsWith("legacy-")
      ? database
          .query<{ value: number | null }, [number]>(
            `SELECT "${column}" AS value FROM execution_facts WHERE id = ?`,
          )
          .get(Number(identity.slice("legacy-".length)))
      : database
          .query<{ value: number | null }, [string]>(
            `SELECT "${column}" AS value FROM execution_facts WHERE execution_fact_id = ?`,
          )
          .get(identity);
    const value = row?.value;
    return value !== null && value !== undefined && Number(value) === rollup.value;
  });

/**
 * Materialize only the canonical fields the historical adapter is allowed to
 * see. The source is always opened readonly; prompt bodies, queries, tool JSON,
 * workspace paths, and every other content-bearing column stay in the source.
 */
const projectCanonicalMetadata = (
  sourcePath: string,
  targetPath: string,
  representative = false,
) => {
  const source = new ReadonlyDatabase(sourcePath, { readonly: true });
  const target = openDb(targetPath);
  const copy = (select: string, insert: string) => {
    const statement = target.query(insert);
    for (const row of source.query(select).iterate()) statement.run(...Object.values(row));
  };
  const selected = representative
    ? `WITH ranked AS (
        SELECT session_id, ROW_NUMBER() OVER (PARTITION BY platform ORDER BY session_id) AS row_number
        FROM sessions WHERE platform IN ('codex', 'claude_code', 'opencode', 'pi', 'openclaw')
      )`
    : "";
  const selectedJoin = representative
    ? "INNER JOIN ranked AS ranked_session ON ranked_session.session_id = s.session_id AND ranked_session.row_number <= 200"
    : "";
  try {
    target.run("BEGIN IMMEDIATE");
    copy(
      representative
        ? `${selected} SELECT s.session_id, s.platform, s.started_at, s.ended_at, s.capture_mode, s.raw_source_ref
           FROM sessions AS s ${selectedJoin}`
        : "SELECT session_id, platform, started_at, ended_at, capture_mode, raw_source_ref FROM sessions",
      `INSERT OR IGNORE INTO sessions
        (session_id, platform, started_at, ended_at, capture_mode, raw_source_ref) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    copy(
      `${selected} SELECT p.prompt_id, p.session_id, p.occurred_at, p.raw_source_ref
       FROM prompts AS p INNER JOIN sessions AS s ON s.session_id = p.session_id ${selectedJoin}`,
      "INSERT OR IGNORE INTO prompts (prompt_id, session_id, occurred_at, raw_source_ref) VALUES (?, ?, ?, ?)",
    );
    copy(
      `${selected} SELECT i.skill_invocation_id, i.session_id, i.skill_name, i.occurred_at, i.raw_source_ref
       FROM skill_invocations AS i INNER JOIN sessions AS s ON s.session_id = i.session_id ${selectedJoin}`,
      `INSERT OR IGNORE INTO skill_invocations
        (skill_invocation_id, session_id, skill_name, occurred_at, raw_source_ref) VALUES (?, ?, ?, ?, ?)`,
    );
    copy(
      `${selected} SELECT f.id, f.execution_fact_id, f.session_id, f.occurred_at, f.duration_ms, f.input_tokens, f.output_tokens,
        f.total_tool_calls, f.errors_encountered, f.assistant_turns, f.files_changed, f.lines_added, f.lines_removed,
        f.lines_modified, f.cached_input_tokens, f.reasoning_output_tokens, f.cost_usd, f.artifact_count, f.raw_source_ref
       FROM execution_facts AS f INNER JOIN sessions AS s ON s.session_id = f.session_id ${selectedJoin}
       ORDER BY f.id ${representative ? "LIMIT 1000" : ""}`,
      `INSERT OR IGNORE INTO execution_facts
        (id, execution_fact_id, session_id, occurred_at, duration_ms, input_tokens, output_tokens,
         total_tool_calls, errors_encountered, assistant_turns, files_changed, lines_added, lines_removed,
         lines_modified, cached_input_tokens, reasoning_output_tokens, cost_usd, artifact_count, raw_source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    target.run("COMMIT");
  } catch (error) {
    target.run("ROLLBACK");
    throw error;
  } finally {
    target.close();
    source.close();
  }
};

const runCorpus = async (databasePath: string, tenTimes: boolean) => {
  const database = openDb(databasePath);
  const duckdbPath = `${databasePath}.duckdb`;
  if (tenTimes) duplicateFactsToTenTimes(database);
  const sourceRows = {
    sessions: queryCount(database, "SELECT COUNT(*) AS count FROM sessions"),
    prompts: queryCount(database, "SELECT COUNT(*) AS count FROM prompts"),
    skill_invocations: queryCount(database, "SELECT COUNT(*) AS count FROM skill_invocations"),
    execution_facts: queryCount(database, "SELECT COUNT(*) AS count FROM execution_facts"),
  };
  const platforms = platformCounts(database);
  const storeLayer = makeDuckDbNodeApiAnalyticalStoreLive(duckdbPath);
  const importerLayer = Layer.provide(makeLocalTraceImporterLive(database), storeLayer);
  const invoke = <A, E>(effect: Effect.Effect<A, E, LocalTraceImporter | DuckDbAnalyticalStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(importerLayer), Effect.scoped));
  const backfill = (options: Parameters<typeof runHistoricalBackfill>[1]) =>
    invoke(runHistoricalBackfill(database, options));
  const store = <A, E>(
    effect: (service: typeof DuckDbAnalyticalStore.Service) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* effect(yield* DuckDbAnalyticalStore);
      }).pipe(Effect.provide(storeLayer), Effect.scoped),
    );

  try {
    let crashed = false;
    try {
      await backfill({
        restart: true,
        maxBatches: 1,
        hooks: {
          afterImport: () => Effect.fail(new Error("acceptance crash after DuckDB receipt")),
        },
      });
    } catch (error) {
      crashed = error instanceof Error && error.message.includes("acceptance crash");
    }
    const afterCrash = await store((service) => service.health());
    const coldStarted = performance.now();
    const cold = await backfill({ restart: true });
    const afterCold = await store((service) =>
      Effect.all({
        health: service.health(),
        rollups: service.queryHistoricalMetricRollups({ limit: 256 }),
      }),
    );
    const coldElapsed = Math.max(0, Math.round(performance.now() - coldStarted));
    const coldRss = process.memoryUsage().rss;
    const warmStarted = performance.now();
    const warm = await backfill({ restart: true });
    const afterWarm = await store((service) => service.health());
    const warmElapsed = Math.max(0, Math.round(performance.now() - warmStarted));
    const warmRss = process.memoryUsage().rss;
    const evidence = await inspectAnalyticalEvidence(database, duckdbPath);
    const steadyStarted = performance.now();
    const steady = await backfill({});
    const steadyElapsed = Math.max(0, Math.round(performance.now() - steadyStarted));
    const steadyRss = process.memoryUsage().rss;
    const checkpoints = queryCount(
      database,
      "SELECT COUNT(*) AS count FROM analytical_import_checkpoints WHERE source_kind = 'historical-backfill'",
    );
    const importedPlatforms = Object.fromEntries(
      requiredPlatforms.map((platform) => [
        platform,
        queryCount(
          database,
          `SELECT COUNT(*) AS count FROM analytical_import_checkpoints
            WHERE source_kind = ? AND source_identity LIKE 'historical-backfill:%'`,
          [platform],
        ),
      ]),
    );
    const rollupsMatchSource = rollupsMatchCanonicalSource(database, afterCold.rollups.items);
    const canonicalIdsRetained =
      evidence.ids !== undefined && Object.values(evidence.ids).every((count) => count > 0);
    const replayIdempotent =
      afterCold.health.historical_metric_point_count === afterWarm.historical_metric_point_count &&
      afterCold.health.log_count === afterWarm.log_count &&
      afterCold.health.span_count === afterWarm.span_count;
    const checks = {
      isolated_metadata_projection: true,
      crash_after_duckdb_receipt:
        crashed &&
        afterCrash.historical_metric_point_count + afterCrash.log_count + afterCrash.span_count > 0,
      replay_idempotent: replayIdempotent,
      historical_checkpoint_per_domain: checkpoints === 4,
      four_supported_platforms_imported: requiredPlatforms.every(
        (platform) => (platforms[platform] ?? 0) > 0 && importedPlatforms[platform]! > 0,
      ),
      openclaw_explicitly_withheld:
        (platforms.openclaw ?? 0) === 0 ||
        cold.withheld_unsupported_platform >= (platforms.openclaw ?? 0),
      cumulative_rollups_never_summed: rollupsMatchSource,
      historical_metrics_are_source_exact: afterCold.rollups.items.every(
        (rollup) => rollup.evidence_quality === "source_exact",
      ),
      provenance_retained: afterCold.rollups.items.every(
        (rollup) => rollup.source_reference.length > 0,
      ),
      canonical_ids_retained: canonicalIdsRetained,
      reader_parity: evidence.parity.mismatches.length === 0 && evidence.parity.matching_rows > 0,
    };
    return {
      multiplier: tenTimes ? 10 : 1,
      source_rows: sourceRows,
      platforms,
      imported_platform_checkpoints: importedPlatforms,
      cold: {
        wall_time_ms: coldElapsed,
        facts_visited: cold.source_rows_seen,
        response_bytes: Buffer.byteLength(
          JSON.stringify({ health: afterCold.health, rollups: afterCold.rollups }),
        ),
        process_rss_bytes: coldRss,
      },
      warm: {
        wall_time_ms: warmElapsed,
        facts_visited: warm.source_rows_seen,
        response_bytes: Buffer.byteLength(JSON.stringify({ health: afterWarm })),
        process_rss_bytes: warmRss,
      },
      steady_resume: {
        wall_time_ms: steadyElapsed,
        facts_visited: steady.source_rows_seen,
        response_bytes: Buffer.byteLength(JSON.stringify(steady)),
        process_rss_bytes: steadyRss,
      },
      duckdb_memory_bytes: null,
      duckdb_memory_note:
        "DuckDB Node API does not expose per-engine RSS; process_rss_bytes includes DuckDB.",
      health: afterWarm,
      canonical_id_evidence: evidence.ids,
      reader_parity: evidence.parity,
      representative_rollup_count: afterCold.rollups.items.length,
      rollup_page_has_more: afterCold.rollups.next !== undefined,
      withheld: cold.withheld_unsupported_platform,
      checks,
    };
  } finally {
    database.close();
  }
};

const main = async () => {
  const source = argument("--sqlite-backup");
  const only = argument("--only");
  const acceptedModes = new Set(["1x", "10x", "representative-10x"]);
  if (only !== undefined && !acceptedModes.has(only))
    throw new Error("--only must be 1x, 10x, or representative-10x.");
  if (!source || !existsSync(source))
    throw new Error("Pass an existing SQLite source with --sqlite-backup PATH.");
  const root = mkdtempSync(join(tmpdir(), "selftune-historical-backfill-"));
  const corpus = async (name: "1x" | "10x", representative = false) => {
    const directory = mkdtempSync(join(root, `${name}-`));
    try {
      const databasePath = join(directory, `${name}-${basename(source)}`);
      projectCanonicalMetadata(source, databasePath, representative);
      return await runCorpus(databasePath, name === "10x");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    const runs: Partial<
      Record<"one_x" | "ten_x" | "representative_ten_x", Awaited<ReturnType<typeof runCorpus>>>
    > = {};
    if (only !== "10x" && only !== "representative-10x") runs.one_x = await corpus("1x");
    if (only === "10x") runs.ten_x = await corpus("10x");
    if (only !== "1x" && only !== "10x") runs.representative_ten_x = await corpus("10x", true);
    const report = {
      generated_at: new Date().toISOString(),
      source: resolve(source),
      source_is_live_database: resolve(source) === liveDatabasePath,
      source_opened_read_only: true,
      full_corpus_10x:
        only === "10x"
          ? "executed_explicitly"
          : "not_executed: pass --only 10x after confirming at least 3GB free scratch space",
      ...runs,
    };
    console.log(JSON.stringify(report, null, 2));
    const allChecks = [report.one_x, report.ten_x, report.representative_ten_x].flatMap((run) =>
      run === undefined ? [] : Object.values(run.checks),
    );
    if (!allChecks.every(Boolean)) process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

await main();
