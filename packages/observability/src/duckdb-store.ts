/* oxlint-disable max-lines -- one private DuckDB adapter owns schema, migration, and atomic topology ingest. */
import { SELFTUNE_LOCAL_ANALYTICS_PATH } from "@selftune/config/paths";
import type { DuckDBValue } from "@duckdb/node-api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { EvidenceCohortCandidate, EvidenceCohortPattern } from "./evidence-cohort.js";

const TraceId = Schema.String.check(
  Schema.isLengthBetween(32, 32),
  Schema.isPattern(/^[0-9a-f]{32}$/),
);
const SpanId = Schema.String.check(
  Schema.isLengthBetween(16, 16),
  Schema.isPattern(/^[0-9a-f]{16}$/),
);
const LinkId = Schema.String.check(
  Schema.isLengthBetween(32, 32),
  Schema.isPattern(/^[0-9a-f]{32}$/),
);
const LogId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(96));
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const ProvenanceReference = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Timestamp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const MetricCount = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const MetricValue = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Platform = Schema.Literals([
  "claude_code",
  "codex",
  "opencode",
  "pi",
  "cline",
  "otlp",
  "external",
]);
const CaptureMode = Schema.Literals([
  "hook",
  "replay",
  "transcript",
  "rollout",
  "session",
  "wrapper",
  "batch_ingest",
  "repair",
  "otlp",
]);
const SourceAuthority = Schema.Literals(["provisional", "source_truth", "repair", "external"]);
const TraceBoundary = Schema.Literals([
  "actionable_turn",
  "autonomous_task",
  "session",
  "external_trace",
]);
const SpanKind = Schema.Literals([
  "UNSPECIFIED",
  "INTERNAL",
  "SERVER",
  "CLIENT",
  "PRODUCER",
  "CONSUMER",
]);
const SpanStatus = Schema.Literals(["UNSET", "OK", "ERROR"]);
const EvidenceQuality = Schema.Literals(["source_exact", "inferred", "metadata_only"]);

export class DuckDbTraceResource extends Schema.Class<DuckDbTraceResource>("DuckDbTraceResource")({
  resource_id: BoundedText,
  service_name: BoundedText,
  service_namespace: Schema.optionalKey(BoundedText),
  service_version: Schema.optionalKey(BoundedText),
  service_instance_id: Schema.optionalKey(BoundedText),
  deployment_environment: Schema.optionalKey(BoundedText),
  schema_url: Schema.optionalKey(BoundedText),
  platform: Platform,
}) {}

export class DuckDbTraceInstrumentationScope extends Schema.Class<DuckDbTraceInstrumentationScope>(
  "DuckDbTraceInstrumentationScope",
)({
  scope_id: BoundedText,
  resource_id: BoundedText,
  name: BoundedText,
  version: Schema.optionalKey(BoundedText),
  schema_url: Schema.optionalKey(BoundedText),
}) {}

/**
 * The analytical import boundary deliberately carries a resolved skill name.
 * SQLite remains the owner of invocation identity and operational lifecycle;
 * DuckDB receives only the immutable fact needed for analytical grouping.
 */
export class DuckDbTraceSkillLink extends Schema.Class<DuckDbTraceSkillLink>(
  "DuckDbTraceSkillLink",
)({
  link_id: LinkId,
  span_id: SpanId,
  trace_id: TraceId,
  skill_invocation_id: BoundedText,
  skill_name: BoundedText,
}) {}

export class DuckDbTraceSpan extends Schema.Class<DuckDbTraceSpan>("DuckDbTraceSpan")({
  trace_id: TraceId,
  span_id: SpanId,
  name: BoundedText,
  started_at: Timestamp,
  ended_at: Timestamp,
  platform: Platform,
  capture_mode: CaptureMode,
  source_authority: SourceAuthority,
  trace_boundary: TraceBoundary,
  operation_name: BoundedText,
  source_id: BoundedText,
  resource_id: Schema.optionalKey(BoundedText),
  scope_id: Schema.optionalKey(BoundedText),
  parent_span_id: Schema.optionalKey(SpanId),
  kind: Schema.optionalKey(SpanKind),
  status: Schema.optionalKey(SpanStatus),
  provider: Schema.optionalKey(BoundedText),
  model: Schema.optionalKey(BoundedText),
  conversation_id: Schema.optionalKey(BoundedText),
  tool_name: Schema.optionalKey(BoundedText),
  evidence_quality: Schema.optionalKey(EvidenceQuality),
  source_reference: Schema.optionalKey(ProvenanceReference),
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
}) {}

export class DuckDbTraceLogRecord extends Schema.Class<DuckDbTraceLogRecord>(
  "DuckDbTraceLogRecord",
)({
  log_id: LogId,
  trace_id: TraceId,
  source_id: Schema.optionalKey(BoundedText),
  timestamp: Timestamp,
  event_name: BoundedText,
  span_id: Schema.optionalKey(SpanId),
  resource_id: Schema.optionalKey(BoundedText),
  scope_id: Schema.optionalKey(BoundedText),
  severity: Schema.optionalKey(
    Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]),
  ),
  evidence_quality: Schema.optionalKey(EvidenceQuality),
  source_reference: Schema.optionalKey(ProvenanceReference),
}) {}

/** Cumulative source snapshots are retained as points, never span-derived deltas. */
export class DuckDbHistoricalMetricPoint extends Schema.Class<DuckDbHistoricalMetricPoint>(
  "DuckDbHistoricalMetricPoint",
)({
  metric_id: LogId,
  trace_id: TraceId,
  observed_at: Timestamp,
  name: BoundedText,
  value: MetricValue,
  unit: BoundedText,
  temporality: Schema.Literal("cumulative"),
  source_kind: Platform,
  span_id: Schema.optionalKey(SpanId),
  log_id: Schema.optionalKey(LogId),
  evidence_quality: EvidenceQuality,
  source_id: BoundedText,
  source_reference: ProvenanceReference,
}) {}

/** Correlates historical point-in-time evidence to a skill without inventing a parent span. */
export class DuckDbHistoricalLogSkillLink extends Schema.Class<DuckDbHistoricalLogSkillLink>(
  "DuckDbHistoricalLogSkillLink",
)({
  link_id: LinkId,
  trace_id: TraceId,
  log_id: LogId,
  skill_invocation_id: BoundedText,
  skill_name: BoundedText,
}) {}

export class DuckDbHistoricalMetricRollup extends Schema.Class<DuckDbHistoricalMetricRollup>(
  "DuckDbHistoricalMetricRollup",
)({
  trace_id: TraceId,
  source_id: BoundedText,
  metric_name: BoundedText,
  observed_at: Timestamp,
  value: MetricValue,
  unit: BoundedText,
  temporality: Schema.Literal("cumulative"),
  evidence_quality: EvidenceQuality,
  source_reference: ProvenanceReference,
}) {}

export class DuckDbHistoricalMetricRollupCursor extends Schema.Class<DuckDbHistoricalMetricRollupCursor>(
  "DuckDbHistoricalMetricRollupCursor",
)({
  trace_id: TraceId,
  metric_name: BoundedText,
}) {}

export class DuckDbHistoricalMetricRollupQuery extends Schema.Class<DuckDbHistoricalMetricRollupQuery>(
  "DuckDbHistoricalMetricRollupQuery",
)({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(256),
  ),
  after: Schema.optionalKey(DuckDbHistoricalMetricRollupCursor),
}) {}

export class DuckDbHistoricalMetricRollupPage extends Schema.Class<DuckDbHistoricalMetricRollupPage>(
  "DuckDbHistoricalMetricRollupPage",
)({
  items: Schema.Array(DuckDbHistoricalMetricRollup).check(Schema.isMaxLength(256)),
  next: Schema.optionalKey(DuckDbHistoricalMetricRollupCursor),
}) {}

export class DuckDbTraceSpanLink extends Schema.Class<DuckDbTraceSpanLink>("DuckDbTraceSpanLink")({
  link_id: LinkId,
  trace_id: TraceId,
  span_id: SpanId,
  target_trace_id: TraceId,
  target_span_id: Schema.optionalKey(SpanId),
  kind: Schema.optionalKey(
    Schema.Literals(["replay_of", "evaluation_of", "repair_of", "evolution_of"]),
  ),
}) {}

export class DuckDbAnalyticalBatch extends Schema.Class<DuckDbAnalyticalBatch>(
  "DuckDbAnalyticalBatch",
)({
  schema_version: Schema.Literal("1.0.0"),
  batch_id: BoundedText,
  source_revision: BoundedText,
  normalizer_version: BoundedText,
  spans: Schema.Array(DuckDbTraceSpan).check(Schema.isMaxLength(256)),
  links: Schema.Array(DuckDbTraceSkillLink).check(Schema.isMaxLength(256)),
  resources: Schema.optionalKey(Schema.Array(DuckDbTraceResource).check(Schema.isMaxLength(64))),
  instrumentation_scopes: Schema.optionalKey(
    Schema.Array(DuckDbTraceInstrumentationScope).check(Schema.isMaxLength(64)),
  ),
  logs: Schema.optionalKey(Schema.Array(DuckDbTraceLogRecord).check(Schema.isMaxLength(256))),
  metric_points: Schema.optionalKey(
    Schema.Array(DuckDbHistoricalMetricPoint).check(Schema.isMaxLength(256)),
  ),
  log_skill_links: Schema.optionalKey(
    Schema.Array(DuckDbHistoricalLogSkillLink).check(Schema.isMaxLength(256)),
  ),
  span_links: Schema.optionalKey(Schema.Array(DuckDbTraceSpanLink).check(Schema.isMaxLength(256))),
}) {}

export class DuckDbAnalyticalIngestReceipt extends Schema.Class<DuckDbAnalyticalIngestReceipt>(
  "DuckDbAnalyticalIngestReceipt",
)({
  batch_id: BoundedText,
  disposition: Schema.Literals(["accepted", "duplicate"]),
  spans_received: MetricCount,
  metrics_derived: MetricCount,
  links_received: MetricCount,
  resources_received: MetricCount,
  scopes_received: MetricCount,
  logs_received: MetricCount,
  metric_points_received: MetricCount,
  log_skill_links_received: MetricCount,
  span_links_received: MetricCount,
}) {}

export class DuckDbSkillTraceSignals extends Schema.Class<DuckDbSkillTraceSignals>(
  "DuckDbSkillTraceSignals",
)({
  skill_name: BoundedText,
  invocation_count: MetricCount,
  trace_count: MetricCount,
  error_trace_count: MetricCount,
  duration_ms: MetricCount,
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
}) {}

/** Query input is a supported pattern, not arbitrary SQL or a transcript selector. */
export class DuckDbEvidenceCohortQuery extends Schema.Class<DuckDbEvidenceCohortQuery>(
  "DuckDbEvidenceCohortQuery",
)({
  pattern: EvidenceCohortPattern,
}) {}

/** Neutral historical task provenance used for randomized execution-quality replay. */
export class DuckDbHistoricalSkillTaskReference extends Schema.Class<DuckDbHistoricalSkillTaskReference>(
  "DuckDbHistoricalSkillTaskReference",
)({
  trace_id: TraceId,
  span_id: SpanId,
  skill_invocation_id: BoundedText,
  source_id: BoundedText,
  source_revision: BoundedText,
  trace_boundary: TraceBoundary,
  capture_mode: CaptureMode,
  source_authority: SourceAuthority,
  evidence_quality: Schema.optionalKey(EvidenceQuality),
  model: Schema.optionalKey(BoundedText),
}) {}

export class DuckDbHistoricalSkillTaskQuery extends Schema.Class<DuckDbHistoricalSkillTaskQuery>(
  "DuckDbHistoricalSkillTaskQuery",
)({
  skill_id: BoundedText,
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(512),
  ),
}) {}

export class DuckDbAnalyticalStoreHealth extends Schema.Class<DuckDbAnalyticalStoreHealth>(
  "DuckDbAnalyticalStoreHealth",
)({
  database_path: Schema.String,
  schema_version: Schema.Literal(9),
  span_count: MetricCount,
  metric_count: MetricCount,
  link_count: MetricCount,
  resource_count: MetricCount,
  scope_count: MetricCount,
  log_count: MetricCount,
  historical_metric_point_count: MetricCount,
  historical_log_skill_link_count: MetricCount,
  span_link_count: MetricCount,
}) {}

export class DuckDbAnalyticalStoreFailure extends Schema.TaggedErrorClass<DuckDbAnalyticalStoreFailure>()(
  "DuckDbAnalyticalStoreFailure",
  { operation: Schema.String, message: Schema.String },
) {}

type DuckDbParameter = null | number | string;
type DuckDbParameters = Readonly<Record<string, DuckDbParameter>>;

/** A timestamp value that must use DuckDB's typed appender path. */
export type DuckDbTimestamp = {
  readonly _tag: "DuckDbTimestamp";
  readonly micros: bigint;
};

export type DuckDbAppendValue = DuckDbParameter | DuckDbTimestamp;
type DuckDbRow = ReadonlyArray<DuckDbAppendValue>;
type DerivedMetricName = "input_tokens" | "output_tokens" | "error_count" | "tool_call_count";

/** Minimal stable seam over @duckdb/node-api, kept private to this module. */
export interface DuckDbQueryResult {
  readonly getRowObjects: () => Promise<ReadonlyArray<Record<string, DuckDBValue>>>;
}

export interface DuckDbConnection {
  readonly appendRows: (table: string, rows: ReadonlyArray<DuckDbRow>) => Promise<void>;
  readonly run: (sql: string, parameters?: DuckDbParameters) => Promise<DuckDbQueryResult>;
  readonly closeSync: () => void;
}

export interface DuckDbInstance {
  readonly connect: () => Promise<DuckDbConnection>;
  readonly closeSync: () => void;
}

export interface DuckDbInstanceFactory {
  readonly open: (path: string) => Promise<DuckDbInstance>;
}

export interface DuckDbAnalyticalStoreService {
  /**
   * Verifies the durable analytical receipt for one normalized source revision.
   * This is intentionally a domain operation rather than exposing DuckDB query
   * access: SQLite checkpoints are only valid while this receipt also exists.
   */
  readonly hasExactBatchReceipt: (
    input: typeof DuckDbAnalyticalBatch.Encoded,
  ) => Effect.Effect<boolean, DuckDbAnalyticalStoreFailure>;
  readonly ingest: (
    input: typeof DuckDbAnalyticalBatch.Encoded,
  ) => Effect.Effect<DuckDbAnalyticalIngestReceipt, DuckDbAnalyticalStoreFailure>;
  readonly querySkillSignals: () => Effect.Effect<
    ReadonlyArray<DuckDbSkillTraceSignals>,
    DuckDbAnalyticalStoreFailure
  >;
  /** Returns concrete, source-native references only; it never resolves transcript bodies. */
  readonly queryEvidenceCohortCandidates: (
    input: typeof DuckDbEvidenceCohortQuery.Encoded,
  ) => Effect.Effect<ReadonlyArray<EvidenceCohortCandidate>, DuckDbAnalyticalStoreFailure>;
  readonly queryHistoricalSkillTaskReferences: (
    input: typeof DuckDbHistoricalSkillTaskQuery.Encoded,
  ) => Effect.Effect<
    ReadonlyArray<DuckDbHistoricalSkillTaskReference>,
    DuckDbAnalyticalStoreFailure
  >;
  readonly queryHistoricalMetricRollups: (
    input: typeof DuckDbHistoricalMetricRollupQuery.Encoded,
  ) => Effect.Effect<DuckDbHistoricalMetricRollupPage, DuckDbAnalyticalStoreFailure>;
  readonly health: () => Effect.Effect<DuckDbAnalyticalStoreHealth, DuckDbAnalyticalStoreFailure>;
}

export class DuckDbAnalyticalStore extends Context.Service<
  DuckDbAnalyticalStore,
  DuckDbAnalyticalStoreService
>()("@selftune/observability/DuckDbAnalyticalStore") {}

const migrationLedgerStatement = `CREATE TABLE IF NOT EXISTS observability_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`;

const schemaStatements: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS observability_ingested_batches (
    batch_id VARCHAR PRIMARY KEY,
    schema_version VARCHAR NOT NULL,
    source_revision VARCHAR NOT NULL,
    normalizer_version VARCHAR NOT NULL,
    ingested_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS observability_spans (
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
    PRIMARY KEY (trace_id, span_id)
  )`,
  `CREATE TABLE IF NOT EXISTS observability_metrics (
    metric_id VARCHAR PRIMARY KEY,
    span_id VARCHAR NOT NULL,
    trace_id VARCHAR NOT NULL,
    metric_name VARCHAR NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR NOT NULL,
    batch_id VARCHAR
  )`,
  `CREATE TABLE IF NOT EXISTS observability_trace_skill_links (
    link_id VARCHAR PRIMARY KEY,
    span_id VARCHAR NOT NULL,
    trace_id VARCHAR NOT NULL,
    skill_invocation_id VARCHAR NOT NULL,
    skill_name VARCHAR NOT NULL,
    batch_id VARCHAR
  )`,
  "ALTER TABLE observability_ingested_batches ADD COLUMN IF NOT EXISTS source_revision VARCHAR",
  "ALTER TABLE observability_ingested_batches ADD COLUMN IF NOT EXISTS normalizer_version VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS batch_id VARCHAR",
  "ALTER TABLE observability_metrics ADD COLUMN IF NOT EXISTS batch_id VARCHAR",
  "ALTER TABLE observability_trace_skill_links ADD COLUMN IF NOT EXISTS batch_id VARCHAR",
  "CREATE INDEX IF NOT EXISTS observability_spans_trace_id ON observability_spans(trace_id)",
  "CREATE INDEX IF NOT EXISTS observability_metrics_trace_span_metric ON observability_metrics(trace_id, span_id, metric_name)",
  "CREATE INDEX IF NOT EXISTS observability_links_skill ON observability_trace_skill_links(skill_name)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (1)",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS resource_id VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS scope_id VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS parent_span_id VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS kind VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS status VARCHAR",
  `CREATE TABLE IF NOT EXISTS observability_resources (
    resource_id VARCHAR NOT NULL,
    service_name VARCHAR NOT NULL,
    service_version VARCHAR,
    schema_url VARCHAR,
    platform VARCHAR NOT NULL,
    batch_id VARCHAR NOT NULL,
    service_namespace VARCHAR,
    service_instance_id VARCHAR,
    deployment_environment VARCHAR,
    PRIMARY KEY (batch_id, resource_id)
  )`,
  `CREATE TABLE IF NOT EXISTS observability_instrumentation_scopes (
    scope_id VARCHAR NOT NULL,
    resource_id VARCHAR NOT NULL,
    scope_name VARCHAR NOT NULL,
    scope_version VARCHAR,
    schema_url VARCHAR,
    batch_id VARCHAR NOT NULL,
    PRIMARY KEY (batch_id, scope_id)
  )`,
  `CREATE TABLE IF NOT EXISTS observability_logs (
    log_id VARCHAR PRIMARY KEY,
    trace_id VARCHAR NOT NULL,
    span_id VARCHAR,
    resource_id VARCHAR,
    scope_id VARCHAR,
    event_name VARCHAR NOT NULL,
    observed_at TIMESTAMP NOT NULL,
    severity VARCHAR,
    batch_id VARCHAR NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observability_span_links (
    link_id VARCHAR PRIMARY KEY,
    trace_id VARCHAR NOT NULL,
    span_id VARCHAR NOT NULL,
    target_trace_id VARCHAR NOT NULL,
    target_span_id VARCHAR,
    link_kind VARCHAR,
    batch_id VARCHAR NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS observability_spans_parent ON observability_spans(trace_id, parent_span_id)",
  "CREATE INDEX IF NOT EXISTS observability_resources_id ON observability_resources(resource_id)",
  "CREATE INDEX IF NOT EXISTS observability_scopes_id ON observability_instrumentation_scopes(scope_id)",
  "CREATE INDEX IF NOT EXISTS observability_logs_trace ON observability_logs(trace_id, observed_at)",
  "CREATE INDEX IF NOT EXISTS observability_span_links_target ON observability_span_links(target_trace_id, target_span_id)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (2)",
  "ALTER TABLE observability_resources ADD COLUMN IF NOT EXISTS service_namespace VARCHAR",
  "ALTER TABLE observability_resources ADD COLUMN IF NOT EXISTS service_instance_id VARCHAR",
  "ALTER TABLE observability_resources ADD COLUMN IF NOT EXISTS deployment_environment VARCHAR",
  // v4 rebuilds observability_spans and intentionally omits this legacy column.
  // DuckDB cannot drop a column while *any* index on its table exists; v2 has
  // both trace and parent indexes, so doing the physical drop here prevents
  // the v2 -> v4 upgrade from ever reaching its transactional rebuild.
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (3)",
];

const v4MigrationStatements: ReadonlyArray<string> = [
  "BEGIN TRANSACTION",
  "DROP TABLE IF EXISTS observability_spans_v4",
  `CREATE TABLE observability_spans_v4 (
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
    PRIMARY KEY (trace_id, span_id)
  )`,
  `INSERT INTO observability_spans_v4
    SELECT trace_id, span_id, span_name, started_at, ended_at, duration_ms, platform, capture_mode,
      source_authority, trace_boundary, operation_name, source_id, provider, model, batch_id,
      resource_id, scope_id, parent_span_id, kind, status
    FROM observability_spans`,
  "DROP TABLE observability_spans",
  "ALTER TABLE observability_spans_v4 RENAME TO observability_spans",
  "DROP TABLE IF EXISTS observability_metrics_v4",
  `CREATE TABLE observability_metrics_v4 (
    metric_id VARCHAR PRIMARY KEY,
    span_id VARCHAR NOT NULL,
    trace_id VARCHAR NOT NULL,
    metric_name VARCHAR NOT NULL,
    value BIGINT NOT NULL,
    unit VARCHAR NOT NULL,
    batch_id VARCHAR
  )`,
  `INSERT INTO observability_metrics_v4
    SELECT trace_id || ':' || span_id || ':' || metric_name, span_id, trace_id, metric_name, value, unit, batch_id
    FROM observability_metrics`,
  "DROP TABLE observability_metrics",
  "ALTER TABLE observability_metrics_v4 RENAME TO observability_metrics",
  "CREATE INDEX IF NOT EXISTS observability_spans_trace_id ON observability_spans(trace_id)",
  "CREATE INDEX IF NOT EXISTS observability_spans_parent ON observability_spans(trace_id, parent_span_id)",
  "CREATE INDEX IF NOT EXISTS observability_metrics_trace_span_metric ON observability_metrics(trace_id, span_id, metric_name)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (4)",
  "COMMIT",
];

/** v5 is deliberately add-only: retain the existing corpus without a rebuild. */
const v5MigrationStatements: ReadonlyArray<string> = [
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS conversation_id VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS tool_name VARCHAR",
  "CREATE INDEX IF NOT EXISTS observability_spans_conversation ON observability_spans(conversation_id)",
  "CREATE INDEX IF NOT EXISTS observability_spans_tool_name ON observability_spans(tool_name)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (5)",
];

/** v6 retains historical cumulative observations as points; it never reuses span metrics. */
const v6MigrationStatements: ReadonlyArray<string> = [
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS evidence_quality VARCHAR",
  "ALTER TABLE observability_spans ADD COLUMN IF NOT EXISTS source_reference VARCHAR",
  "ALTER TABLE observability_logs ADD COLUMN IF NOT EXISTS evidence_quality VARCHAR",
  "ALTER TABLE observability_logs ADD COLUMN IF NOT EXISTS source_reference VARCHAR",
  `CREATE TABLE IF NOT EXISTS observability_historical_metric_points (
    metric_id VARCHAR PRIMARY KEY,
    trace_id VARCHAR NOT NULL,
    span_id VARCHAR,
    log_id VARCHAR,
    observed_at TIMESTAMP NOT NULL,
    metric_name VARCHAR NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR NOT NULL,
    temporality VARCHAR NOT NULL,
    evidence_quality VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    source_kind VARCHAR NOT NULL,
    source_reference VARCHAR NOT NULL,
    batch_id VARCHAR NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observability_historical_log_skill_links (
    link_id VARCHAR PRIMARY KEY,
    trace_id VARCHAR NOT NULL,
    log_id VARCHAR NOT NULL,
    skill_invocation_id VARCHAR NOT NULL,
    skill_name VARCHAR NOT NULL,
    batch_id VARCHAR NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS observability_historical_metric_points_cursor ON observability_historical_metric_points(observed_at, source_id, metric_id)",
  "CREATE INDEX IF NOT EXISTS observability_historical_log_skill_links_log ON observability_historical_log_skill_links(log_id)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (6)",
];

/** v7 preserves canonical point-record IDs on metadata-only log rows. */
const v7MigrationStatements: ReadonlyArray<string> = [
  "ALTER TABLE observability_logs ADD COLUMN IF NOT EXISTS source_id VARCHAR",
  "CREATE INDEX IF NOT EXISTS observability_logs_source_id ON observability_logs(source_id)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (7)",
];

/**
 * v8 materializes the newest cumulative snapshot for each trace/metric pair.
 * Raw points remain the audit source; this table makes reader keyset pages
 * proportional to the requested page, rather than the full historical corpus.
 */
const v8MigrationStatements: ReadonlyArray<string> = [
  "DROP INDEX IF EXISTS observability_historical_metric_points_latest",
  "DROP INDEX IF EXISTS observability_historical_metric_points_batch",
  `CREATE TABLE IF NOT EXISTS observability_historical_metric_rollups (
    trace_id VARCHAR NOT NULL,
    metric_name VARCHAR NOT NULL,
    metric_id VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    observed_at TIMESTAMP NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR NOT NULL,
    temporality VARCHAR NOT NULL,
    evidence_quality VARCHAR NOT NULL,
    source_reference VARCHAR NOT NULL,
    PRIMARY KEY (trace_id, metric_name)
  )`,
  `INSERT INTO observability_historical_metric_rollups (
    trace_id, metric_name, metric_id, source_id, observed_at, value, unit,
    temporality, evidence_quality, source_reference
  )
  SELECT trace_id, metric_name, metric_id, source_id, observed_at, value, unit,
    temporality, evidence_quality, source_reference
  FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY trace_id, metric_name
      ORDER BY observed_at DESC, metric_id DESC
    ) AS point_rank
    FROM observability_historical_metric_points
  ) AS latest
  WHERE point_rank = 1
  ON CONFLICT (trace_id, metric_name) DO UPDATE SET
    metric_id = excluded.metric_id,
    source_id = excluded.source_id,
    observed_at = excluded.observed_at,
    value = excluded.value,
    unit = excluded.unit,
    temporality = excluded.temporality,
    evidence_quality = excluded.evidence_quality,
    source_reference = excluded.source_reference
  WHERE excluded.observed_at > observability_historical_metric_rollups.observed_at
    OR (
      excluded.observed_at = observability_historical_metric_rollups.observed_at
      AND excluded.metric_id > observability_historical_metric_rollups.metric_id
    )`,
  "CREATE INDEX IF NOT EXISTS observability_historical_metric_rollups_cursor ON observability_historical_metric_rollups(trace_id, metric_name)",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (8)",
];

/**
 * v9 removes obsolete high-cardinality raw-point indexes and uses a bounded
 * transaction-local staging relation for normal incremental rollup updates.
 */
const v9MigrationStatements: ReadonlyArray<string> = [
  "DROP INDEX IF EXISTS observability_historical_metric_points_latest",
  "DROP INDEX IF EXISTS observability_historical_metric_points_batch",
  `CREATE TABLE IF NOT EXISTS observability_historical_metric_rollup_staging (
    trace_id VARCHAR NOT NULL,
    metric_name VARCHAR NOT NULL,
    metric_id VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    observed_at TIMESTAMP NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR NOT NULL,
    temporality VARCHAR NOT NULL,
    evidence_quality VARCHAR NOT NULL,
    source_reference VARCHAR NOT NULL,
    PRIMARY KEY (trace_id, metric_name)
  )`,
  "DELETE FROM observability_historical_metric_rollup_staging",
  "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (9)",
];

const metricColumns: ReadonlyArray<DerivedMetricName> = [
  "input_tokens",
  "output_tokens",
  "error_count",
  "tool_call_count",
];
const derivedMetricCount = metricColumns.length + 1;

const batchFactCounts = (batch: DuckDbAnalyticalBatch) => ({
  resources_received: batch.resources?.length ?? 0,
  scopes_received: batch.instrumentation_scopes?.length ?? 0,
  logs_received: batch.logs?.length ?? 0,
  metric_points_received: batch.metric_points?.length ?? 0,
  log_skill_links_received: batch.log_skill_links?.length ?? 0,
  span_links_received: batch.span_links?.length ?? 0,
});

/** Reduces one already-bounded batch without consulting the historical raw-point table. */
const latestMetricPointsInBatch = (
  points: ReadonlyArray<DuckDbHistoricalMetricPoint>,
): ReadonlyArray<DuckDbHistoricalMetricPoint> => {
  const latestByTrace = new Map<string, Map<string, DuckDbHistoricalMetricPoint>>();
  for (const point of points) {
    const byMetric = latestByTrace.get(point.trace_id) ?? new Map();
    const current = byMetric.get(point.name);
    const pointObservedAt = Date.parse(point.observed_at);
    const currentObservedAt = current === undefined ? undefined : Date.parse(current.observed_at);
    if (
      current === undefined ||
      (currentObservedAt !== undefined &&
        (pointObservedAt > currentObservedAt ||
          (pointObservedAt === currentObservedAt && point.metric_id > current.metric_id)))
    ) {
      byMetric.set(point.name, point);
    }
    latestByTrace.set(point.trace_id, byMetric);
  }
  return [...latestByTrace.values()].flatMap((byMetric) => [...byMetric.values()]);
};

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const isValidTimestamp = (value: string) =>
  isoTimestamp.test(value) && Number.isFinite(Date.parse(value));

const timestamp = (value: string): DuckDbTimestamp => {
  const fractionalSeconds = value.match(/\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/)?.at(1) ?? "0";
  const fractionalMicros = BigInt(fractionalSeconds.padEnd(6, "0"));
  return {
    _tag: "DuckDbTimestamp",
    micros: BigInt(Date.parse(value)) * 1_000n + (fractionalMicros % 1_000n),
  };
};

const spanKey = (traceId: string, spanId: string) => `${traceId}:${spanId}`;

const validateBatchTimestamps = Effect.fn("DuckDbAnalyticalStore.validateBatchTimestamps")(
  function* (batch: DuckDbAnalyticalBatch) {
    const resources = new Set<string>();
    const scopes = new Set<string>();
    const spans = new Map<string, DuckDbTraceSpan>();
    const logs = new Map<string, DuckDbTraceLogRecord>();
    const metricPoints = new Set<string>();
    const logSkillLinks = new Set<string>();
    const spanLinks = new Set<string>();
    for (const resource of batch.resources ?? []) {
      if (resources.has(resource.resource_id)) {
        return yield* invalidTopology(
          `Resource ${resource.resource_id} appears more than once in the batch.`,
        );
      }
      resources.add(resource.resource_id);
    }
    for (const scope of batch.instrumentation_scopes ?? []) {
      if (scopes.has(scope.scope_id)) {
        return yield* invalidTopology(
          `Instrumentation scope ${scope.scope_id} appears more than once in the batch.`,
        );
      }
      if (!resources.has(scope.resource_id)) {
        return yield* invalidTopology(
          `Instrumentation scope ${scope.scope_id} references missing resource ${scope.resource_id}.`,
        );
      }
      scopes.add(scope.scope_id);
    }
    for (const span of batch.spans) {
      const startedAt = Date.parse(span.started_at);
      const endedAt = Date.parse(span.ended_at);
      if (
        !isValidTimestamp(span.started_at) ||
        !isValidTimestamp(span.ended_at) ||
        endedAt < startedAt
      ) {
        return yield* invalidTopology(
          `Span ${span.span_id} must have parseable ordered ISO timestamps.`,
        );
      }
      if (spans.has(spanKey(span.trace_id, span.span_id))) {
        return yield* invalidTopology(
          `Span ${span.span_id} appears more than once in trace ${span.trace_id}.`,
        );
      }
      if (span.resource_id !== undefined && !resources.has(span.resource_id)) {
        return yield* invalidTopology(
          `Span ${span.span_id} references missing resource ${span.resource_id}.`,
        );
      }
      if (span.scope_id !== undefined && !scopes.has(span.scope_id)) {
        return yield* invalidTopology(
          `Span ${span.span_id} references missing scope ${span.scope_id}.`,
        );
      }
      spans.set(spanKey(span.trace_id, span.span_id), span);
    }
    for (const span of batch.spans) {
      if (span.parent_span_id === undefined) continue;
      const parent = spans.get(spanKey(span.trace_id, span.parent_span_id));
      if (parent === undefined) continue; // Late parent evidence is intentionally retained unresolved.
      if (parent.trace_id !== span.trace_id) {
        return yield* invalidTopology(
          `Span ${span.span_id} parent ${parent.span_id} belongs to another trace.`,
        );
      }
      if (
        Date.parse(parent.started_at) > Date.parse(span.started_at) ||
        Date.parse(parent.ended_at) < Date.parse(span.ended_at)
      ) {
        return yield* invalidTopology(
          `Span ${span.span_id} must be temporally nested by parent ${parent.span_id}.`,
        );
      }
    }
    for (const log of batch.logs ?? []) {
      if (logs.has(log.log_id))
        return yield* invalidTopology(`Log ${log.log_id} appears more than once in the batch.`);
      logs.set(log.log_id, log);
      if (!isValidTimestamp(log.timestamp))
        return yield* invalidTopology(`Log ${log.log_id} must have a parseable ISO timestamp.`);
      if (log.resource_id !== undefined && !resources.has(log.resource_id))
        return yield* invalidTopology(
          `Log ${log.log_id} references missing resource ${log.resource_id}.`,
        );
      if (log.scope_id !== undefined && !scopes.has(log.scope_id))
        return yield* invalidTopology(
          `Log ${log.log_id} references missing scope ${log.scope_id}.`,
        );
      if (log.span_id !== undefined) {
        const span = spans.get(spanKey(log.trace_id, log.span_id));
        if (span !== undefined && span.trace_id !== log.trace_id)
          return yield* invalidTopology(`Log ${log.log_id} must reference a span in its trace.`);
        if (span !== undefined) {
          const observedAt = Date.parse(log.timestamp);
          if (observedAt < Date.parse(span.started_at) || observedAt > Date.parse(span.ended_at))
            return yield* invalidTopology(
              `Log ${log.log_id} timestamp must fall within span ${span.span_id}.`,
            );
        }
      }
    }
    for (const link of batch.span_links ?? []) {
      if (spanLinks.has(link.link_id))
        return yield* invalidTopology(
          `Span link ${link.link_id} appears more than once in the batch.`,
        );
      spanLinks.add(link.link_id);
      const source = spans.get(spanKey(link.trace_id, link.span_id));
      if (source === undefined || source.trace_id !== link.trace_id)
        return yield* invalidTopology(
          `Span link ${link.link_id} must reference a source span in its trace.`,
        );
    }
    for (const point of batch.metric_points ?? []) {
      if (metricPoints.has(point.metric_id))
        return yield* invalidTopology(
          `Historical metric point ${point.metric_id} appears more than once in the batch.`,
        );
      metricPoints.add(point.metric_id);
      if (!isValidTimestamp(point.observed_at))
        return yield* invalidTopology(
          `Historical metric point ${point.metric_id} must have a parseable ISO timestamp.`,
        );
      if (point.log_id !== undefined) {
        const log = logs.get(point.log_id);
        if (log === undefined || log.trace_id !== point.trace_id)
          return yield* invalidTopology(
            `Historical metric point ${point.metric_id} must reference a log in its trace.`,
          );
      }
      if (point.span_id !== undefined) {
        const span = spans.get(spanKey(point.trace_id, point.span_id));
        if (span === undefined || span.trace_id !== point.trace_id)
          return yield* invalidTopology(
            `Historical metric point ${point.metric_id} must reference a span in its trace.`,
          );
      }
    }
    for (const link of batch.log_skill_links ?? []) {
      if (logSkillLinks.has(link.link_id))
        return yield* invalidTopology(
          `Historical log skill link ${link.link_id} appears more than once in the batch.`,
        );
      logSkillLinks.add(link.link_id);
      const log = logs.get(link.log_id);
      if (log === undefined || log.trace_id !== link.trace_id)
        return yield* invalidTopology(
          `Historical log skill link ${link.link_id} must reference a log in its trace.`,
        );
    }
    return batch;
  },
);

const invalidTopology = (message: string) =>
  Effect.fail(
    DuckDbAnalyticalStoreFailure.make({
      operation: "validate analytical trace topology",
      message,
    }),
  );

const runStatement = (connection: DuckDbConnection, sql: string, parameters?: DuckDbParameters) =>
  Effect.tryPromise({
    try: () => connection.run(sql, parameters),
    catch: (cause) =>
      DuckDbAnalyticalStoreFailure.make({
        operation: "run DuckDB statement",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const appendRows = (connection: DuckDbConnection, table: string, rows: ReadonlyArray<DuckDbRow>) =>
  Effect.tryPromise({
    try: () => connection.appendRows(table, rows),
    catch: (cause) =>
      DuckDbAnalyticalStoreFailure.make({
        operation: `append ${table} rows`,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const migrate = Effect.fn("DuckDbAnalyticalStore.migrate")(function* (
  connection: DuckDbConnection,
) {
  yield* runStatement(connection, migrationLedgerStatement);
  const versionResult = yield* runStatement(
    connection,
    "SELECT MAX(version) AS version FROM observability_schema_migrations",
  );
  const versionRows = yield* readRows(versionResult, "read DuckDB schema migration version");
  const existingVersion = versionRows.at(0)?.version;
  const migrationVersion = Schema.is(Schema.Union([Schema.Number, Schema.BigInt]))(existingVersion)
    ? Number(existingVersion)
    : 0;
  if (migrationVersion > 9) {
    return yield* Effect.fail(
      DuckDbAnalyticalStoreFailure.make({
        operation: "migrate DuckDB analytical store",
        message: `DuckDB schema version ${migrationVersion} is newer than supported version 9.`,
      }),
    );
  }
  if (migrationVersion >= 9) return;
  const hadMigration = migrationVersion > 0;
  for (const statement of schemaStatements) yield* runStatement(connection, statement);
  if (!hadMigration) {
    // The fresh schema already has v4's primary-key shape; record it without rebuilding.
    yield* runStatement(
      connection,
      "INSERT OR IGNORE INTO observability_schema_migrations (version) VALUES (4)",
    );
    for (const statement of v5MigrationStatements) yield* runStatement(connection, statement);
    for (const statement of v6MigrationStatements) yield* runStatement(connection, statement);
    for (const statement of v7MigrationStatements) yield* runStatement(connection, statement);
    for (const statement of v8MigrationStatements) yield* runStatement(connection, statement);
    for (const statement of v9MigrationStatements) yield* runStatement(connection, statement);
    return;
  }
  if (migrationVersion < 4) {
    yield* Effect.gen(function* () {
      for (const statement of v4MigrationStatements) yield* runStatement(connection, statement);
    }).pipe(Effect.onError(() => runStatement(connection, "ROLLBACK").pipe(Effect.ignore)));
  }
  for (const statement of v5MigrationStatements) yield* runStatement(connection, statement);
  for (const statement of v6MigrationStatements) yield* runStatement(connection, statement);
  for (const statement of v7MigrationStatements) yield* runStatement(connection, statement);
  for (const statement of v8MigrationStatements) yield* runStatement(connection, statement);
  for (const statement of v9MigrationStatements) yield* runStatement(connection, statement);
});

const decodeBatch = (input: typeof DuckDbAnalyticalBatch.Encoded) =>
  Schema.decodeUnknownEffect(DuckDbAnalyticalBatch)(input).pipe(
    Effect.flatMap(validateBatchTimestamps),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode analytical trace batch",
          message: error.message,
        }),
      ),
    ),
  );

const readRows = (result: DuckDbQueryResult, operation: string) =>
  Effect.tryPromise({
    try: () => result.getRowObjects(),
    catch: (cause) =>
      DuckDbAnalyticalStoreFailure.make({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

class BatchRevisionRow extends Schema.Class<BatchRevisionRow>("BatchRevisionRow")({
  normalizer_version: Schema.NullOr(Schema.String),
  source_revision: Schema.NullOr(Schema.String),
}) {}

const batchDisposition = Effect.fn("DuckDbAnalyticalStore.batchDisposition")(function* (
  connection: DuckDbConnection,
  batch: DuckDbAnalyticalBatch,
) {
  const result = yield* runStatement(
    connection,
    `SELECT source_revision, normalizer_version
     FROM observability_ingested_batches
     WHERE batch_id = $batch_id`,
    { batch_id: batch.batch_id },
  );
  const rows = yield* readRows(result, "read analytical batch receipt");
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(BatchRevisionRow))(rows).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode analytical batch receipt",
          message: error.message,
        }),
      ),
    ),
  );
  const existing = decoded.at(0);
  if (existing === undefined) return "missing";
  return existing.source_revision === batch.source_revision &&
    existing.normalizer_version === batch.normalizer_version
    ? "exact"
    : "revised";
});

const hasExactBatchReceipt = Effect.fn("DuckDbAnalyticalStore.hasExactBatchReceipt")(function* (
  connection: DuckDbConnection,
  input: typeof DuckDbAnalyticalBatch.Encoded,
) {
  const batch = yield* decodeBatch(input);
  const result = yield* runStatement(
    connection,
    `SELECT 1 AS receipt_exists
     FROM observability_ingested_batches
     WHERE batch_id = $batch_id
       AND source_revision = $source_revision
       AND normalizer_version = $normalizer_version
     LIMIT 1`,
    {
      batch_id: batch.batch_id,
      source_revision: batch.source_revision,
      normalizer_version: batch.normalizer_version,
    },
  );
  const rows = yield* readRows(result, "verify analytical batch receipt");
  return rows.length > 0;
});

const ingestBatch = Effect.fn("DuckDbAnalyticalStore.ingest")(function* (
  connection: DuckDbConnection,
  input: typeof DuckDbAnalyticalBatch.Encoded,
) {
  const batch = yield* decodeBatch(input);
  yield* runStatement(connection, "BEGIN TRANSACTION");
  const rollback = () => runStatement(connection, "ROLLBACK").pipe(Effect.ignore);
  const outcome = yield* Effect.gen(function* () {
    const disposition = yield* batchDisposition(connection, batch);
    if (disposition === "exact") {
      yield* runStatement(connection, "COMMIT");
      return DuckDbAnalyticalIngestReceipt.make({
        batch_id: batch.batch_id,
        disposition: "duplicate",
        spans_received: batch.spans.length,
        metrics_derived: batch.spans.length * derivedMetricCount,
        links_received: batch.links.length,
        ...batchFactCounts(batch),
      });
    }

    if (disposition === "revised") {
      for (const table of [
        "observability_span_links",
        "observability_logs",
        "observability_historical_log_skill_links",
        "observability_historical_metric_points",
        "observability_instrumentation_scopes",
        "observability_resources",
      ]) {
        yield* runStatement(connection, `DELETE FROM ${table} WHERE batch_id = $batch_id`, {
          batch_id: batch.batch_id,
        });
      }
      yield* runStatement(
        connection,
        "DELETE FROM observability_metrics WHERE batch_id = $batch_id",
        { batch_id: batch.batch_id },
      );
      yield* runStatement(
        connection,
        "DELETE FROM observability_trace_skill_links WHERE batch_id = $batch_id",
        { batch_id: batch.batch_id },
      );
      yield* runStatement(
        connection,
        "DELETE FROM observability_spans WHERE batch_id = $batch_id",
        { batch_id: batch.batch_id },
      );
    }
    yield* runStatement(
      connection,
      `INSERT INTO observability_ingested_batches (
        batch_id, schema_version, source_revision, normalizer_version
      ) VALUES ($batch_id, $schema_version, $source_revision, $normalizer_version)
      ON CONFLICT(batch_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        source_revision = excluded.source_revision,
        normalizer_version = excluded.normalizer_version,
        ingested_at = now()`,
      {
        batch_id: batch.batch_id,
        schema_version: batch.schema_version,
        source_revision: batch.source_revision,
        normalizer_version: batch.normalizer_version,
      },
    );
    const spanRows: DuckDbRow[] = [];
    const metricRows: DuckDbRow[] = [];
    for (const span of batch.spans) {
      spanRows.push([
        span.trace_id,
        span.span_id,
        span.name,
        timestamp(span.started_at),
        timestamp(span.ended_at),
        Date.parse(span.ended_at) - Date.parse(span.started_at),
        span.platform,
        span.capture_mode,
        span.source_authority,
        span.trace_boundary,
        span.operation_name,
        span.source_id,
        span.provider ?? null,
        span.model ?? null,
        batch.batch_id,
        span.resource_id ?? null,
        span.scope_id ?? null,
        span.parent_span_id ?? null,
        span.kind ?? null,
        span.status ?? null,
        span.conversation_id ?? null,
        span.tool_name ?? null,
        span.evidence_quality ?? null,
        span.source_reference ?? null,
      ]);
      for (const metricName of metricColumns) {
        metricRows.push([
          `${span.trace_id}:${span.span_id}:${metricName}`,
          span.span_id,
          span.trace_id,
          metricName,
          span[metricName],
          "count",
          batch.batch_id,
        ]);
      }
    }
    yield* appendRows(connection, "observability_spans", spanRows);
    yield* appendRows(connection, "observability_metrics", metricRows);
    yield* runStatement(
      connection,
      `INSERT INTO observability_metrics (
        metric_id, span_id, trace_id, metric_name, value, unit, batch_id
      )
      SELECT trace_id || ':' || span_id || ':duration_ms', span_id, trace_id, 'duration_ms', duration_ms, 'ms', batch_id
      FROM observability_spans
      WHERE batch_id = $batch_id`,
      { batch_id: batch.batch_id },
    );
    const linkRows: DuckDbRow[] = batch.links.map((link) => [
      link.link_id,
      link.span_id,
      link.trace_id,
      link.skill_invocation_id,
      link.skill_name,
      batch.batch_id,
    ]);
    yield* appendRows(connection, "observability_trace_skill_links", linkRows);
    yield* appendRows(
      connection,
      "observability_resources",
      (batch.resources ?? []).map((resource) => [
        resource.resource_id,
        resource.service_name,
        resource.service_version ?? null,
        resource.schema_url ?? null,
        resource.platform,
        batch.batch_id,
        resource.service_namespace ?? null,
        resource.service_instance_id ?? null,
        resource.deployment_environment ?? null,
      ]),
    );
    yield* appendRows(
      connection,
      "observability_instrumentation_scopes",
      (batch.instrumentation_scopes ?? []).map((scope) => [
        scope.scope_id,
        scope.resource_id,
        scope.name,
        scope.version ?? null,
        scope.schema_url ?? null,
        batch.batch_id,
      ]),
    );
    yield* appendRows(
      connection,
      "observability_logs",
      (batch.logs ?? []).map((log) => [
        log.log_id,
        log.trace_id,
        log.span_id ?? null,
        log.resource_id ?? null,
        log.scope_id ?? null,
        log.event_name,
        timestamp(log.timestamp),
        log.severity ?? null,
        batch.batch_id,
        log.evidence_quality ?? null,
        log.source_reference ?? null,
        log.source_id ?? null,
      ]),
    );
    yield* appendRows(
      connection,
      "observability_historical_metric_points",
      (batch.metric_points ?? []).map((point) => [
        point.metric_id,
        point.trace_id,
        point.span_id ?? null,
        point.log_id ?? null,
        timestamp(point.observed_at),
        point.name,
        point.value,
        point.unit,
        point.temporality,
        point.evidence_quality,
        point.source_id,
        point.source_kind,
        point.source_reference,
        batch.batch_id,
      ]),
    );
    const latestPoints = latestMetricPointsInBatch(batch.metric_points ?? []);
    yield* runStatement(connection, "DELETE FROM observability_historical_metric_rollup_staging");
    yield* appendRows(
      connection,
      "observability_historical_metric_rollup_staging",
      latestPoints.map((point) => [
        point.trace_id,
        point.name,
        point.metric_id,
        point.source_id,
        timestamp(point.observed_at),
        point.value,
        point.unit,
        point.temporality,
        point.evidence_quality,
        point.source_reference,
      ]),
    );
    // The input schema bounds points at 256 and the reducer only removes rows,
    // so normal ingest never reads the unbounded raw-point corpus here.
    yield* runStatement(
      connection,
      `INSERT INTO observability_historical_metric_rollups (
        trace_id, metric_name, metric_id, source_id, observed_at, value, unit,
        temporality, evidence_quality, source_reference
      )
      SELECT trace_id, metric_name, metric_id, source_id, observed_at, value, unit,
        temporality, evidence_quality, source_reference
      FROM observability_historical_metric_rollup_staging
      ON CONFLICT (trace_id, metric_name) DO UPDATE SET
        metric_id = excluded.metric_id,
        source_id = excluded.source_id,
        observed_at = excluded.observed_at,
        value = excluded.value,
        unit = excluded.unit,
        temporality = excluded.temporality,
        evidence_quality = excluded.evidence_quality,
        source_reference = excluded.source_reference
      WHERE excluded.observed_at > observability_historical_metric_rollups.observed_at
        OR (
          excluded.observed_at = observability_historical_metric_rollups.observed_at
          AND excluded.metric_id > observability_historical_metric_rollups.metric_id
        )`,
    );
    if (disposition === "revised") {
      // A revision may remove the current newest point. Rebuild only on this
      // rare replacement path so an older surviving batch can become current.
      yield* runStatement(connection, "DELETE FROM observability_historical_metric_rollups");
      yield* runStatement(
        connection,
        `INSERT INTO observability_historical_metric_rollups (
          trace_id, metric_name, metric_id, source_id, observed_at, value, unit,
          temporality, evidence_quality, source_reference
        )
        SELECT trace_id, metric_name, metric_id, source_id, observed_at, value, unit,
          temporality, evidence_quality, source_reference
        FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY trace_id, metric_name
            ORDER BY observed_at DESC, metric_id DESC
          ) AS point_rank
          FROM observability_historical_metric_points
        ) AS latest
        WHERE point_rank = 1`,
      );
    }
    yield* runStatement(connection, "DELETE FROM observability_historical_metric_rollup_staging");
    yield* appendRows(
      connection,
      "observability_historical_log_skill_links",
      (batch.log_skill_links ?? []).map((link) => [
        link.link_id,
        link.trace_id,
        link.log_id,
        link.skill_invocation_id,
        link.skill_name,
        batch.batch_id,
      ]),
    );
    yield* appendRows(
      connection,
      "observability_span_links",
      (batch.span_links ?? []).map((link) => [
        link.link_id,
        link.trace_id,
        link.span_id,
        link.target_trace_id,
        link.target_span_id ?? null,
        link.kind ?? null,
        batch.batch_id,
      ]),
    );
    yield* runStatement(connection, "COMMIT");
    if (disposition === "revised") {
      // Revised batches delete and reinsert the same indexed identities. Persist that uncommon
      // replacement transaction immediately so a process crash cannot strand DuckDB's ART index
      // delete/reinsert sequence in the WAL; affected 1.4.x and 1.5.x builds cannot replay it.
      yield* runStatement(connection, "CHECKPOINT");
    }
    return DuckDbAnalyticalIngestReceipt.make({
      batch_id: batch.batch_id,
      disposition: "accepted",
      spans_received: batch.spans.length,
      metrics_derived: batch.spans.length * derivedMetricCount,
      links_received: batch.links.length,
      ...batchFactCounts(batch),
    });
  }).pipe(Effect.onError(rollback));
  return outcome;
});

class SkillSignalRow extends Schema.Class<SkillSignalRow>("SkillSignalRow")({
  skill_name: BoundedText,
  invocation_count: MetricCount,
  trace_count: MetricCount,
  error_trace_count: MetricCount,
  duration_ms: MetricCount,
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
}) {}

const querySkillSignals = Effect.fn("DuckDbAnalyticalStore.querySkillSignals")(function* (
  connection: DuckDbConnection,
) {
  const result = yield* runStatement(
    connection,
    `WITH linked_facts AS (
      SELECT DISTINCT link.skill_name, link.skill_invocation_id, link.trace_id, link.span_id
      FROM observability_trace_skill_links AS link
      INNER JOIN observability_spans AS span
        ON span.trace_id = link.trace_id AND span.span_id = link.span_id
    ), invocation_totals AS (
      SELECT
        skill_name,
        CAST(COUNT(DISTINCT skill_invocation_id) AS DOUBLE) AS invocation_count
      FROM linked_facts
      GROUP BY skill_name
    ), skill_spans AS (
      SELECT DISTINCT skill_name, trace_id, span_id
      FROM linked_facts
    ), metric_rollup AS (
      SELECT
        trace_id,
        span_id,
        MAX(CASE WHEN metric_name = 'input_tokens' THEN value ELSE 0 END) AS input_tokens,
        MAX(CASE WHEN metric_name = 'output_tokens' THEN value ELSE 0 END) AS output_tokens,
        MAX(CASE WHEN metric_name = 'error_count' THEN value ELSE 0 END) AS error_count,
        MAX(CASE WHEN metric_name = 'tool_call_count' THEN value ELSE 0 END) AS tool_call_count
      FROM observability_metrics
      WHERE metric_name IN ('input_tokens', 'output_tokens', 'error_count', 'tool_call_count')
      GROUP BY trace_id, span_id
    ), span_totals AS (
      SELECT
        link.skill_name,
        CAST(COUNT(DISTINCT link.trace_id) AS DOUBLE) AS trace_count,
        CAST(COUNT(DISTINCT CASE WHEN metric.error_count > 0 THEN link.trace_id END) AS DOUBLE) AS error_trace_count,
        CAST(COALESCE(SUM(span.duration_ms), 0) AS DOUBLE) AS duration_ms,
        CAST(COALESCE(SUM(metric.input_tokens), 0) AS DOUBLE) AS input_tokens,
        CAST(COALESCE(SUM(metric.output_tokens), 0) AS DOUBLE) AS output_tokens,
        CAST(COALESCE(SUM(metric.error_count), 0) AS DOUBLE) AS error_count,
        CAST(COALESCE(SUM(metric.tool_call_count), 0) AS DOUBLE) AS tool_call_count
      FROM skill_spans AS link
      INNER JOIN observability_spans AS span
        ON span.trace_id = link.trace_id AND span.span_id = link.span_id
      LEFT JOIN metric_rollup AS metric
        ON metric.trace_id = link.trace_id AND metric.span_id = link.span_id
      GROUP BY link.skill_name
    )
    SELECT
      invocation.skill_name,
      invocation.invocation_count,
      span.trace_count,
      span.error_trace_count,
      span.duration_ms,
      span.input_tokens,
      span.output_tokens,
      span.error_count,
      span.tool_call_count
    FROM invocation_totals AS invocation
    INNER JOIN span_totals AS span ON span.skill_name = invocation.skill_name
    ORDER BY invocation.skill_name`,
  );
  const rows = yield* readRows(result, "read DuckDB skill trace signals");
  return yield* Schema.decodeUnknownEffect(Schema.Array(SkillSignalRow))(rows).pipe(
    Effect.map((decoded) => decoded.map((row) => DuckDbSkillTraceSignals.make(row))),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode DuckDB skill trace signals",
          message: error.message,
        }),
      ),
    ),
  );
});

const queryEvidenceCohortCandidates = Effect.fn(
  "DuckDbAnalyticalStore.queryEvidenceCohortCandidates",
)(function* (connection: DuckDbConnection, input: typeof DuckDbEvidenceCohortQuery.Encoded) {
  const query = yield* Schema.decodeUnknownEffect(DuckDbEvidenceCohortQuery)(input).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode evidence cohort query",
          message: error.message,
        }),
      ),
    ),
  );
  const result = yield* runStatement(
    connection,
    `WITH metric_rollup AS (
      SELECT
        trace_id,
        span_id,
        MAX(CASE WHEN metric_name = 'input_tokens' THEN value ELSE 0 END) AS input_tokens,
        MAX(CASE WHEN metric_name = 'output_tokens' THEN value ELSE 0 END) AS output_tokens,
        MAX(CASE WHEN metric_name = 'error_count' THEN value ELSE 0 END) AS error_count,
        MAX(CASE WHEN metric_name = 'tool_call_count' THEN value ELSE 0 END) AS tool_call_count
      FROM observability_metrics
      WHERE metric_name IN ('input_tokens', 'output_tokens', 'error_count', 'tool_call_count')
      GROUP BY trace_id, span_id
    )
    SELECT DISTINCT
      span.trace_id,
      span.span_id,
      link.skill_invocation_id,
      span.source_id,
      batch.source_revision,
      span.model,
      CAST(span.duration_ms AS DOUBLE) AS duration_ms,
      CAST(COALESCE(metric.input_tokens, 0) AS DOUBLE) AS input_tokens,
      CAST(COALESCE(metric.output_tokens, 0) AS DOUBLE) AS output_tokens,
      CAST(COALESCE(metric.error_count, 0) AS DOUBLE) AS error_count,
      CAST(COALESCE(metric.tool_call_count, 0) AS DOUBLE) AS tool_call_count
    FROM observability_trace_skill_links AS link
    INNER JOIN observability_spans AS span
      ON span.trace_id = link.trace_id AND span.span_id = link.span_id
    INNER JOIN observability_ingested_batches AS batch ON batch.batch_id = span.batch_id
    LEFT JOIN metric_rollup AS metric
      ON metric.trace_id = span.trace_id AND metric.span_id = span.span_id
    WHERE LOWER(TRIM(link.skill_name)) = $skill_id
      AND span.trace_boundary IN ('actionable_turn', 'autonomous_task')
    ORDER BY span.trace_id, span.span_id, link.skill_invocation_id`,
    { skill_id: query.pattern.skill_id.trim().toLowerCase() },
  );
  const rows = yield* readRows(result, "read DuckDB evidence cohort candidates");
  return yield* Schema.decodeUnknownEffect(Schema.Array(EvidenceCohortCandidate))(rows).pipe(
    Effect.map((decoded) => decoded.map((candidate) => EvidenceCohortCandidate.make(candidate))),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode DuckDB evidence cohort candidates",
          message: error.message,
        }),
      ),
    ),
  );
});

const queryHistoricalSkillTaskReferences = Effect.fn(
  "DuckDbAnalyticalStore.queryHistoricalSkillTaskReferences",
)(function* (connection: DuckDbConnection, input: typeof DuckDbHistoricalSkillTaskQuery.Encoded) {
  const query = yield* Schema.decodeUnknownEffect(DuckDbHistoricalSkillTaskQuery)(input).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode historical skill task query",
          message: error.message,
        }),
      ),
    ),
  );
  const result = yield* runStatement(
    connection,
    `SELECT DISTINCT
      span.trace_id,
      span.span_id,
      link.skill_invocation_id,
      span.source_id,
      batch.source_revision,
      span.trace_boundary,
      span.capture_mode,
      span.source_authority,
      span.evidence_quality,
      span.model
    FROM observability_trace_skill_links AS link
    INNER JOIN observability_spans AS span
      ON span.trace_id = link.trace_id AND span.span_id = link.span_id
    INNER JOIN observability_ingested_batches AS batch ON batch.batch_id = span.batch_id
    WHERE LOWER(TRIM(link.skill_name)) = $skill_id
    ORDER BY span.trace_id, span.span_id, link.skill_invocation_id
    LIMIT $limit`,
    { skill_id: query.skill_id.trim().toLowerCase(), limit: query.limit },
  );
  const rows = (yield* readRows(result, "read DuckDB historical skill task references")).map(
    (row) => {
      const normalized = { ...row };
      if (normalized.evidence_quality === null) delete normalized.evidence_quality;
      if (normalized.model === null) delete normalized.model;
      return normalized;
    },
  );
  return yield* Schema.decodeUnknownEffect(Schema.Array(DuckDbHistoricalSkillTaskReference))(
    rows,
  ).pipe(
    Effect.map((decoded) =>
      decoded.map((reference) => DuckDbHistoricalSkillTaskReference.make(reference)),
    ),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode DuckDB historical skill task references",
          message: error.message,
        }),
      ),
    ),
  );
});

/** Latest source snapshot per trace/metric. Cumulative points are never summed. */
const queryHistoricalMetricRollups = Effect.fn(
  "DuckDbAnalyticalStore.queryHistoricalMetricRollups",
)(function* (
  connection: DuckDbConnection,
  input: typeof DuckDbHistoricalMetricRollupQuery.Encoded,
) {
  const query = yield* Schema.decodeUnknownEffect(DuckDbHistoricalMetricRollupQuery)(input).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode historical metric rollup query",
          message: error.message,
        }),
      ),
    ),
  );
  const result = yield* runStatement(
    connection,
    `SELECT trace_id, source_id, metric_name,
      strftime(observed_at, '%Y-%m-%dT%H:%M:%S.%fZ') AS observed_at, value, unit, temporality,
      evidence_quality, source_reference
    FROM observability_historical_metric_rollups
    WHERE (
        trace_id > $after_trace_id
        OR (trace_id = $after_trace_id AND metric_name > $after_metric_name)
      )
    ORDER BY trace_id, metric_name
    LIMIT $limit_plus_one`,
    {
      after_trace_id: query.after?.trace_id ?? "",
      after_metric_name: query.after?.metric_name ?? "",
      limit_plus_one: query.limit + 1,
    },
  );
  const rows = yield* readRows(result, "read DuckDB historical metric rollups");
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DuckDbHistoricalMetricRollup))(
    rows,
  ).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode DuckDB historical metric rollups",
          message: error.message,
        }),
      ),
    ),
  );
  const items = decoded.slice(0, query.limit);
  const last = items.at(-1);
  if (decoded.length > query.limit && last !== undefined) {
    return DuckDbHistoricalMetricRollupPage.make({
      items,
      next: { trace_id: last.trace_id, metric_name: last.metric_name },
    });
  }
  return DuckDbHistoricalMetricRollupPage.make({ items });
});

class HealthRow extends Schema.Class<HealthRow>("HealthRow")({
  span_count: MetricCount,
  metric_count: MetricCount,
  link_count: MetricCount,
  resource_count: MetricCount,
  scope_count: MetricCount,
  log_count: MetricCount,
  span_link_count: MetricCount,
  historical_metric_point_count: MetricCount,
  historical_log_skill_link_count: MetricCount,
}) {}

const health = Effect.fn("DuckDbAnalyticalStore.health")(function* (
  connection: DuckDbConnection,
  databasePath: string,
) {
  const result = yield* runStatement(
    connection,
    `SELECT
      CAST((SELECT COUNT(*) FROM observability_spans) AS DOUBLE) AS span_count,
      CAST((SELECT COUNT(*) FROM observability_metrics) AS DOUBLE) AS metric_count,
      CAST((SELECT COUNT(*) FROM observability_trace_skill_links) AS DOUBLE) AS link_count,
      CAST((SELECT COUNT(*) FROM observability_resources) AS DOUBLE) AS resource_count,
      CAST((SELECT COUNT(*) FROM observability_instrumentation_scopes) AS DOUBLE) AS scope_count,
      CAST((SELECT COUNT(*) FROM observability_logs) AS DOUBLE) AS log_count,
      CAST((SELECT COUNT(*) FROM observability_span_links) AS DOUBLE) AS span_link_count,
      CAST((SELECT COUNT(*) FROM observability_historical_metric_points) AS DOUBLE) AS historical_metric_point_count,
      CAST((SELECT COUNT(*) FROM observability_historical_log_skill_links) AS DOUBLE) AS historical_log_skill_link_count`,
  );
  const rows = yield* readRows(result, "read DuckDB analytical store health");
  const row = yield* Schema.decodeUnknownEffect(Schema.Array(HealthRow))(rows).pipe(
    Effect.flatMap((decoded) => {
      const first = decoded.at(0);
      return first === undefined
        ? Effect.fail(
            DuckDbAnalyticalStoreFailure.make({
              operation: "decode DuckDB analytical store health",
              message: "DuckDB health query returned no row.",
            }),
          )
        : Effect.succeed(first);
    }),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "decode DuckDB analytical store health",
          message: error.message,
        }),
      ),
    ),
  );
  return DuckDbAnalyticalStoreHealth.make({
    database_path: databasePath,
    schema_version: 9,
    ...row,
  });
});

/**
 * Builds a scoped single-writer analytical store. The local host owns this
 * layer; hooks never open DuckDB directly and continue writing their durable
 * source records through the existing operational path.
 */
export function makeDuckDbAnalyticalStoreLive(
  factory: DuckDbInstanceFactory,
  databasePath: string = SELFTUNE_LOCAL_ANALYTICS_PATH,
) {
  const release = ({
    connection,
    instance,
  }: {
    connection: DuckDbConnection;
    instance: DuckDbInstance;
  }) =>
    Effect.sync(() => {
      try {
        connection.closeSync();
      } catch {
        // Resource finalization cannot supersede the completed program.
      }
      try {
        instance.closeSync();
      } catch {
        // Resource finalization cannot supersede the completed program.
      }
    });

  const openAndConnect = Effect.tryPromise({
    try: async () => {
      const instance = await factory.open(databasePath);
      try {
        const connection = await instance.connect();
        return { connection, instance };
      } catch (cause) {
        try {
          instance.closeSync();
        } catch {
          // Preserve the connection failure when partial acquisition cleanup fails.
        }
        throw cause;
      }
    },
    catch: (cause) =>
      DuckDbAnalyticalStoreFailure.make({
        operation: "open DuckDB analytical store",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  return Layer.effect(DuckDbAnalyticalStore)(
    Effect.acquireRelease(
      openAndConnect.pipe(Effect.retry({ times: 20, schedule: Schedule.spaced("100 millis") })),
      release,
    ).pipe(
      Effect.tap(({ connection }) => migrate(connection)),
      Effect.flatMap(({ connection }) =>
        Semaphore.make(1).pipe(
          Effect.map((semaphore) =>
            DuckDbAnalyticalStore.of({
              hasExactBatchReceipt: (input) =>
                semaphore.withPermit(hasExactBatchReceipt(connection, input)),
              ingest: (input) => semaphore.withPermit(ingestBatch(connection, input)),
              querySkillSignals: () => semaphore.withPermit(querySkillSignals(connection)),
              queryEvidenceCohortCandidates: (input) =>
                semaphore.withPermit(queryEvidenceCohortCandidates(connection, input)),
              queryHistoricalSkillTaskReferences: (input) =>
                semaphore.withPermit(queryHistoricalSkillTaskReferences(connection, input)),
              queryHistoricalMetricRollups: (input) =>
                semaphore.withPermit(queryHistoricalMetricRollups(connection, input)),
              health: () => semaphore.withPermit(health(connection, databasePath)),
            }),
          ),
        ),
      ),
    ),
  );
}
