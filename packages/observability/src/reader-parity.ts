import * as Schema from "effect/Schema";
import { Effect, Option } from "effect";
import type { Database } from "bun:sqlite";

import type { DuckDbConnection } from "./duckdb-store.js";

const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const ProvenanceReference = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Timestamp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const Count = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const MetricValue = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const PageLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(256),
);

export const HistoricalEvidenceQuality = Schema.Literals([
  "source_exact",
  "inferred",
  "metadata_only",
  "unavailable",
]);

export class TraceEvidenceCursor extends Schema.Class<TraceEvidenceCursor>("TraceEvidenceCursor")({
  observed_at: Timestamp,
  source_id: BoundedText,
  evidence_id: BoundedText,
}) {}

/**
 * The reader projection intentionally contains only fields present in both
 * historical SQLite and normalized analytics. Undefined metrics are evidence
 * gaps, not zeroes and never an invitation to infer cumulative snapshots.
 */
export class TraceEvidenceItem extends Schema.Class<TraceEvidenceItem>("TraceEvidenceItem")({
  evidence_id: BoundedText,
  source_id: BoundedText,
  observed_at: Timestamp,
  source_kind: BoundedText,
  evidence_quality: HistoricalEvidenceQuality,
  source_reference: Schema.optionalKey(ProvenanceReference),
  trace_id: Schema.optionalKey(BoundedText),
  span_id: Schema.optionalKey(BoundedText),
  log_id: Schema.optionalKey(BoundedText),
  skill_name: Schema.optionalKey(BoundedText),
  metric_name: Schema.optionalKey(BoundedText),
  metric_value: Schema.optionalKey(MetricValue),
  metric_unit: Schema.optionalKey(BoundedText),
  metric_temporality: Schema.optionalKey(Schema.Literal("cumulative")),
  gaps: Schema.Array(BoundedText).check(Schema.isMaxLength(8)),
}) {}

export class TraceEvidencePageRequest extends Schema.Class<TraceEvidencePageRequest>(
  "TraceEvidencePageRequest",
)({
  limit: PageLimit,
  after: Schema.optionalKey(TraceEvidenceCursor),
}) {}

export class TraceEvidencePage extends Schema.Class<TraceEvidencePage>("TraceEvidencePage")({
  items: Schema.Array(TraceEvidenceItem).check(Schema.isMaxLength(256)),
  next: Schema.optionalKey(TraceEvidenceCursor),
  /** Observed bounded scan work reported by the reader, not an estimate. */
  facts_visited: Count,
  sqlite_checkpoint_state: Schema.Literals(["current", "stale", "missing", "not_applicable"]),
}) {}

export type TraceEvidenceReader = {
  readonly kind: "compatibility_sqlite" | "duckdb";
  readonly readPage: (request: TraceEvidencePageRequest) => Promise<TraceEvidencePage>;
};

export type CompatibilitySqliteQuery = {
  readonly query: (
    sql: string,
    parameters: Readonly<Record<string, number | string | null>>,
  ) => ReturnType<ReturnType<Database["query"]>["all"]>;
};

const decodePage = Schema.decodeUnknownSync(TraceEvidencePage);

function optionalColumn<S extends Schema.Top>(schema: S) {
  return Schema.catchDecoding<Schema.optionalKey<S>>(() => Effect.succeed(Option.none()))(
    Schema.optionalKey(schema),
  );
}
const NumericInput = Schema.Union([Schema.Number, Schema.BigInt, Schema.String]);
const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const EvidenceRow = Schema.Struct({
  evidence_id: Schema.String,
  source_id: Schema.String,
  observed_at: Schema.String,
  source_kind: optionalColumn(NonEmptyText),
  evidence_quality: optionalColumn(HistoricalEvidenceQuality),
  source_reference: optionalColumn(NonEmptyText),
  trace_id: optionalColumn(NonEmptyText),
  span_id: optionalColumn(NonEmptyText),
  log_id: optionalColumn(NonEmptyText),
  skill_name: optionalColumn(NonEmptyText),
  metric_name: optionalColumn(NonEmptyText),
  metric_value: optionalColumn(NumericInput),
  metric_unit: optionalColumn(NonEmptyText),
  metric_temporality: optionalColumn(Schema.Literal("cumulative")),
});
const decodeEvidenceRow = Schema.decodeUnknownSync(EvidenceRow);
const isText = Schema.is(Schema.String);
const isMetric = Schema.is(MetricValue);

const cursorClause = (prefix: string) => `(
  ${prefix}.observed_at > $after_observed_at
  OR (${prefix}.observed_at = $after_observed_at AND ${prefix}.source_id > $after_source_id)
  OR (${prefix}.observed_at = $after_observed_at AND ${prefix}.source_id = $after_source_id
    AND ${prefix}.evidence_id > $after_evidence_id)
)`;

const emptyCursor = "1970-01-01T00:00:00.000Z";

const numeric = (value: typeof NumericInput.Type | undefined): number | undefined => {
  if (value === undefined || (isText(value) && value.trim().length === 0)) return undefined;
  const candidate = Number(value);
  return isMetric(candidate) ? candidate : undefined;
};

const normalizedTimestamp = (raw: string): string => {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
};

type EvidenceItemDraft = { -readonly [Key in keyof TraceEvidenceItem]: TraceEvidenceItem[Key] };
type EvidencePageDraft = { -readonly [Key in keyof TraceEvidencePage]: TraceEvidencePage[Key] };

function evidenceItem(row: typeof EvidenceRow.Type, kind: TraceEvidenceReader["kind"]) {
  const item: EvidenceItemDraft = {
    evidence_id: row.evidence_id,
    source_id: row.source_id,
    observed_at: normalizedTimestamp(row.observed_at),
    source_kind: row.source_kind ?? "unknown",
    evidence_quality:
      kind === "compatibility_sqlite" ? "source_exact" : (row.evidence_quality ?? "unavailable"),
    gaps:
      kind === "compatibility_sqlite"
        ? [
            "trace_identity_not_available_in_compatibility_reader",
            "skill_point_correlation_not_available_in_compatibility_reader",
          ]
        : [],
  };
  for (const key of ["source_reference", "metric_name", "metric_unit"] as const) {
    const value = row[key];
    if (value !== undefined) item[key] = value;
  }
  const metricValue = numeric(row.metric_value);
  if (metricValue !== undefined) item.metric_value = metricValue;
  if (kind === "compatibility_sqlite") item.metric_temporality = "cumulative";
  else {
    for (const key of ["trace_id", "span_id", "log_id", "skill_name"] as const) {
      const value = row[key];
      if (value !== undefined) item[key] = value;
    }
    if (row.metric_temporality !== undefined) item.metric_temporality = row.metric_temporality;
  }
  return TraceEvidenceItem.make(item);
}

function evidencePage(
  items: TraceEvidenceItem[],
  limit: number,
  factsVisited: number,
  checkpointState: TraceEvidencePage["sqlite_checkpoint_state"],
) {
  const page: EvidencePageDraft = {
    items,
    facts_visited: factsVisited,
    sqlite_checkpoint_state: checkpointState,
  };
  const last = items.at(-1);
  if (factsVisited > limit && last !== undefined) {
    page.next = TraceEvidenceCursor.make({
      observed_at: last.observed_at,
      source_id: last.source_id,
      evidence_id: last.evidence_id,
    });
  }
  return decodePage(page);
}

/**
 * Compatibility reader over the existing SQLite operational projection. It
 * exposes cumulative source points; it never sums them into fabricated spans.
 */
export const makeCompatibilitySqliteTraceEvidenceReader = (
  database: CompatibilitySqliteQuery,
  checkpointState: TraceEvidencePage["sqlite_checkpoint_state"],
): TraceEvidenceReader => ({
  kind: "compatibility_sqlite",
  readPage: async (request) => {
    const decoded = Schema.decodeUnknownSync(TraceEvidencePageRequest)(request);
    const rows = database.query(
      `WITH source_rows AS (
        SELECT
          f.occurred_at AS observed_at,
          'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id) AS source_id,
          'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id) || ':duration_ms' AS evidence_id,
          s.platform AS source_kind,
          COALESCE(f.raw_source_ref, s.raw_source_ref) AS source_reference,
          'duration_ms' AS metric_name,
          f.duration_ms AS metric_value,
          'ms' AS metric_unit
        FROM sessions AS s
        INNER JOIN execution_facts AS f ON f.session_id = s.session_id
        WHERE f.duration_ms IS NOT NULL AND f.occurred_at IS NOT NULL
          AND s.platform IN ('codex', 'claude_code', 'opencode', 'pi')
        UNION ALL
        SELECT f.occurred_at, 'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id),
          'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id) || ':input_tokens', s.platform, COALESCE(f.raw_source_ref, s.raw_source_ref),
          'input_tokens', f.input_tokens, 'count'
        FROM sessions AS s INNER JOIN execution_facts AS f ON f.session_id = s.session_id
        WHERE f.input_tokens IS NOT NULL AND f.occurred_at IS NOT NULL AND s.platform IN ('codex', 'claude_code', 'opencode', 'pi')
        UNION ALL
        SELECT f.occurred_at, 'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id),
          'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id) || ':output_tokens', s.platform, COALESCE(f.raw_source_ref, s.raw_source_ref),
          'output_tokens', f.output_tokens, 'count'
        FROM sessions AS s INNER JOIN execution_facts AS f ON f.session_id = s.session_id
        WHERE f.output_tokens IS NOT NULL AND f.occurred_at IS NOT NULL AND s.platform IN ('codex', 'claude_code', 'opencode', 'pi')
        UNION ALL
        SELECT f.occurred_at, 'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id),
          'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id) || ':tool_call_count', s.platform, COALESCE(f.raw_source_ref, s.raw_source_ref),
          'tool_call_count', f.total_tool_calls, 'count'
        FROM sessions AS s INNER JOIN execution_facts AS f ON f.session_id = s.session_id
        WHERE f.total_tool_calls IS NOT NULL AND f.occurred_at IS NOT NULL AND s.platform IN ('codex', 'claude_code', 'opencode', 'pi')
        UNION ALL
        SELECT f.occurred_at, 'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id),
          'execution_fact:' || COALESCE(f.execution_fact_id, 'legacy-' || f.id) || ':error_count', s.platform, COALESCE(f.raw_source_ref, s.raw_source_ref),
          'error_count', f.errors_encountered, 'count'
        FROM sessions AS s INNER JOIN execution_facts AS f ON f.session_id = s.session_id
        WHERE f.errors_encountered IS NOT NULL AND f.occurred_at IS NOT NULL AND s.platform IN ('codex', 'claude_code', 'opencode', 'pi')
      )
      SELECT observed_at, source_id, evidence_id, source_kind, source_reference,
        metric_name, metric_value, metric_unit
      FROM source_rows
      WHERE observed_at IS NOT NULL AND ${cursorClause("source_rows")}
      ORDER BY observed_at, source_id, evidence_id
      LIMIT $limit_plus_one`,
      {
        $after_observed_at: decoded.after?.observed_at ?? emptyCursor,
        $after_source_id: decoded.after?.source_id ?? "",
        $after_evidence_id: decoded.after?.evidence_id ?? "",
        $limit_plus_one: decoded.limit + 1,
      },
    );
    const items = rows
      .slice(0, decoded.limit)
      .map((value) => evidenceItem(decodeEvidenceRow(value), "compatibility_sqlite"));
    return evidencePage(items, decoded.limit, rows.length, checkpointState);
  },
});

/**
 * Bounded DuckDB reader for normalized historical point facts. The historical
 * migration owns the dedicated tables; this query never treats cumulative
 * metric snapshots as independent spans or sums them.
 */
export const makeDuckDbTraceEvidenceReader = (
  connection: DuckDbConnection,
  checkpointState: TraceEvidencePage["sqlite_checkpoint_state"],
): TraceEvidenceReader => ({
  kind: "duckdb",
  readPage: async (request) => {
    const decoded = Schema.decodeUnknownSync(TraceEvidencePageRequest)(request);
    const result = await connection.run(
      `WITH point_rows AS (
        SELECT
          strftime(metric.observed_at, '%Y-%m-%dT%H:%M:%S.%fZ') AS observed_at,
          metric.source_id AS source_id,
          metric.source_id || ':' || metric.metric_name AS evidence_id,
          metric.source_kind AS source_kind,
          metric.evidence_quality AS evidence_quality,
          metric.source_reference AS source_reference,
          metric.trace_id AS trace_id,
          metric.span_id AS span_id,
          metric.log_id AS log_id,
          skill.skill_name AS skill_name,
          metric.metric_name AS metric_name,
          metric.value AS metric_value,
          metric.unit AS metric_unit,
          metric.temporality AS metric_temporality
        FROM observability_historical_metric_points AS metric
        LEFT JOIN observability_historical_log_skill_links AS skill ON skill.log_id = metric.log_id
        WHERE metric.metric_name IN (
          'duration_ms',
          'input_tokens',
          'output_tokens',
          'tool_call_count',
          'error_count'
        )
      )
      SELECT * FROM point_rows
      WHERE ${cursorClause("point_rows")}
      ORDER BY observed_at, source_id, evidence_id
      LIMIT $limit_plus_one`,
      {
        after_observed_at: decoded.after?.observed_at ?? emptyCursor,
        after_source_id: decoded.after?.source_id ?? "",
        after_evidence_id: decoded.after?.evidence_id ?? "",
        limit_plus_one: decoded.limit + 1,
      },
    );
    const rows = await result.getRowObjects();
    const items = rows
      .slice(0, decoded.limit)
      .map((value) => evidenceItem(decodeEvidenceRow(value), "duckdb"));
    return evidencePage(items, decoded.limit, rows.length, checkpointState);
  },
});

export class ReaderMeasurement extends Schema.Class<ReaderMeasurement>("ReaderMeasurement")({
  reader: Schema.Literals(["compatibility_sqlite", "duckdb"]),
  wall_time_ms: Count,
  facts_visited: Count,
  response_bytes: Count,
  process_rss_bytes: Count,
  sqlite_checkpoint_state: Schema.Literals(["current", "stale", "missing", "not_applicable"]),
}) {}

export const measureTraceEvidenceReader = async (
  reader: TraceEvidenceReader,
  request: TraceEvidencePageRequest,
  memoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage,
): Promise<{ readonly page: TraceEvidencePage; readonly measurement: ReaderMeasurement }> => {
  const startedAt = performance.now();
  const page = await reader.readPage(request);
  const wallTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
  return {
    page,
    measurement: ReaderMeasurement.make({
      reader: reader.kind,
      wall_time_ms: wallTimeMs,
      facts_visited: page.facts_visited,
      response_bytes: new TextEncoder().encode(JSON.stringify(page.items)).byteLength,
      process_rss_bytes: memoryUsage().rss,
      sqlite_checkpoint_state: page.sqlite_checkpoint_state,
    }),
  };
};

export class ReaderParityReport extends Schema.Class<ReaderParityReport>("ReaderParityReport")({
  comparable_rows: Count,
  matching_rows: Count,
  fresh: Schema.Boolean,
  current_checkpoint: Schema.Boolean,
  mismatches: Schema.Array(BoundedText).check(Schema.isMaxLength(256)),
  compatibility_gaps: Schema.Array(BoundedText).check(Schema.isMaxLength(256)),
  rollback_safe: Schema.Boolean,
}) {}

const correlationKey = (item: TraceEvidenceItem) =>
  `${item.source_id}\u0000${item.observed_at}\u0000${item.metric_name ?? ""}`;

/** Only fields represented by both readers participate in equality. */
export const compareTraceEvidencePages = (
  compatibility: TraceEvidencePage,
  analytical: TraceEvidencePage,
  rollbackSafe: boolean,
): ReaderParityReport => {
  const analyticalByKey = new Map(analytical.items.map((item) => [correlationKey(item), item]));
  const mismatches: string[] = [];
  const gaps = new Set<string>();
  let comparable = 0;
  let matching = 0;
  for (const item of compatibility.items) {
    for (const gap of item.gaps) gaps.add(gap);
    const other = analyticalByKey.get(correlationKey(item));
    if (other === undefined) {
      mismatches.push(`missing_analytical:${item.evidence_id}`);
      continue;
    }
    comparable += 1;
    if (
      item.source_kind === other.source_kind &&
      item.metric_value === other.metric_value &&
      item.metric_unit === other.metric_unit &&
      item.metric_temporality === other.metric_temporality &&
      item.evidence_quality === other.evidence_quality
    ) {
      matching += 1;
    } else mismatches.push(`projection:${item.evidence_id}`);
  }
  return ReaderParityReport.make({
    comparable_rows: comparable,
    matching_rows: matching,
    fresh:
      compatibility.items.length === analytical.items.length &&
      compatibility.next?.observed_at === analytical.next?.observed_at &&
      compatibility.next?.source_id === analytical.next?.source_id &&
      compatibility.next?.evidence_id === analytical.next?.evidence_id,
    current_checkpoint:
      compatibility.sqlite_checkpoint_state === "current" &&
      analytical.sqlite_checkpoint_state === "current",
    mismatches,
    compatibility_gaps: [...gaps].toSorted(),
    rollback_safe: rollbackSafe,
  });
};

/** In-memory state machine; the runtime persists its selected mode separately. */
export const makeRollbackSafeReaderSelector = (compatibility: TraceEvidenceReader) => {
  let active = compatibility;
  return {
    active: () => active,
    promote: (candidate: TraceEvidenceReader, proof: ReaderParityReport) => {
      if (
        proof.comparable_rows === 0 ||
        proof.matching_rows !== proof.comparable_rows ||
        proof.mismatches.length > 0 ||
        !proof.fresh ||
        !proof.current_checkpoint ||
        !proof.rollback_safe
      )
        return false;
      active = candidate;
      return true;
    },
    rollback: () => {
      active = compatibility;
    },
  };
};
