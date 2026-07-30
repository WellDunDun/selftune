import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LocalTraceImportRequest } from "./local-trace-importer.js";
import {
  LocalTelemetryBatch,
  LocalTelemetryLogRecord,
  LocalTelemetryLogSkillLink,
  LocalTelemetryMetricPoint,
  LocalTelemetrySpan,
} from "./trace-batch.js";

const Text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Reference = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Timestamp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const Count = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const MetricValue = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const HistoricalPlatform = Schema.Literals(["claude_code", "codex", "opencode", "pi", "openclaw"]);
const CaptureMode = Schema.Literals([
  "hook",
  "replay",
  "transcript",
  "rollout",
  "session",
  "wrapper",
  "batch_ingest",
  "repair",
]);
const HistoricalSourceDomain = Schema.Literals([
  "sessions",
  "prompts",
  "skill_invocations",
  "execution_facts",
]);
const OutputLimit = 256;
const InputLimit = 256;

export const HISTORICAL_BACKFILL_NORMALIZER_VERSION = "historical-backfill@1.0.0";

export class HistoricalBackfillSession extends Schema.Class<HistoricalBackfillSession>(
  "HistoricalBackfillSession",
)({
  session_id: Text,
  platform: HistoricalPlatform,
  started_at: Schema.optionalKey(Timestamp),
  ended_at: Schema.optionalKey(Timestamp),
  capture_mode: Schema.optionalKey(CaptureMode),
  raw_source_ref: Schema.optionalKey(Reference),
}) {}

/** Prompt identity only. The source projection must never select prompt_text. */
export class HistoricalBackfillPrompt extends Schema.Class<HistoricalBackfillPrompt>(
  "HistoricalBackfillPrompt",
)({
  prompt_id: Text,
  session_id: Text,
  occurred_at: Schema.optionalKey(Timestamp),
  raw_source_ref: Schema.optionalKey(Reference),
}) {}

/** Invocation identity only. Query, path, and tool arguments/results are deliberately absent. */
export class HistoricalBackfillSkillInvocation extends Schema.Class<HistoricalBackfillSkillInvocation>(
  "HistoricalBackfillSkillInvocation",
)({
  skill_invocation_id: Text,
  session_id: Text,
  skill_name: Text,
  occurred_at: Schema.optionalKey(Timestamp),
  raw_source_ref: Schema.optionalKey(Reference),
}) {}

/** Cumulative source snapshot; values are never summed or converted into a timed span. */
export class HistoricalBackfillExecutionFact extends Schema.Class<HistoricalBackfillExecutionFact>(
  "HistoricalBackfillExecutionFact",
)({
  execution_fact_id: Schema.optionalKey(Text),
  id: Schema.optionalKey(Count),
  session_id: Text,
  occurred_at: Schema.optionalKey(Timestamp),
  duration_ms: Schema.optionalKey(Count),
  input_tokens: Schema.optionalKey(Count),
  output_tokens: Schema.optionalKey(Count),
  total_tool_calls: Schema.optionalKey(Count),
  errors_encountered: Schema.optionalKey(Count),
  assistant_turns: Schema.optionalKey(Count),
  files_changed: Schema.optionalKey(Count),
  lines_added: Schema.optionalKey(Count),
  lines_removed: Schema.optionalKey(Count),
  lines_modified: Schema.optionalKey(Count),
  cached_input_tokens: Schema.optionalKey(Count),
  reasoning_output_tokens: Schema.optionalKey(Count),
  cost_usd: Schema.optionalKey(MetricValue),
  artifact_count: Schema.optionalKey(Count),
  raw_source_ref: Schema.optionalKey(Reference),
}) {}

/** Content-free bounded page returned by the historical SQLite keyset reader. */
export class HistoricalBackfillInput extends Schema.Class<HistoricalBackfillInput>(
  "HistoricalBackfillInput",
)({
  source_cursor: Text,
  source_revision: Text,
  source_domain: HistoricalSourceDomain,
  include_session_spans: Schema.Boolean,
  sessions: Schema.Array(HistoricalBackfillSession).check(Schema.isMaxLength(InputLimit)),
  prompts: Schema.Array(HistoricalBackfillPrompt).check(Schema.isMaxLength(InputLimit)),
  skill_invocations: Schema.Array(HistoricalBackfillSkillInvocation).check(
    Schema.isMaxLength(InputLimit),
  ),
  execution_facts: Schema.Array(HistoricalBackfillExecutionFact).check(
    Schema.isMaxLength(InputLimit),
  ),
}) {}

export class HistoricalBackfillWithheld extends Schema.Class<HistoricalBackfillWithheld>(
  "HistoricalBackfillWithheld",
)({
  source_id: Text,
  reason: Schema.Literals(["unsupported_platform", "missing_timestamp", "missing_identity"]),
}) {}

export class HistoricalBackfillNormalizationResult extends Schema.Class<HistoricalBackfillNormalizationResult>(
  "HistoricalBackfillNormalizationResult",
)({
  imports: Schema.Array(LocalTraceImportRequest),
  withheld: Schema.Array(HistoricalBackfillWithheld),
}) {}

export class HistoricalBackfillNormalizationFailure extends Schema.TaggedErrorClass<HistoricalBackfillNormalizationFailure>()(
  "HistoricalBackfillNormalizationFailure",
  { operation: Schema.String, message: Schema.String },
) {}

type SupportedPlatform = "claude_code" | "codex" | "opencode" | "pi";
type HistoricalFact =
  | { readonly kind: "span"; readonly span: LocalTelemetrySpan }
  | {
      readonly kind: "metadata";
      readonly log: LocalTelemetryLogRecord;
      readonly metric_points: ReadonlyArray<LocalTelemetryMetricPoint>;
      readonly log_skill_link?: LocalTelemetryLogSkillLink;
    };

const platforms: ReadonlyArray<SupportedPlatform> = ["claude_code", "codex", "opencode", "pi"];

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
};
const hash = (domain: string, value: unknown) =>
  createHash("sha256").update(domain).update(canonicalJson(value)).digest("hex");
const traceId = (sessionId: string) => hash("historical-backfill:trace:v1", sessionId).slice(0, 32);
const id = (domain: string, sourceId: string, length: number) =>
  hash(domain, sourceId).slice(0, length);
const timestamp = (value: string | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
};
const supported = (
  platform: HistoricalBackfillSession["platform"],
): platform is SupportedPlatform => platform !== "openclaw";
const reference = (raw: string | undefined, sessionId: string) => raw ?? `session:${sessionId}`;
const factId = (fact: HistoricalBackfillExecutionFact): string | undefined =>
  fact.execution_fact_id ?? (fact.id === undefined ? undefined : `legacy-${fact.id}`);

const metricPoints = (
  fact: HistoricalBackfillExecutionFact,
  identity: string,
  trace: string,
  observedAt: string,
  platform: SupportedPlatform,
  log: LocalTelemetryLogRecord,
  sourceReference: string,
): ReadonlyArray<LocalTelemetryMetricPoint> => {
  const values: ReadonlyArray<readonly [string, number | undefined, string]> = [
    ["duration_ms", fact.duration_ms, "ms"],
    ["input_tokens", fact.input_tokens, "count"],
    ["output_tokens", fact.output_tokens, "count"],
    ["tool_call_count", fact.total_tool_calls, "count"],
    ["error_count", fact.errors_encountered, "count"],
    ["assistant_turns", fact.assistant_turns, "count"],
    ["files_changed", fact.files_changed, "count"],
    ["lines_added", fact.lines_added, "count"],
    ["lines_removed", fact.lines_removed, "count"],
    ["lines_modified", fact.lines_modified, "count"],
    ["cached_input_tokens", fact.cached_input_tokens, "count"],
    ["reasoning_output_tokens", fact.reasoning_output_tokens, "count"],
    ["cost_usd", fact.cost_usd, "usd"],
    ["artifact_count", fact.artifact_count, "count"],
  ];
  return values.flatMap(([name, value, unit]) =>
    value === undefined
      ? []
      : [
          LocalTelemetryMetricPoint.make({
            metric_id: id("historical-backfill:metric:v1", `${identity}:${name}`, 32),
            trace_id: trace,
            source_kind: platform,
            log_id: log.log_id,
            observed_at: observedAt,
            name,
            value,
            unit,
            temporality: "cumulative",
            evidence_quality: "source_exact",
            source_id: `execution_fact:${identity}`,
            source_reference: sourceReference,
          }),
        ],
  );
};

const newestFacts = (facts: ReadonlyArray<HistoricalBackfillExecutionFact>) =>
  [
    ...Map.groupBy(
      facts.filter((fact) => factId(fact) !== undefined),
      (fact) => factId(fact)!,
    ),
  ]
    .map(
      ([, duplicates]) =>
        duplicates
          .toSorted((left, right) =>
            (timestamp(left.occurred_at) ?? "").localeCompare(timestamp(right.occurred_at) ?? ""),
          )
          .at(-1)!,
    )
    .toSorted((left, right) => factId(left)!.localeCompare(factId(right)!));

const factsForSession = (
  session: HistoricalBackfillSession,
  prompts: ReadonlyArray<HistoricalBackfillPrompt>,
  invocations: ReadonlyArray<HistoricalBackfillSkillInvocation>,
  executions: ReadonlyArray<HistoricalBackfillExecutionFact>,
  withheld: HistoricalBackfillWithheld[],
  includeSessionSpans: boolean,
  sourceDomain: HistoricalBackfillInput["source_domain"],
): ReadonlyArray<HistoricalFact> => {
  if (!supported(session.platform)) return [];
  const trace = traceId(session.session_id);
  const facts: HistoricalFact[] = [];
  const startedAt = timestamp(session.started_at);
  const endedAt = timestamp(session.ended_at);
  if (
    includeSessionSpans &&
    sourceDomain === "sessions" &&
    startedAt !== undefined &&
    endedAt !== undefined &&
    Date.parse(endedAt) >= Date.parse(startedAt)
  ) {
    facts.push({
      kind: "span",
      span: LocalTelemetrySpan.make({
        trace_id: trace,
        span_id: id("historical-backfill:session-span:v1", session.session_id, 16),
        name: "historical session",
        started_at: startedAt,
        ended_at: endedAt,
        platform: session.platform,
        capture_mode: session.capture_mode ?? "session",
        source_authority: "source_truth",
        trace_boundary: "session",
        operation_name: "historical_session",
        source_id: `session:${session.session_id}`,
        evidence_quality: "source_exact",
        source_reference: reference(session.raw_source_ref, session.session_id),
        input_tokens: 0,
        output_tokens: 0,
        error_count: 0,
        tool_call_count: 0,
      }),
    });
  } else if (includeSessionSpans && sourceDomain === "sessions") {
    withheld.push(
      HistoricalBackfillWithheld.make({
        source_id: `session:${session.session_id}`,
        reason: "missing_timestamp",
      }),
    );
  }
  for (const prompt of prompts.toSorted((left, right) =>
    left.prompt_id.localeCompare(right.prompt_id),
  )) {
    const observedAt = timestamp(prompt.occurred_at);
    if (observedAt === undefined) {
      withheld.push(
        HistoricalBackfillWithheld.make({
          source_id: `prompt:${prompt.prompt_id}`,
          reason: "missing_timestamp",
        }),
      );
      continue;
    }
    facts.push({
      kind: "metadata",
      metric_points: [],
      log: LocalTelemetryLogRecord.make({
        log_id: id("historical-backfill:prompt-log:v1", prompt.prompt_id, 32),
        trace_id: trace,
        source_id: `prompt:${prompt.prompt_id}`,
        timestamp: observedAt,
        event_name: "historical.prompt_observed",
        severity: "INFO",
        evidence_quality: "metadata_only",
        source_reference: reference(prompt.raw_source_ref, session.session_id),
      }),
    });
  }
  for (const invocation of invocations.toSorted((left, right) =>
    left.skill_invocation_id.localeCompare(right.skill_invocation_id),
  )) {
    const observedAt = timestamp(invocation.occurred_at);
    if (observedAt === undefined) {
      withheld.push(
        HistoricalBackfillWithheld.make({
          source_id: `skill_invocation:${invocation.skill_invocation_id}`,
          reason: "missing_timestamp",
        }),
      );
      continue;
    }
    const log = LocalTelemetryLogRecord.make({
      log_id: id("historical-backfill:skill-log:v1", invocation.skill_invocation_id, 32),
      trace_id: trace,
      source_id: `skill_invocation:${invocation.skill_invocation_id}`,
      timestamp: observedAt,
      event_name: "historical.skill_invocation_observed",
      severity: "INFO",
      evidence_quality: "metadata_only",
      source_reference: reference(invocation.raw_source_ref, session.session_id),
    });
    facts.push({
      kind: "metadata",
      log,
      metric_points: [],
      log_skill_link: LocalTelemetryLogSkillLink.make({
        link_id: id("historical-backfill:log-skill-link:v1", invocation.skill_invocation_id, 32),
        trace_id: trace,
        log_id: log.log_id,
        skill_invocation_id: invocation.skill_invocation_id,
      }),
    });
  }
  for (const execution of executions) {
    const identity = factId(execution);
    if (identity === undefined) {
      withheld.push(
        HistoricalBackfillWithheld.make({
          source_id: `execution_fact:${execution.session_id}`,
          reason: "missing_identity",
        }),
      );
      continue;
    }
    const observedAt = timestamp(execution.occurred_at);
    if (observedAt === undefined) {
      withheld.push(
        HistoricalBackfillWithheld.make({
          source_id: `execution_fact:${identity}`,
          reason: "missing_timestamp",
        }),
      );
      continue;
    }
    const sourceReference = reference(execution.raw_source_ref, session.session_id);
    const log = LocalTelemetryLogRecord.make({
      log_id: id("historical-backfill:execution-log:v1", identity, 32),
      trace_id: trace,
      source_id: `execution_fact:${identity}`,
      timestamp: observedAt,
      event_name: "historical.execution_snapshot_observed",
      severity: "INFO",
      evidence_quality: "metadata_only",
      source_reference: sourceReference,
    });
    facts.push({
      kind: "metadata",
      log,
      metric_points: metricPoints(
        execution,
        identity,
        trace,
        observedAt,
        session.platform,
        log,
        sourceReference,
      ),
    });
  }
  return facts;
};

const chunk = (
  facts: ReadonlyArray<HistoricalFact>,
): ReadonlyArray<ReadonlyArray<HistoricalFact>> => {
  const chunks: HistoricalFact[][] = [];
  let current: HistoricalFact[] = [];
  let spans = 0;
  let logs = 0;
  let metrics = 0;
  let logSkillLinks = 0;
  for (const fact of facts) {
    const nextSpans = spans + (fact.kind === "span" ? 1 : 0);
    const nextLogs = logs + (fact.kind === "metadata" ? 1 : 0);
    const nextMetrics = metrics + (fact.kind === "metadata" ? fact.metric_points.length : 0);
    const nextLogSkillLinks =
      logSkillLinks + (fact.kind === "metadata" && fact.log_skill_link ? 1 : 0);
    if (
      current.length > 0 &&
      (nextSpans > OutputLimit ||
        nextLogs > OutputLimit ||
        nextMetrics > OutputLimit ||
        nextLogSkillLinks > OutputLimit)
    ) {
      chunks.push(current);
      current = [];
      spans = 0;
      logs = 0;
      metrics = 0;
      logSkillLinks = 0;
    }
    current.push(fact);
    spans += fact.kind === "span" ? 1 : 0;
    logs += fact.kind === "metadata" ? 1 : 0;
    metrics += fact.kind === "metadata" ? fact.metric_points.length : 0;
    logSkillLinks += fact.kind === "metadata" && fact.log_skill_link ? 1 : 0;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const normalize = (input: HistoricalBackfillInput): HistoricalBackfillNormalizationResult => {
  const prompts = Map.groupBy(input.prompts, (item) => item.session_id);
  const invocations = Map.groupBy(input.skill_invocations, (item) => item.session_id);
  const executions = Map.groupBy(input.execution_facts, (item) => item.session_id);
  const withheld: HistoricalBackfillWithheld[] = input.sessions
    .filter((session) => !supported(session.platform))
    .toSorted((left, right) => left.session_id.localeCompare(right.session_id))
    .map((session) =>
      HistoricalBackfillWithheld.make({
        source_id: `session:${session.session_id}`,
        reason: "unsupported_platform",
      }),
    );
  const imports: LocalTraceImportRequest[] = [];
  for (const platform of platforms) {
    const facts = input.sessions
      .filter((session) => session.platform === platform)
      .toSorted((left, right) => left.session_id.localeCompare(right.session_id))
      .flatMap((session) =>
        factsForSession(
          session,
          input.source_domain === "prompts" ? (prompts.get(session.session_id) ?? []) : [],
          input.source_domain === "skill_invocations"
            ? (invocations.get(session.session_id) ?? [])
            : [],
          input.source_domain === "execution_facts"
            ? newestFacts(executions.get(session.session_id) ?? [])
            : [],
          withheld,
          input.include_session_spans,
          input.source_domain,
        ),
      );
    for (const current of chunk(facts)) {
      const source_revision = hash("historical-backfill:source:v1", {
        source_cursor: input.source_cursor,
        source_revision: input.source_revision,
        platform,
        current,
      });
      imports.push(
        LocalTraceImportRequest.make({
          source_kind: platform,
          source_revision,
          normalizer_version: HISTORICAL_BACKFILL_NORMALIZER_VERSION,
          batch: LocalTelemetryBatch.make({
            schema_version: "1.0.0",
            semantic_convention_version: "1.0.0",
            batch_id: `historical-backfill:${source_revision}`,
            spans: current.flatMap((fact) => (fact.kind === "span" ? [fact.span] : [])),
            logs: current.flatMap((fact) => (fact.kind === "metadata" ? [fact.log] : [])),
            metric_points: current.flatMap((fact) =>
              fact.kind === "metadata" ? fact.metric_points : [],
            ),
            log_skill_links: current.flatMap((fact) =>
              fact.kind === "metadata" && fact.log_skill_link ? [fact.log_skill_link] : [],
            ),
          }),
        }),
      );
    }
  }
  return HistoricalBackfillNormalizationResult.make({
    imports,
    withheld: withheld.toSorted(
      (left, right) =>
        left.source_id.localeCompare(right.source_id) || left.reason.localeCompare(right.reason),
    ),
  });
};

/** Pure content-safe normalization. It makes no SQLite or DuckDB calls. */
export const normalizeHistoricalBackfill = Effect.fn("normalizeHistoricalBackfill")(function* (
  input: unknown,
) {
  const decoded = yield* Schema.decodeUnknownEffect(HistoricalBackfillInput)(input).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        HistoricalBackfillNormalizationFailure.make({
          operation: "decode historical backfill input",
          message: error.message,
        }),
      ),
    ),
  );
  return normalize(decoded);
});
