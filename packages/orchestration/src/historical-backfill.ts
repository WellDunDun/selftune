import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { acknowledgeAnalyticalImport, AnalyticalImportCheckpoint } from "@selftune/local-store";
import {
  HISTORICAL_BACKFILL_NORMALIZER_VERSION,
  normalizeHistoricalBackfill,
} from "@selftune/observability/historical-backfill";
import { LocalTraceImporter } from "@selftune/observability/local-trace-importer";

const CHECKPOINT_KIND = "historical-backfill";
const BOUNDARY_CHECKPOINT_KIND = "historical-backfill-boundary";
const BOUNDARY_NORMALIZER_VERSION = "1";
const INITIAL_CURSOR = "__historical_backfill_start__";
const EMPTY_BOUNDARY = "__historical_backfill_empty__";
const DEFAULT_BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 256;
const Domains = ["sessions", "prompts", "skill_invocations", "execution_facts"] as const;

type SourceDomain = (typeof Domains)[number];
type SqlValue = string | number | null;
type SqlRow = Readonly<Record<string, SqlValue>>;

const CursorRow = Schema.Struct({
  source_fingerprint: Schema.String,
  normalizer_version: Schema.String,
});
const BoundaryRow = Schema.Struct({
  source_fingerprint: Schema.String.check(Schema.isNonEmpty()),
});
const PageCursorRow = Schema.Struct({ cursor_key: Schema.Number });
const MaximumKeyRow = Schema.Struct({ key: Schema.Number });

export class HistoricalBackfillFailure extends Schema.TaggedErrorClass<HistoricalBackfillFailure>()(
  "HistoricalBackfillFailure",
  { operation: Schema.String, message: Schema.String },
) {}

export interface HistoricalBackfillHooks {
  readonly beforeImport?: (batchId: string) => Effect.Effect<void, HistoricalBackfillFailure>;
  readonly afterImport?: (batchId: string) => Effect.Effect<void, HistoricalBackfillFailure>;
  readonly beforeCheckpoint?: (cursor: string) => Effect.Effect<void, HistoricalBackfillFailure>;
  readonly afterCheckpoint?: (cursor: string) => Effect.Effect<void, HistoricalBackfillFailure>;
}

export interface HistoricalBackfillOptions {
  /** Source rows per keyset work unit (at most 256 for each source table). */
  readonly batchSize?: number;
  /** Bound a test or scheduler invocation; omitted means drain every source table. */
  readonly maxBatches?: number;
  /** Ignore durable per-table cursors and safely replay every source table. */
  readonly restart?: boolean;
  readonly hooks?: HistoricalBackfillHooks;
}

export interface HistoricalBackfillResult {
  readonly batches_read: number;
  readonly imports_attempted: number;
  readonly source_rows_seen: number;
  readonly withheld_unsupported_platform: number;
  readonly withheld_missing_timestamp: number;
  readonly withheld_missing_identity: number;
  readonly cursors: Readonly<Record<SourceDomain, string | undefined>>;
}

interface SourcePage {
  readonly domain: SourceDomain;
  readonly cursor: string;
  readonly sessions: ReadonlyArray<SqlRow>;
  readonly prompts: ReadonlyArray<SqlRow>;
  readonly skill_invocations: ReadonlyArray<SqlRow>;
  readonly execution_facts: ReadonlyArray<SqlRow>;
}

const checkpointIdentity = (domain: SourceDomain) => `sqlite-canonical-keyset:${domain}`;

const boundaryIdentity = (domain: SourceDomain) => `sqlite-canonical-high-water:${domain}`;

const queryRows = Effect.fn("HistoricalBackfill.queryRows")(function* (
  database: Database,
  query: string,
  ...parameters: Array<string | number>
) {
  return yield* Effect.try({
    try: () => database.query<SqlRow, Array<string | number>>(query).all(...parameters),
    catch: (cause) =>
      HistoricalBackfillFailure.make({
        operation: "read historical canonical telemetry",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

const controlTransaction = Effect.fn("HistoricalBackfill.controlTransaction")(function* (
  database: Database,
  statement: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK",
) {
  return yield* Effect.try({
    try: () => database.run(statement),
    catch: (cause) =>
      HistoricalBackfillFailure.make({
        operation: `${statement.toLowerCase()} historical backfill boundary`,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

const optional = (value: SqlValue | undefined) => (value === null ? undefined : value);

const omitUndefined = (row: Readonly<Record<string, SqlValue | undefined>>) => {
  const cleaned: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
};

const sessionFrom = (row: SqlRow): SqlRow =>
  omitUndefined({
    session_id: row.s_session_id,
    platform: row.s_platform,
    started_at: optional(row.s_started_at),
    ended_at: optional(row.s_ended_at),
    capture_mode: optional(row.s_capture_mode),
    raw_source_ref: optional(row.s_raw_source_ref),
  });

const uniqueSessions = (rows: ReadonlyArray<SqlRow>) => {
  const sessions = new Map<string, SqlRow>();
  for (const row of rows) {
    const session = sessionFrom(row);
    const sessionId = Schema.decodeUnknownOption(Schema.String)(session.session_id);
    if (Option.isSome(sessionId)) sessions.set(sessionId.value, session);
  }
  return [...sessions.values()];
};

const readCursor = Effect.fn("HistoricalBackfill.readCursor")(function* (
  database: Database,
  domain: SourceDomain,
) {
  const rows = yield* queryRows(
    database,
    `SELECT source_fingerprint, normalizer_version
       FROM analytical_import_checkpoints
      WHERE source_kind = ? AND source_identity = ?`,
    CHECKPOINT_KIND,
    checkpointIdentity(domain),
  );
  if (rows.length === 0) return undefined;
  return yield* Schema.decodeUnknownEffect(CursorRow)(rows[0]).pipe(
    Effect.map((row) =>
      row.normalizer_version === HISTORICAL_BACKFILL_NORMALIZER_VERSION
        ? row.source_fingerprint
        : undefined,
    ),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        HistoricalBackfillFailure.make({
          operation: "decode historical backfill cursor",
          message: error.message,
        }),
      ),
    ),
  );
});

/**
 * A durable high-water mark deliberately lives apart from the advancing
 * cursor. A normalizer upgrade or --restart replays the same historical
 * cohort; rows written by the live source sync after this mark are therefore
 * owned only by normal source ingestion.
 */
const readStoredBoundary = Effect.fn("HistoricalBackfill.readStoredBoundary")(function* (
  database: Database,
  domain: SourceDomain,
) {
  const rows = yield* queryRows(
    database,
    `SELECT source_fingerprint FROM analytical_import_checkpoints
      WHERE source_kind = ? AND source_identity = ?`,
    BOUNDARY_CHECKPOINT_KIND,
    boundaryIdentity(domain),
  );
  if (rows.length === 0) return undefined;
  const boundary = Schema.decodeUnknownOption(BoundaryRow)(rows[0]);
  if (Option.isNone(boundary)) {
    return yield* Effect.fail(
      HistoricalBackfillFailure.make({
        operation: "read historical backfill boundary",
        message: `Invalid durable high-water mark for ${domain}.`,
      }),
    );
  }
  return boundary.value.source_fingerprint;
});

const maxKeyFor = Effect.fn("HistoricalBackfill.maxKeyFor")(function* (
  database: Database,
  domain: SourceDomain,
) {
  const table = domain;
  // Text identifiers are canonical identity, not a reliable insertion order.
  // SQLite's local rowid is the monotonic sequence that prevents a newly
  // synced row with a lexicographically lower id entering this old cohort.
  const query = `SELECT rowid AS key FROM ${table} ORDER BY rowid DESC LIMIT 1`;
  const rows = yield* queryRows(database, query);
  if (rows.length === 0) return EMPTY_BOUNDARY;
  const maximum = Schema.decodeUnknownOption(MaximumKeyRow)(rows[0]);
  if (Option.isNone(maximum)) {
    return yield* Effect.fail(
      HistoricalBackfillFailure.make({
        operation: "establish historical backfill boundary",
        message: `Invalid high-water mark for ${domain}.`,
      }),
    );
  }
  return String(maximum.value.key);
});

function pageCursor(rows: ReadonlyArray<SqlRow>): string | undefined {
  const cursor = Schema.decodeUnknownOption(PageCursorRow)(rows.at(-1));
  return Option.isSome(cursor) ? String(cursor.value.cursor_key) : undefined;
}

/** Establishes the immutable historical cohort before a live source sync. */
export const establishHistoricalBackfillBoundaries = Effect.fn(
  "HistoricalBackfill.establishBoundaries",
)(function* (database: Database) {
  yield* controlTransaction(database, "BEGIN IMMEDIATE");
  return yield* Effect.gen(function* () {
    const boundaries: Record<SourceDomain, string | undefined> = {
      sessions: undefined,
      prompts: undefined,
      skill_invocations: undefined,
      execution_facts: undefined,
    };
    for (const domain of Domains) {
      const existing = yield* readStoredBoundary(database, domain);
      if (existing !== undefined) {
        boundaries[domain] = existing === EMPTY_BOUNDARY ? undefined : existing;
        continue;
      }
      // An empty boundary is still durable; do not accidentally absorb rows
      // inserted after the pre-sync snapshot.
      const highWater = yield* maxKeyFor(database, domain);
      yield* acknowledgeAnalyticalImport(
        database,
        AnalyticalImportCheckpoint.make({
          source_kind: BOUNDARY_CHECKPOINT_KIND,
          source_identity: boundaryIdentity(domain),
          source_fingerprint: highWater,
          normalizer_version: BOUNDARY_NORMALIZER_VERSION,
        }),
      ).pipe(
        Effect.mapError((error) =>
          HistoricalBackfillFailure.make({
            operation: error.operation,
            message: error.message,
          }),
        ),
      );
      boundaries[domain] = highWater === EMPTY_BOUNDARY ? undefined : highWater;
    }
    yield* controlTransaction(database, "COMMIT");
    return boundaries;
  }).pipe(
    Effect.catch((error) =>
      controlTransaction(database, "ROLLBACK").pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  );
});

const sessionPage = Effect.fn("HistoricalBackfill.sessionPage")(function* (
  database: Database,
  cursor: string,
  boundary: string | undefined,
  batchSize: number,
) {
  if (boundary === undefined) return undefined;
  const rows = yield* queryRows(
    database,
    `SELECT rowid AS cursor_key, session_id AS s_session_id, platform AS s_platform, started_at AS s_started_at,
            ended_at AS s_ended_at, capture_mode AS s_capture_mode, raw_source_ref AS s_raw_source_ref
       FROM sessions WHERE rowid > ? AND rowid <= ? ORDER BY rowid ASC LIMIT ?`,
    Number(cursor),
    Number(boundary),
    batchSize,
  );
  const last = pageCursor(rows);
  if (last === undefined) return undefined;
  return {
    domain: "sessions",
    cursor: last,
    sessions: uniqueSessions(rows),
    prompts: [],
    skill_invocations: [],
    execution_facts: [],
  } satisfies SourcePage;
});

const promptPage = Effect.fn("HistoricalBackfill.promptPage")(function* (
  database: Database,
  cursor: string,
  boundary: string | undefined,
  batchSize: number,
) {
  if (boundary === undefined) return undefined;
  const rows = yield* queryRows(
    database,
    `SELECT p.rowid AS cursor_key, p.prompt_id, p.session_id, p.occurred_at, p.raw_source_ref,
            s.session_id AS s_session_id, s.platform AS s_platform, s.started_at AS s_started_at,
            s.ended_at AS s_ended_at, s.capture_mode AS s_capture_mode, s.raw_source_ref AS s_raw_source_ref
       FROM prompts AS p JOIN sessions AS s ON s.session_id = p.session_id
      WHERE p.rowid > ? AND p.rowid <= ? ORDER BY p.rowid ASC LIMIT ?`,
    Number(cursor),
    Number(boundary),
    batchSize,
  );
  const last = pageCursor(rows);
  if (last === undefined) return undefined;
  return {
    domain: "prompts",
    cursor: last,
    sessions: uniqueSessions(rows),
    prompts: rows.map((row) =>
      omitUndefined({
        prompt_id: row.prompt_id,
        session_id: row.session_id,
        occurred_at: optional(row.occurred_at),
        raw_source_ref: optional(row.raw_source_ref),
      }),
    ),
    skill_invocations: [],
    execution_facts: [],
  } satisfies SourcePage;
});

const skillInvocationPage = Effect.fn("HistoricalBackfill.skillInvocationPage")(function* (
  database: Database,
  cursor: string,
  boundary: string | undefined,
  batchSize: number,
) {
  if (boundary === undefined) return undefined;
  const rows = yield* queryRows(
    database,
    `SELECT i.rowid AS cursor_key, i.skill_invocation_id, i.session_id, i.skill_name, i.occurred_at, i.raw_source_ref,
            s.session_id AS s_session_id, s.platform AS s_platform, s.started_at AS s_started_at,
            s.ended_at AS s_ended_at, s.capture_mode AS s_capture_mode, s.raw_source_ref AS s_raw_source_ref
       FROM skill_invocations AS i JOIN sessions AS s ON s.session_id = i.session_id
      WHERE i.rowid > ? AND i.rowid <= ? ORDER BY i.rowid ASC LIMIT ?`,
    Number(cursor),
    Number(boundary),
    batchSize,
  );
  const last = pageCursor(rows);
  if (last === undefined) return undefined;
  return {
    domain: "skill_invocations",
    cursor: last,
    sessions: uniqueSessions(rows),
    prompts: [],
    skill_invocations: rows.map((row) =>
      omitUndefined({
        skill_invocation_id: row.skill_invocation_id,
        session_id: row.session_id,
        skill_name: row.skill_name,
        occurred_at: optional(row.occurred_at),
        raw_source_ref: optional(row.raw_source_ref),
      }),
    ),
    execution_facts: [],
  } satisfies SourcePage;
});

const executionFactPage = Effect.fn("HistoricalBackfill.executionFactPage")(function* (
  database: Database,
  cursor: string,
  boundary: string | undefined,
  batchSize: number,
) {
  if (boundary === undefined) return undefined;
  const rows = yield* queryRows(
    database,
    `SELECT f.rowid AS cursor_key, f.id, f.execution_fact_id, f.session_id, f.occurred_at, f.duration_ms, f.input_tokens,
            f.output_tokens, f.total_tool_calls, f.errors_encountered, f.assistant_turns,
            f.files_changed, f.lines_added, f.lines_removed, f.lines_modified, f.cached_input_tokens,
            f.reasoning_output_tokens, f.cost_usd, f.artifact_count, f.raw_source_ref,
            s.session_id AS s_session_id, s.platform AS s_platform, s.started_at AS s_started_at,
            s.ended_at AS s_ended_at, s.capture_mode AS s_capture_mode, s.raw_source_ref AS s_raw_source_ref
       FROM execution_facts AS f JOIN sessions AS s ON s.session_id = f.session_id
      WHERE f.rowid > ? AND f.rowid <= ? ORDER BY f.rowid ASC LIMIT ?`,
    Number(cursor),
    Number(boundary),
    batchSize,
  );
  const last = pageCursor(rows);
  if (last === undefined) return undefined;
  return {
    domain: "execution_facts",
    cursor: last,
    sessions: uniqueSessions(rows),
    prompts: [],
    skill_invocations: [],
    execution_facts: rows.map((row) =>
      omitUndefined({
        id: row.id,
        execution_fact_id: optional(row.execution_fact_id),
        session_id: row.session_id,
        occurred_at: optional(row.occurred_at),
        duration_ms: optional(row.duration_ms),
        input_tokens: optional(row.input_tokens),
        output_tokens: optional(row.output_tokens),
        total_tool_calls: optional(row.total_tool_calls),
        errors_encountered: optional(row.errors_encountered),
        assistant_turns: optional(row.assistant_turns),
        files_changed: optional(row.files_changed),
        lines_added: optional(row.lines_added),
        lines_removed: optional(row.lines_removed),
        lines_modified: optional(row.lines_modified),
        cached_input_tokens: optional(row.cached_input_tokens),
        reasoning_output_tokens: optional(row.reasoning_output_tokens),
        cost_usd: optional(row.cost_usd),
        artifact_count: optional(row.artifact_count),
        raw_source_ref: optional(row.raw_source_ref),
      }),
    ),
  } satisfies SourcePage;
});

const readPage = (
  database: Database,
  domain: SourceDomain,
  cursor: string,
  boundary: string | undefined,
  batchSize: number,
) => {
  switch (domain) {
    case "sessions":
      return sessionPage(database, cursor, boundary, batchSize);
    case "prompts":
      return promptPage(database, cursor, boundary, batchSize);
    case "skill_invocations":
      return skillInvocationPage(database, cursor, boundary, batchSize);
    case "execution_facts":
      return executionFactPage(database, cursor, boundary, batchSize);
  }
};

const serializeFields = (fields: ReadonlyArray<readonly [string, string]>): string =>
  `{${fields
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${value}`)
    .join(",")}}`;

const serializeRows = (rows: ReadonlyArray<SqlRow>): string =>
  `[${rows
    .map((row) =>
      serializeFields(Object.entries(row).map(([key, value]) => [key, JSON.stringify(value)])),
    )
    .join(",")}]`;

const serializePage = (page: SourcePage): string => {
  const fields: Record<keyof SourcePage, string> = {
    cursor: JSON.stringify(page.cursor),
    domain: JSON.stringify(page.domain),
    execution_facts: serializeRows(page.execution_facts),
    prompts: serializeRows(page.prompts),
    sessions: serializeRows(page.sessions),
    skill_invocations: serializeRows(page.skill_invocations),
  };
  return serializeFields(Object.entries(fields));
};

const revisionFor = (page: SourcePage) =>
  createHash("sha256")
    .update("selftune.historical-backfill.sqlite-canonical.v2\0")
    .update(serializePage(page))
    .digest("hex");

const acknowledgeCursor = Effect.fn("HistoricalBackfill.acknowledgeCursor")(function* (
  database: Database,
  domain: SourceDomain,
  cursor: string,
) {
  return yield* acknowledgeAnalyticalImport(
    database,
    AnalyticalImportCheckpoint.make({
      source_kind: CHECKPOINT_KIND,
      source_identity: checkpointIdentity(domain),
      source_fingerprint: cursor,
      normalizer_version: HISTORICAL_BACKFILL_NORMALIZER_VERSION,
    }),
  ).pipe(
    Effect.mapError((error) =>
      HistoricalBackfillFailure.make({
        operation: error.operation,
        message: error.message,
      }),
    ),
  );
});

/**
 * Replays canonical SQLite source rows in independently bounded keysets.
 * Each batch goes through the public LocalTraceImporter; only after its
 * DuckDB receipt and per-import SQLite acknowledgement return do we advance
 * this table's SQLite cursor. There is intentionally no cross-database transaction.
 */
export const runHistoricalBackfill = Effect.fn("HistoricalBackfill.run")(function* (
  database: Database,
  options: HistoricalBackfillOptions = {},
) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    return yield* Effect.fail(
      HistoricalBackfillFailure.make({
        operation: "configure historical backfill",
        message: `batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}.`,
      }),
    );
  }
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  if (
    maxBatches !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxBatches) || maxBatches < 1)
  ) {
    return yield* Effect.fail(
      HistoricalBackfillFailure.make({
        operation: "configure historical backfill",
        message: "maxBatches must be a positive integer when supplied.",
      }),
    );
  }
  const importer = yield* LocalTraceImporter;
  const boundaries = yield* establishHistoricalBackfillBoundaries(database);
  const cursors: Record<SourceDomain, string | undefined> = {
    sessions: options.restart ? undefined : yield* readCursor(database, "sessions"),
    prompts: options.restart ? undefined : yield* readCursor(database, "prompts"),
    skill_invocations: options.restart
      ? undefined
      : yield* readCursor(database, "skill_invocations"),
    execution_facts: options.restart ? undefined : yield* readCursor(database, "execution_facts"),
  };
  let batchesRead = 0;
  let importsAttempted = 0;
  let sourceRowsSeen = 0;
  let withheldUnsupportedPlatform = 0;
  let withheldMissingTimestamp = 0;
  let withheldMissingIdentity = 0;

  for (const domain of Domains) {
    while (batchesRead < maxBatches) {
      const page = yield* readPage(
        database,
        domain,
        cursors[domain] ?? "",
        boundaries[domain],
        batchSize,
      );
      if (page === undefined) break;
      const normalized = yield* normalizeHistoricalBackfill({
        source_cursor: `${domain}:${cursors[domain] ?? INITIAL_CURSOR}`,
        source_revision: revisionFor(page),
        source_domain: page.domain,
        include_session_spans: page.domain === "sessions",
        sessions: page.sessions,
        prompts: page.prompts,
        skill_invocations: page.skill_invocations,
        execution_facts: page.execution_facts,
      }).pipe(
        Effect.mapError((error) =>
          HistoricalBackfillFailure.make({
            operation: error.operation,
            message: error.message,
          }),
        ),
      );
      for (const request of normalized.imports) {
        yield* options.hooks?.beforeImport?.(request.batch.batch_id) ?? Effect.void;
        yield* importer.importTrace(request).pipe(
          Effect.mapError((error) =>
            HistoricalBackfillFailure.make({
              operation: error.operation,
              message: error.message,
            }),
          ),
        );
        yield* options.hooks?.afterImport?.(request.batch.batch_id) ?? Effect.void;
        importsAttempted += 1;
      }
      yield* options.hooks?.beforeCheckpoint?.(`${domain}:${page.cursor}`) ?? Effect.void;
      yield* acknowledgeCursor(database, domain, page.cursor);
      yield* options.hooks?.afterCheckpoint?.(`${domain}:${page.cursor}`) ?? Effect.void;
      cursors[domain] = page.cursor;
      batchesRead += 1;
      sourceRowsSeen +=
        page.domain === "sessions"
          ? page.sessions.length
          : page.prompts.length + page.skill_invocations.length + page.execution_facts.length;
      for (const item of normalized.withheld) {
        switch (item.reason) {
          case "unsupported_platform":
            withheldUnsupportedPlatform += 1;
            break;
          case "missing_timestamp":
            withheldMissingTimestamp += 1;
            break;
          case "missing_identity":
            withheldMissingIdentity += 1;
            break;
        }
      }
    }
    if (batchesRead >= maxBatches) break;
  }
  return {
    batches_read: batchesRead,
    imports_attempted: importsAttempted,
    source_rows_seen: sourceRowsSeen,
    withheld_unsupported_platform: withheldUnsupportedPlatform,
    withheld_missing_timestamp: withheldMissingTimestamp,
    withheld_missing_identity: withheldMissingIdentity,
    cursors,
  } satisfies HistoricalBackfillResult;
});
