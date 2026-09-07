import { createHash } from "node:crypto";

import {
  LocalTelemetryBatch,
  LocalTelemetrySkillLink,
  LocalTelemetrySpan,
} from "@selftune/observability";
import { deriveSkillInvocationId } from "@selftune/runtime/normalization";

import type { ParsedSession } from "./pi-ingest.js";

function stableTelemetryId(label: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(label);
  for (const part of parts) {
    hash.update("\u0000");
    hash.update(part);
  }
  return hash.digest("hex");
}

function sourceCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function emptyBatch(batchId: string): LocalTelemetryBatch {
  return LocalTelemetryBatch.make({
    schema_version: "1.0.0",
    semantic_convention_version: "1.0.0",
    batch_id: batchId,
    spans: [],
    links: [],
  });
}

/** Projects Pi source facts into bounded metadata-only analytical trace telemetry. */
export function buildLocalTelemetryBatchFromPiSession(session: ParsedSession): LocalTelemetryBatch {
  const sourceId = stableTelemetryId(
    "selftune.local-telemetry.pi.source.v1",
    session.session_id,
  ).slice(0, 32);
  const batchId = stableTelemetryId("selftune.local-telemetry.pi.batch.v1", sourceId).slice(0, 32);
  const endedAt = session.ended_at;
  if (!endedAt) return emptyBatch(batchId);

  const startedEpoch = Date.parse(session.timestamp);
  const endedEpoch = Date.parse(endedAt);
  if (
    !Number.isFinite(startedEpoch) ||
    !Number.isFinite(endedEpoch) ||
    endedEpoch <= startedEpoch
  ) {
    return emptyBatch(batchId);
  }

  const traceId = stableTelemetryId(
    "selftune.local-telemetry.pi.trace.v1",
    sourceId,
    session.timestamp,
    endedAt,
  ).slice(0, 32);
  const spanId = stableTelemetryId(
    "selftune.local-telemetry.pi.span.v1",
    traceId,
    session.timestamp,
    endedAt,
  ).slice(0, 16);
  const sourceSpan = {
    trace_id: traceId,
    span_id: spanId,
    name: "invoke_agent pi",
    operation_name: "invoke_agent",
    trace_boundary: "session",
    started_at: session.timestamp,
    ended_at: endedAt,
    platform: "pi",
    capture_mode: "session",
    source_authority: "source_truth",
    source_id: sourceId,
    input_tokens: sourceCount(session.input_tokens),
    output_tokens: sourceCount(session.output_tokens),
    error_count: sourceCount(session.errors_encountered),
    tool_call_count: sourceCount(session.total_tool_calls),
  } satisfies LocalTelemetrySpan;
  const providerSpan = session.provider
    ? { ...sourceSpan, provider: session.provider }
    : sourceSpan;
  const span = LocalTelemetrySpan.make(
    session.model ? { ...providerSpan, model: session.model } : providerSpan,
  );
  const skillDetections =
    session.skill_detections ??
    session.skills_triggered.map((skillName) => ({ skill_name: skillName }));

  return LocalTelemetryBatch.make({
    schema_version: "1.0.0",
    semantic_convention_version: "1.0.0",
    batch_id: batchId,
    spans: [span],
    links: skillDetections.slice(0, 256).map((detection, index) => {
      const skillInvocationId = deriveSkillInvocationId(
        session.session_id,
        detection.skill_name,
        index,
      );
      return LocalTelemetrySkillLink.make({
        link_id: stableTelemetryId(
          "selftune.local-telemetry.pi.skill-link.v1",
          spanId,
          skillInvocationId,
        ).slice(0, 32),
        span_id: spanId,
        trace_id: traceId,
        skill_invocation_id: skillInvocationId,
      });
    }),
  });
}
