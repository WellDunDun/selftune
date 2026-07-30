import * as Schema from "effect/Schema";

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
const NonEmptyBoundedString = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const ProvenanceReference = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Timestamp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const MetricCount = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const MetricValue = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

const LocalPlatform = Schema.Literals([
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
/** How directly a retained fact represents the original local source. */
export const EvidenceQuality = Schema.Literals(["source_exact", "inferred", "metadata_only"]);

/** Bounded resource dimensions; arbitrary OTel attributes are intentionally not retained. */
export class LocalTelemetryResource extends Schema.Class<LocalTelemetryResource>(
  "LocalTelemetryResource",
)({
  resource_id: NonEmptyBoundedString,
  service_name: NonEmptyBoundedString,
  service_namespace: Schema.optionalKey(NonEmptyBoundedString),
  service_version: Schema.optionalKey(NonEmptyBoundedString),
  service_instance_id: Schema.optionalKey(NonEmptyBoundedString),
  deployment_environment: Schema.optionalKey(NonEmptyBoundedString),
  schema_url: Schema.optionalKey(NonEmptyBoundedString),
  platform: LocalPlatform,
}) {}

/** Bounded instrumentation identity for topology-preserving OTLP normalization. */
export class LocalTelemetryInstrumentationScope extends Schema.Class<LocalTelemetryInstrumentationScope>(
  "LocalTelemetryInstrumentationScope",
)({
  scope_id: NonEmptyBoundedString,
  resource_id: NonEmptyBoundedString,
  name: NonEmptyBoundedString,
  version: Schema.optionalKey(NonEmptyBoundedString),
  schema_url: Schema.optionalKey(NonEmptyBoundedString),
}) {}

/** Normalized, source-truth trace facts before the analytical import boundary. */
export class LocalTelemetrySpan extends Schema.Class<LocalTelemetrySpan>("LocalTelemetrySpan")({
  trace_id: TraceId,
  span_id: SpanId,
  name: NonEmptyBoundedString,
  started_at: Timestamp,
  ended_at: Timestamp,
  platform: LocalPlatform,
  capture_mode: CaptureMode,
  source_authority: SourceAuthority,
  trace_boundary: TraceBoundary,
  operation_name: NonEmptyBoundedString,
  source_id: NonEmptyBoundedString,
  resource_id: Schema.optionalKey(NonEmptyBoundedString),
  scope_id: Schema.optionalKey(NonEmptyBoundedString),
  parent_span_id: Schema.optionalKey(SpanId),
  kind: Schema.optionalKey(SpanKind),
  status: Schema.optionalKey(SpanStatus),
  provider: Schema.optionalKey(NonEmptyBoundedString),
  model: Schema.optionalKey(NonEmptyBoundedString),
  /** Source-native conversation identity; never synthesized from content or trace IDs. */
  conversation_id: Schema.optionalKey(NonEmptyBoundedString),
  /** Stable tool identity only; tool arguments and results remain excluded. */
  tool_name: Schema.optionalKey(NonEmptyBoundedString),
  /** Explicitly distinguishes source timing from a session-level inference. */
  evidence_quality: Schema.optionalKey(EvidenceQuality),
  /** Metadata-only local source locator; prompt, output, and tool bodies are forbidden. */
  source_reference: Schema.optionalKey(ProvenanceReference),
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
}) {}

/** Point-in-time metadata-only evidence correlated to a trace, never a raw log body. */
export class LocalTelemetryLogRecord extends Schema.Class<LocalTelemetryLogRecord>(
  "LocalTelemetryLogRecord",
)({
  log_id: LogId,
  trace_id: TraceId,
  /** Stable canonical record identity; never derived from a content body. */
  source_id: Schema.optionalKey(NonEmptyBoundedString),
  timestamp: Timestamp,
  event_name: NonEmptyBoundedString,
  span_id: Schema.optionalKey(SpanId),
  resource_id: Schema.optionalKey(NonEmptyBoundedString),
  scope_id: Schema.optionalKey(NonEmptyBoundedString),
  severity: Schema.optionalKey(
    Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]),
  ),
  evidence_quality: Schema.optionalKey(EvidenceQuality),
  source_reference: Schema.optionalKey(ProvenanceReference),
}) {}

/** A cumulative historical counter observed at a source timestamp, never an inferred delta. */
export class LocalTelemetryMetricPoint extends Schema.Class<LocalTelemetryMetricPoint>(
  "LocalTelemetryMetricPoint",
)({
  metric_id: LogId,
  trace_id: TraceId,
  source_kind: LocalPlatform,
  observed_at: Timestamp,
  name: NonEmptyBoundedString,
  value: MetricValue,
  unit: NonEmptyBoundedString,
  temporality: Schema.Literal("cumulative"),
  span_id: Schema.optionalKey(SpanId),
  log_id: Schema.optionalKey(LogId),
  evidence_quality: EvidenceQuality,
  source_id: NonEmptyBoundedString,
  source_reference: ProvenanceReference,
}) {}

/** Skill identity correlated to a point-in-time metadata log, without invented span timing. */
export class LocalTelemetryLogSkillLink extends Schema.Class<LocalTelemetryLogSkillLink>(
  "LocalTelemetryLogSkillLink",
)({
  link_id: LinkId,
  trace_id: TraceId,
  log_id: LogId,
  skill_invocation_id: NonEmptyBoundedString,
}) {}

/** General asynchronous causal link; targets may be unresolved and arrive later. */
export class LocalTelemetrySpanLink extends Schema.Class<LocalTelemetrySpanLink>(
  "LocalTelemetrySpanLink",
)({
  link_id: LinkId,
  trace_id: TraceId,
  span_id: SpanId,
  target_trace_id: TraceId,
  target_span_id: Schema.optionalKey(SpanId),
  kind: Schema.optionalKey(
    Schema.Literals(["replay_of", "evaluation_of", "repair_of", "evolution_of"]),
  ),
}) {}

export class LocalTelemetrySkillLink extends Schema.Class<LocalTelemetrySkillLink>(
  "LocalTelemetrySkillLink",
)({
  link_id: LinkId,
  span_id: SpanId,
  trace_id: TraceId,
  skill_invocation_id: NonEmptyBoundedString,
}) {}

export class LocalTelemetryBatch extends Schema.Class<LocalTelemetryBatch>("LocalTelemetryBatch")({
  schema_version: Schema.Literal("1.0.0"),
  semantic_convention_version: Schema.Literal("1.0.0"),
  batch_id: NonEmptyBoundedString,
  spans: Schema.Array(LocalTelemetrySpan).check(Schema.isMaxLength(256)),
  links: Schema.optionalKey(Schema.Array(LocalTelemetrySkillLink).check(Schema.isMaxLength(256))),
  resources: Schema.optionalKey(Schema.Array(LocalTelemetryResource).check(Schema.isMaxLength(64))),
  instrumentation_scopes: Schema.optionalKey(
    Schema.Array(LocalTelemetryInstrumentationScope).check(Schema.isMaxLength(64)),
  ),
  logs: Schema.optionalKey(Schema.Array(LocalTelemetryLogRecord).check(Schema.isMaxLength(256))),
  metric_points: Schema.optionalKey(
    Schema.Array(LocalTelemetryMetricPoint).check(Schema.isMaxLength(256)),
  ),
  log_skill_links: Schema.optionalKey(
    Schema.Array(LocalTelemetryLogSkillLink).check(Schema.isMaxLength(256)),
  ),
  span_links: Schema.optionalKey(
    Schema.Array(LocalTelemetrySpanLink).check(Schema.isMaxLength(256)),
  ),
}) {}
