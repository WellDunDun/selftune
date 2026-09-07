import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { copyFile, lstat, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import {
  DuckDbAnalyticalStore,
  type DuckDbAnalyticalBatch,
} from "@selftune/observability/duckdb-store";
import {
  DUCKDB_LOCAL_MEMORY_LIMIT,
  makeDuckDbNodeApiAnalyticalStoreLive,
  openDuckDbWithWalRecovery,
  type DuckDbWalRecoveryDependencies,
} from "@selftune/observability/duckdb-node-api";
import * as Effect from "effect/Effect";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const knownWalReplayFailure = () =>
  new Error(
    'TransactionContext Error: Failure while replaying WAL file "/tmp/observability.duckdb.wal": Failed to commit: Unbound index found in DataTable::RemoveFromIndexes',
  );

const knownNewerEngineWalReplayFailure = () =>
  new Error(
    'TransactionContext Error: Failure while replaying WAL file "/tmp/observability.duckdb.wal": Failed to commit: Corrupted unique ART index "observability_metrics_metric_id_pkey": encountered an existing gated leaf',
  );

function recoveryDependencies<A>(
  open: (databasePath: string) => Promise<A>,
  warnings: string[],
): DuckDbWalRecoveryDependencies<A> {
  return {
    copyFile,
    lstat,
    mkdir,
    now: () => new Date("2026-08-01T12:34:56.789Z"),
    open,
    randomUuid: () => "11111111-2222-4333-8444-555555555555",
    rename,
    warn: (message) => warnings.push(message),
  };
}

test("preserves the checkpoint and quarantines a known corrupt DuckDB WAL before retrying once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-wal-recovery-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const walPath = `${databasePath}.wal`;
  writeFileSync(databasePath, "checkpoint");
  writeFileSync(walPath, "unreplayable wal");
  const warnings: string[] = [];
  let opens = 0;

  const opened = await openDuckDbWithWalRecovery(
    databasePath,
    recoveryDependencies(async () => {
      opens += 1;
      if (opens === 1) throw knownWalReplayFailure();
      return { generation: opens };
    }, warnings),
  );

  const backupRoot = join(directory, "backups");
  const backupNames = readdirSync(backupRoot);
  expect(opened).toEqual({ generation: 2 });
  expect(opens).toBe(2);
  expect(backupNames).toEqual([
    "duckdb-wal-recovery-20260801T123456789Z-11111111-2222-4333-8444-555555555555",
  ]);
  const backupDirectory = join(backupRoot, backupNames[0]!);
  expect(readFileSync(join(backupDirectory, "observability.duckdb"), "utf8")).toBe("checkpoint");
  expect(readFileSync(join(backupDirectory, "observability.duckdb.wal"), "utf8")).toBe(
    "unreplayable wal",
  );
  expect(readFileSync(databasePath, "utf8")).toBe("checkpoint");
  expect(existsSync(walPath)).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(backupDirectory);
});

test("keeps the observed newer-engine ART replay signature inside the narrow recovery allowlist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-art-wal-recovery-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const walPath = `${databasePath}.wal`;
  writeFileSync(databasePath, "checkpoint");
  writeFileSync(walPath, "unreplayable wal");
  const warnings: string[] = [];
  let opens = 0;

  const opened = await openDuckDbWithWalRecovery(
    databasePath,
    recoveryDependencies(async () => {
      opens += 1;
      if (opens === 1) throw knownNewerEngineWalReplayFailure();
      return { generation: opens };
    }, warnings),
  );

  expect(opened).toEqual({ generation: 2 });
  expect(existsSync(walPath)).toBe(false);
  expect(warnings).toHaveLength(1);
});

test("fails closed without touching files for an unrelated DuckDB startup error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-wal-nonmatch-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const walPath = `${databasePath}.wal`;
  writeFileSync(databasePath, "checkpoint");
  writeFileSync(walPath, "healthy wal");
  const failure = new Error(
    'TransactionContext Error: Failure while replaying WAL file "/tmp/observability.duckdb.wal": Failed to commit: Corrupted unique ART index "some_other_index": unexpected node shape',
  );
  const warnings: string[] = [];

  await expect(
    openDuckDbWithWalRecovery(
      databasePath,
      recoveryDependencies(async () => {
        throw failure;
      }, warnings),
    ),
  ).rejects.toBe(failure);

  expect(readFileSync(walPath, "utf8")).toBe("healthy wal");
  expect(existsSync(join(directory, "backups"))).toBe(false);
  expect(warnings).toEqual([]);
});

test("refuses recovery when the WAL is not a regular non-symlink file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-wal-unsafe-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const walPath = `${databasePath}.wal`;
  const realWalPath = join(directory, "unexpected.wal");
  writeFileSync(databasePath, "checkpoint");
  writeFileSync(realWalPath, "unsafe wal");
  symlinkSync(realWalPath, walPath);
  const warnings: string[] = [];

  await expect(
    openDuckDbWithWalRecovery(
      databasePath,
      recoveryDependencies(async () => {
        throw knownWalReplayFailure();
      }, warnings),
    ),
  ).rejects.toThrow("regular non-symlink file");

  expect(existsSync(walPath)).toBe(true);
  expect(readFileSync(realWalPath, "utf8")).toBe("unsafe wal");
  expect(warnings).toEqual([]);
});

test("refuses recovery when the checkpoint database is a symlink", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-checkpoint-unsafe-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const realDatabasePath = join(directory, "unexpected.duckdb");
  writeFileSync(realDatabasePath, "unsafe checkpoint");
  symlinkSync(realDatabasePath, databasePath);
  writeFileSync(`${databasePath}.wal`, "unreplayable wal");
  const warnings: string[] = [];

  await expect(
    openDuckDbWithWalRecovery(
      databasePath,
      recoveryDependencies(async () => {
        throw knownWalReplayFailure();
      }, warnings),
    ),
  ).rejects.toThrow("regular non-symlink file");

  expect(readFileSync(realDatabasePath, "utf8")).toBe("unsafe checkpoint");
  expect(warnings).toEqual([]);
});

test("keeps the quarantined WAL recoverable when the one retry also fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-wal-retry-failure-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const walPath = `${databasePath}.wal`;
  writeFileSync(databasePath, "checkpoint");
  writeFileSync(walPath, "unreplayable wal");
  const warnings: string[] = [];
  const retryFailure = new Error("checkpoint also failed to open");
  let opens = 0;

  await expect(
    openDuckDbWithWalRecovery(
      databasePath,
      recoveryDependencies(async () => {
        opens += 1;
        if (opens === 1) throw knownWalReplayFailure();
        throw retryFailure;
      }, warnings),
    ),
  ).rejects.toBe(retryFailure);

  const backupDirectory = join(directory, "backups", readdirSync(join(directory, "backups"))[0]!);
  expect(existsSync(walPath)).toBe(false);
  expect(readFileSync(join(backupDirectory, "observability.duckdb.wal"), "utf8")).toBe(
    "unreplayable wal",
  );
  expect(warnings[0]).toContain(backupDirectory);
});

test("an ENOENT WAL race retries after another process already moved the WAL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-wal-race-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const walPath = `${databasePath}.wal`;
  const racedWalPath = join(directory, "recovered-by-other-process.wal");
  writeFileSync(databasePath, "checkpoint");
  writeFileSync(walPath, "unreplayable wal");
  const warnings: string[] = [];
  let opens = 0;
  const dependencies = recoveryDependencies(async () => {
    opens += 1;
    if (opens === 1) throw knownWalReplayFailure();
    return { generation: opens };
  }, warnings);

  const opened = await openDuckDbWithWalRecovery(databasePath, {
    ...dependencies,
    rename: async (source, destination) => {
      if (source === walPath) {
        renameSync(source, racedWalPath);
        throw Object.assign(new Error("WAL already moved"), { code: "ENOENT" });
      }
      return dependencies.rename(source, destination);
    },
  });

  expect(opened).toEqual({ generation: 2 });
  expect(readFileSync(racedWalPath, "utf8")).toBe("unreplayable wal");
  expect(warnings).toEqual([]);
});

const batch: typeof DuckDbAnalyticalBatch.Encoded = {
  schema_version: "1.0.0",
  batch_id: "batch-codex-001",
  source_revision: "rollout-sha-001",
  normalizer_version: "codex-rollout-v1",
  spans: [
    {
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      name: "invoke_agent",
      started_at: "2026-07-23T10:00:00.000Z",
      ended_at: "2026-07-23T10:00:05.000Z",
      platform: "codex",
      capture_mode: "rollout",
      source_authority: "source_truth",
      trace_boundary: "actionable_turn",
      operation_name: "invoke_agent",
      source_id: "rollout-codex-001",
      provider: "openai",
      model: "gpt-5",
      conversation_id: "conversation-codex-001",
      tool_name: "shell",
      input_tokens: 120,
      output_tokens: 30,
      error_count: 2,
      tool_call_count: 1,
    },
  ],
  links: [
    {
      link_id: "c".repeat(32),
      span_id: "b".repeat(16),
      trace_id: "a".repeat(32),
      skill_invocation_id: "invocation-codex-001",
      skill_name: "diagnose",
    },
  ],
};

const revisedBatch = {
  ...batch,
  source_revision: "rollout-sha-002",
  spans: [
    {
      ...batch.spans[0],
      error_count: 0,
      input_tokens: 240,
      output_tokens: 60,
      tool_call_count: 3,
    },
  ],
  links: [
    {
      ...batch.links[0],
      link_id: "d".repeat(32),
      skill_invocation_id: "invocation-codex-002",
      skill_name: "investigate",
    },
  ],
};

const duplicateSameSkillLinkBatch = {
  ...batch,
  batch_id: "batch-codex-duplicate-same-skill-link",
  links: [
    ...batch.links,
    {
      ...batch.links[0],
      link_id: "d".repeat(32),
      skill_invocation_id: "invocation-codex-002",
    },
  ],
};

async function createVersionTwoDatabase(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE observability_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp
    )`);
    await connection.run("INSERT INTO observability_schema_migrations (version) VALUES (1), (2)");
    await connection.run(`CREATE TABLE observability_spans (
      trace_id VARCHAR NOT NULL,
      span_id VARCHAR NOT NULL,
      span_name VARCHAR NOT NULL,
      started_at TIMESTAMP NOT NULL,
      ended_at TIMESTAMP NOT NULL,
      duration_ms BIGINT NOT NULL,
      platform VARCHAR NOT NULL,
      capture_mode VARCHAR NOT NULL,
      source_authority VARCHAR NOT NULL,
      trace_boundary VARCHAR NOT NULL,
      operation_name VARCHAR NOT NULL,
      source_id VARCHAR NOT NULL,
      provider VARCHAR,
      model VARCHAR,
      batch_id VARCHAR,
      resource_id VARCHAR,
      scope_id VARCHAR,
      parent_span_id VARCHAR,
      kind VARCHAR,
      status VARCHAR,
      status_message VARCHAR,
      PRIMARY KEY (trace_id, span_id)
    )`);
    await connection.run(`CREATE TABLE observability_metrics (
      metric_id VARCHAR PRIMARY KEY,
      span_id VARCHAR NOT NULL,
      trace_id VARCHAR NOT NULL,
      metric_name VARCHAR NOT NULL,
      value DOUBLE NOT NULL,
      unit VARCHAR NOT NULL,
      batch_id VARCHAR
    )`);
    await connection.run(
      "CREATE INDEX observability_spans_trace_id ON observability_spans(trace_id)",
    );
    await connection.run(
      "CREATE INDEX observability_spans_parent ON observability_spans(trace_id, parent_span_id)",
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

test("keeps the production DuckDB memory budget explicit and bounded", () => {
  expect(DUCKDB_LOCAL_MEMORY_LIMIT).toBe("512MB");
  expect(Number.parseInt(DUCKDB_LOCAL_MEMORY_LIMIT, 10)).toBeGreaterThan(0);
  expect(Number.parseInt(DUCKDB_LOCAL_MEMORY_LIMIT, 10)).toBeLessThanOrEqual(512);
});

test("upgrades an indexed v2 span table through the v4 rebuild and restarts cleanly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-v2-migration-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  await createVersionTwoDatabase(databasePath);

  const openStore = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DuckDbAnalyticalStore;
        return yield* store.health();
      }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
    );

  expect(await openStore()).toMatchObject({ schema_version: 9 });
  expect(await openStore()).toMatchObject({ schema_version: 9 });

  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    const columns = await connection
      .run("SELECT name FROM pragma_table_info('observability_spans') ORDER BY name")
      .then((result) => result.getRowObjects());
    const migrationVersions = await connection
      .run("SELECT version FROM observability_schema_migrations ORDER BY version")
      .then((result) => result.getRowObjects());
    const indexes = await connection
      .run(
        "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'observability_spans' ORDER BY index_name",
      )
      .then((result) => result.getRowObjects());

    expect(columns).not.toContainEqual({ name: "status_message" });
    expect(migrationVersions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
    ]);
    expect(indexes).toEqual(
      expect.arrayContaining([
        { index_name: "observability_spans_parent" },
        { index_name: "observability_spans_trace_id" },
      ]),
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

test("persists fractional historical metrics without coercing them through BigInt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-fractional-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const traceId = "f".repeat(32);
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest({
        schema_version: "1.0.0",
        batch_id: "fractional-metric-batch",
        source_revision: "fractional-metric-source",
        normalizer_version: "historical-v1",
        spans: [],
        links: [],
        metric_points: [
          {
            metric_id: "cost-usd-fractional",
            trace_id: traceId,
            observed_at: "2026-07-23T10:00:00.000Z",
            name: "cost_usd",
            value: 0.125,
            unit: "usd",
            temporality: "cumulative",
            source_kind: "codex",
            evidence_quality: "source_exact",
            source_id: "execution_fact:cost-1",
            source_reference: "raw/cost-1",
          },
        ],
      });
      return yield* store.queryHistoricalMetricRollups({ limit: 1 });
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
  );
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    const rows = await connection
      .run("SELECT value FROM observability_historical_metric_rollups")
      .then((result) => result.getRowObjects());
    expect(rows).toEqual([{ value: 0.125 }]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

test("persists a replay-safe analytical batch in a real DuckDB file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");

  const firstRun = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      const accepted = yield* store.ingest(batch);
      const health = yield* store.health();
      return { accepted, health };
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
  );
  const restarted = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      const revised = yield* store.ingest(revisedBatch);
      const duplicate = yield* store.ingest(revisedBatch);
      const signals = yield* store.querySkillSignals();
      return { duplicate, revised, signals };
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
  );
  const inspectionInstance = await DuckDBInstance.create(databasePath);
  const inspectionConnection = await inspectionInstance.connect();
  const persistedMetadata = await inspectionConnection
    .run(
      "SELECT conversation_id, tool_name FROM observability_spans WHERE batch_id = 'batch-codex-001'",
    )
    .then((result) => result.getRowObjects());
  inspectionConnection.closeSync();
  inspectionInstance.closeSync();

  expect(existsSync(databasePath)).toBe(true);
  expect(firstRun.accepted.disposition).toBe("accepted");
  expect(restarted.revised.disposition).toBe("accepted");
  expect(restarted.duplicate.disposition).toBe("duplicate");
  expect(persistedMetadata).toEqual([
    { conversation_id: "conversation-codex-001", tool_name: "shell" },
  ]);
  expect(firstRun.health).toMatchObject({ span_count: 1, metric_count: 5, link_count: 1 });
  expect(restarted.signals).toEqual([
    {
      skill_name: "investigate",
      invocation_count: 1,
      trace_count: 1,
      error_trace_count: 0,
      duration_ms: 5_000,
      input_tokens: 240,
      output_tokens: 60,
      error_count: 0,
      tool_call_count: 3,
    },
  ]);
});

test("counts distinct same-skill invocations without duplicating their shared span metrics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");

  const signals = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      yield* store.ingest(duplicateSameSkillLinkBatch);
      return yield* store.querySkillSignals();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
  );

  expect(signals).toEqual([
    {
      skill_name: "diagnose",
      invocation_count: 2,
      trace_count: 1,
      error_trace_count: 1,
      duration_ms: 5_000,
      input_tokens: 120,
      output_tokens: 30,
      error_count: 2,
      tool_call_count: 1,
    },
  ]);
});

test("persists bounded topology facts and rejects broken trace references before writing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-topology-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "observability.duckdb");
  const topologyBatch = {
    ...batch,
    resources: [
      {
        resource_id: "resource-codex-001",
        service_name: "codex",
        platform: "otlp" as const,
        schema_url: "https://opentelemetry.io/schemas/1.43.0",
      },
    ],
    instrumentation_scopes: [
      {
        scope_id: "scope-codex-001",
        resource_id: "resource-codex-001",
        name: "selftune.otlp",
      },
    ],
    spans: [
      {
        ...batch.spans[0],
        resource_id: "resource-codex-001",
        scope_id: "scope-codex-001",
        kind: "CLIENT" as const,
        status: "ERROR" as const,
      },
    ],
    logs: [
      {
        log_id: "log-codex-001",
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        timestamp: "2026-07-23T10:00:02.000Z",
        event_name: "selftune.tool.progress",
        resource_id: "resource-codex-001",
        scope_id: "scope-codex-001",
        severity: "INFO" as const,
      },
    ],
    span_links: [
      {
        link_id: "d".repeat(32),
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        target_trace_id: "e".repeat(32),
      },
    ],
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      const accepted = yield* store.ingest(topologyBatch);
      const invalid = yield* Effect.exit(
        store.ingest({
          ...topologyBatch,
          batch_id: "batch-codex-invalid-topology",
          logs: [{ ...topologyBatch.logs[0], span_id: "f".repeat(16) }],
        }),
      );
      return { accepted, health: yield* store.health(), invalid };
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
  );

  expect(result.accepted).toMatchObject({
    resources_received: 1,
    scopes_received: 1,
    logs_received: 1,
    span_links_received: 1,
  });
  expect(result.health).toMatchObject({
    resource_count: 1,
    scope_count: 1,
    log_count: 1,
    span_link_count: 1,
  });
  expect(result.invalid._tag).toBe("Failure");
});
