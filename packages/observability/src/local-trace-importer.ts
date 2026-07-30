import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LocalTelemetryBatch } from "./trace-batch.js";

const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const TraceId = Schema.String.check(
  Schema.isLengthBetween(32, 32),
  Schema.isPattern(/^[0-9a-f]{32}$/),
);
const MetricCount = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** Source identities supported by the local trace import pipeline. */
export const LocalTraceSourceKind = Schema.Literals([
  "claude_code",
  "codex",
  "opencode",
  "pi",
  "otlp",
]);

/**
 * A normalized source revision ready to be made durable in local analytics.
 * Schema and semantic-convention versions stay owned by the telemetry batch,
 * independently of any cloud-export protocol.
 */
export class LocalTraceImportRequest extends Schema.Class<LocalTraceImportRequest>(
  "LocalTraceImportRequest",
)({
  source_kind: LocalTraceSourceKind,
  source_revision: BoundedText,
  normalizer_version: BoundedText,
  batch: LocalTelemetryBatch,
}) {}

/** A deterministic analytical signal derived from one canonical skill invocation. */
export class LocalSkillFailureSignal extends Schema.Class<LocalSkillFailureSignal>(
  "LocalSkillFailureSignal",
)({
  signal_id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(96)),
  kind: Schema.Literal("skill_execution_error"),
  trace_id: TraceId,
  skill_invocation_id: BoundedText,
  skill_name: BoundedText,
  duration_ms: MetricCount,
  input_tokens: MetricCount,
  output_tokens: MetricCount,
  error_count: MetricCount,
  tool_call_count: MetricCount,
}) {}

export class LocalTraceImportResult extends Schema.Class<LocalTraceImportResult>(
  "LocalTraceImportResult",
)({
  skill_failure_signals: Schema.Array(LocalSkillFailureSignal),
}) {}

export class LocalTraceImportFailure extends Schema.TaggedErrorClass<LocalTraceImportFailure>()(
  "LocalTraceImportFailure",
  { operation: Schema.String, message: Schema.String },
) {}

export interface LocalTraceImporterService {
  readonly importTrace: (
    input: unknown,
  ) => Effect.Effect<LocalTraceImportResult, LocalTraceImportFailure>;
}

/** Harness-neutral boundary between canonical SQLite writes and DuckDB analytics. */
export class LocalTraceImporter extends Context.Service<
  LocalTraceImporter,
  LocalTraceImporterService
>()("@selftune/observability/LocalTraceImporter") {}
