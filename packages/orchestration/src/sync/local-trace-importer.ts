import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  acknowledgeAnalyticalImport,
  AnalyticalImportCheckpoint,
  getDrizzleDb,
  isAnalyticalImportCurrent,
} from "@selftune/local-store";
import { skill_invocations } from "@selftune/local-store/schema";
import {
  DuckDbAnalyticalBatch,
  DuckDbAnalyticalStore,
  DuckDbTraceInstrumentationScope,
  DuckDbHistoricalLogSkillLink,
  DuckDbHistoricalMetricPoint,
  DuckDbTraceLogRecord,
  DuckDbTraceResource,
  DuckDbTraceSpanLink,
  DuckDbTraceSkillLink,
  DuckDbTraceSpan,
} from "@selftune/observability/duckdb-store";
import {
  LocalSkillFailureSignal,
  LocalTraceImportFailure,
  LocalTraceImporter,
  LocalTraceImportRequest,
  LocalTraceImportResult,
} from "@selftune/observability/local-trace-importer";

const resolveSkillName = Effect.fn("LocalTraceImporter.resolveSkillName")(function* (
  database: Database,
  skillInvocationId: string,
) {
  const invocation = yield* Effect.try({
    try: () =>
      getDrizzleDb(database)
        .select({ skill_name: skill_invocations.skill_name })
        .from(skill_invocations)
        .where(eq(skill_invocations.skill_invocation_id, skillInvocationId))
        .get(),
    catch: (cause) =>
      LocalTraceImportFailure.make({
        operation: "resolve local trace skill invocation",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (invocation === undefined || !invocation.skill_name.trim()) {
    return yield* Effect.fail(
      LocalTraceImportFailure.make({
        operation: "resolve local trace skill invocation",
        message: `No canonical skill invocation exists for ${skillInvocationId}.`,
      }),
    );
  }
  return invocation.skill_name;
});

const signalId = (sourceKind: string, traceId: string, skillInvocationId: string) => {
  const digest = createHash("sha256")
    .update("selftune.local.skill-failure-signal.v1")
    .update("\u0000")
    .update(sourceKind)
    .update("\u0000")
    .update(traceId)
    .update("\u0000")
    .update(skillInvocationId)
    .digest("hex");
  return `skill-failure-${digest.slice(0, 32)}`;
};

const resolveBatch = Effect.fn("LocalTraceImporter.resolveBatch")(function* (
  database: Database,
  request: LocalTraceImportRequest,
) {
  const spansById = new Map<string, (typeof request.batch.spans)[number]>();
  for (const span of request.batch.spans) {
    if (request.source_kind !== "otlp" && span.platform !== request.source_kind) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate local trace source",
          message: `Trace span ${span.span_id} belongs to ${span.platform}, not ${request.source_kind}.`,
        }),
      );
    }
    if (spansById.has(span.span_id)) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate local trace span identity",
          message: `Trace span ${span.span_id} appears more than once in the batch.`,
        }),
      );
    }
    spansById.set(span.span_id, span);
  }

  const logsById = new Map<string, { readonly log_id: string; readonly trace_id: string }>();
  for (const log of request.batch.logs ?? []) {
    if (logsById.has(log.log_id)) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate local trace log identity",
          message: `Trace log ${log.log_id} appears more than once in the batch.`,
        }),
      );
    }
    logsById.set(log.log_id, log);
  }
  const metricIds = new Set<string>();
  for (const point of request.batch.metric_points ?? []) {
    if (metricIds.has(point.metric_id)) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate historical metric identity",
          message: `Historical metric ${point.metric_id} appears more than once in the batch.`,
        }),
      );
    }
    metricIds.add(point.metric_id);
    if (point.source_kind !== request.source_kind) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate historical metric source",
          message: `Historical metric ${point.metric_id} belongs to ${point.source_kind}, not ${request.source_kind}.`,
        }),
      );
    }
    if (point.log_id !== undefined) {
      const log = logsById.get(point.log_id);
      if (log === undefined || log.trace_id !== point.trace_id) {
        return yield* Effect.fail(
          LocalTraceImportFailure.make({
            operation: "resolve historical metric log",
            message: `Historical metric ${point.metric_id} references an absent or mismatched log.`,
          }),
        );
      }
    }
  }
  const logSkillLinks: DuckDbHistoricalLogSkillLink[] = [];
  const logLinkIds = new Set<string>();
  for (const sourceLink of request.batch.log_skill_links ?? []) {
    if (logLinkIds.has(sourceLink.link_id)) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate historical log skill link identity",
          message: `Historical log skill link ${sourceLink.link_id} appears more than once in the batch.`,
        }),
      );
    }
    logLinkIds.add(sourceLink.link_id);
    const log = logsById.get(sourceLink.log_id);
    if (log === undefined || log.trace_id !== sourceLink.trace_id) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "resolve historical log skill link",
          message: `Historical log skill link ${sourceLink.link_id} references an absent or mismatched log.`,
        }),
      );
    }
    const skillName = yield* resolveSkillName(database, sourceLink.skill_invocation_id);
    logSkillLinks.push(
      DuckDbHistoricalLogSkillLink.make({
        ...sourceLink,
        skill_name: skillName,
      }),
    );
  }

  const links: DuckDbTraceSkillLink[] = [];
  const skillFailureSignals: LocalSkillFailureSignal[] = [];
  const linkIds = new Set<string>();
  for (const sourceLink of request.batch.links ?? []) {
    if (linkIds.has(sourceLink.link_id)) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate local trace link identity",
          message: `Trace link ${sourceLink.link_id} appears more than once in the batch.`,
        }),
      );
    }
    linkIds.add(sourceLink.link_id);
    const span = spansById.get(sourceLink.span_id);
    if (span === undefined) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "resolve local trace skill link",
          message: `No trace span exists for ${sourceLink.span_id}.`,
        }),
      );
    }
    if (sourceLink.trace_id !== span.trace_id) {
      return yield* Effect.fail(
        LocalTraceImportFailure.make({
          operation: "validate local trace link",
          message: `Trace link ${sourceLink.link_id} does not match span ${span.span_id}.`,
        }),
      );
    }
    const skillName = yield* resolveSkillName(database, sourceLink.skill_invocation_id);
    links.push(DuckDbTraceSkillLink.make({ ...sourceLink, skill_name: skillName }));
    if (span.error_count > 0) {
      skillFailureSignals.push(
        LocalSkillFailureSignal.make({
          signal_id: signalId(request.source_kind, span.trace_id, sourceLink.skill_invocation_id),
          kind: "skill_execution_error",
          trace_id: span.trace_id,
          skill_invocation_id: sourceLink.skill_invocation_id,
          skill_name: skillName,
          duration_ms: Date.parse(span.ended_at) - Date.parse(span.started_at),
          input_tokens: span.input_tokens,
          output_tokens: span.output_tokens,
          error_count: span.error_count,
          tool_call_count: span.tool_call_count,
        }),
      );
    }
  }
  return {
    analyticalBatch: DuckDbAnalyticalBatch.make({
      schema_version: "1.0.0",
      batch_id: request.batch.batch_id,
      source_revision: request.source_revision,
      normalizer_version: request.normalizer_version,
      spans: request.batch.spans.map((span) => DuckDbTraceSpan.make(span)),
      links,
      ...(request.batch.resources
        ? {
            resources: request.batch.resources.map((resource) =>
              DuckDbTraceResource.make(resource),
            ),
          }
        : {}),
      ...(request.batch.instrumentation_scopes
        ? {
            instrumentation_scopes: request.batch.instrumentation_scopes.map((scope) =>
              DuckDbTraceInstrumentationScope.make(scope),
            ),
          }
        : {}),
      ...(request.batch.logs
        ? {
            logs: request.batch.logs.map((log) => DuckDbTraceLogRecord.make(log)),
          }
        : {}),
      ...(request.batch.metric_points
        ? {
            metric_points: request.batch.metric_points.map((point) =>
              DuckDbHistoricalMetricPoint.make(point),
            ),
          }
        : {}),
      ...(request.batch.log_skill_links
        ? {
            log_skill_links: logSkillLinks,
          }
        : {}),
      ...(request.batch.span_links
        ? {
            span_links: request.batch.span_links.map((link) => DuckDbTraceSpanLink.make(link)),
          }
        : {}),
    }),
    skillFailureSignals,
  };
});

const decodeRequest = (input: unknown) =>
  Schema.decodeUnknownEffect(LocalTraceImportRequest)(input).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        LocalTraceImportFailure.make({
          operation: "decode local trace import request",
          message: error.message,
        }),
      ),
    ),
  );

/**
 * Live importer. SQLite remains canonical for invocation identity and its
 * checkpoint is acknowledged only after DuckDB confirms the exact receipt.
 */
export const makeLocalTraceImporterLive = (database: Database) =>
  Layer.effect(
    LocalTraceImporter,
    Effect.gen(function* () {
      const store = yield* DuckDbAnalyticalStore;
      const importTrace = Effect.fn("LocalTraceImporter.importTrace")(function* (input: unknown) {
        const request = yield* decodeRequest(input);
        const resolved = yield* resolveBatch(database, request);
        const checkpoint = AnalyticalImportCheckpoint.make({
          source_kind: request.source_kind,
          source_identity: request.batch.batch_id,
          source_fingerprint: request.source_revision,
          normalizer_version: request.normalizer_version,
        });
        const checkpointCurrent = yield* isAnalyticalImportCurrent(database, checkpoint).pipe(
          Effect.mapError((failure) =>
            LocalTraceImportFailure.make({
              operation: failure.operation,
              message: failure.message,
            }),
          ),
        );
        const receiptCurrent = yield* store.hasExactBatchReceipt(resolved.analyticalBatch).pipe(
          Effect.mapError((failure) =>
            LocalTraceImportFailure.make({
              operation: failure.operation,
              message: failure.message,
            }),
          ),
        );
        if (!receiptCurrent) {
          yield* store.ingest(resolved.analyticalBatch).pipe(
            Effect.mapError((failure) =>
              LocalTraceImportFailure.make({
                operation: failure.operation,
                message: failure.message,
              }),
            ),
          );
        }
        if (!checkpointCurrent || !receiptCurrent) {
          yield* acknowledgeAnalyticalImport(database, checkpoint).pipe(
            Effect.mapError((failure) =>
              LocalTraceImportFailure.make({
                operation: failure.operation,
                message: failure.message,
              }),
            ),
          );
        }
        return LocalTraceImportResult.make({
          skill_failure_signals: resolved.skillFailureSignals,
        });
      });
      return LocalTraceImporter.of({ importTrace });
    }),
  );
