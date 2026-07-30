import { createHash } from "node:crypto";

import {
  LocalTelemetryBatch,
  LocalTelemetrySkillLink,
  LocalTelemetrySpan,
} from "@selftune/observability";
import { deriveSkillInvocationId } from "@selftune/runtime/normalization";

import type { ParsedSession } from "./opencode-ingest.js";

function stableTelemetryId(label: string, ...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  hash.update(label);
  for (const part of parts) {
    hash.update("\u0000");
    hash.update(part);
  }
  return hash.digest("hex");
}

function sourceCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Projects an OpenCode session into bounded source-truth telemetry. Opaque
 * identifiers are derived from source identity only; prompts, paths, tool
 * payloads, commands, and model output never leave the source adapter.
 */
export function buildLocalTelemetryBatchFromOpenCode(session: ParsedSession): LocalTelemetryBatch {
  const sourceId = stableTelemetryId(
    "selftune.local-telemetry.opencode.source.v1",
    session.session_id,
  ).slice(0, 32);
  const batchId = stableTelemetryId("selftune.local-telemetry.opencode.batch.v1", sourceId).slice(
    0,
    32,
  );
  const startedEpoch = Date.parse(session.timestamp);
  const endedEpoch = session.source_ended_at ? Date.parse(session.source_ended_at) : Number.NaN;

  if (
    !Number.isFinite(startedEpoch) ||
    !Number.isFinite(endedEpoch) ||
    endedEpoch <= startedEpoch
  ) {
    return LocalTelemetryBatch.make({
      schema_version: "1.0.0",
      semantic_convention_version: "1.0.0",
      batch_id: batchId,
      spans: [],
      links: [],
    });
  }

  const startedAt = new Date(startedEpoch).toISOString();
  const endedAt = new Date(endedEpoch).toISOString();
  const traceId = stableTelemetryId(
    "selftune.local-telemetry.opencode.trace.v1",
    sourceId,
    startedAt,
    endedAt,
  ).slice(0, 32);
  const spanId = stableTelemetryId(
    "selftune.local-telemetry.opencode.span.v1",
    traceId,
    startedAt,
    endedAt,
  ).slice(0, 16);
  const span = LocalTelemetrySpan.make({
    trace_id: traceId,
    span_id: spanId,
    name: "invoke_agent opencode",
    operation_name: "invoke_agent",
    trace_boundary: "session",
    started_at: startedAt,
    ended_at: endedAt,
    platform: "opencode",
    capture_mode: "session",
    source_authority: "source_truth",
    source_id: sourceId,
    ...(session.model_provider ? { provider: session.model_provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    input_tokens: sourceCount(session.input_tokens),
    output_tokens: sourceCount(session.output_tokens),
    error_count: sourceCount(session.errors_encountered),
    tool_call_count: sourceCount(session.total_tool_calls),
  });
  const detections =
    session.skill_detections ??
    session.skills_triggered.map((skill_name) => ({
      skill_name,
      has_skill_md_read: false,
    }));

  return LocalTelemetryBatch.make({
    schema_version: "1.0.0",
    semantic_convention_version: "1.0.0",
    batch_id: batchId,
    spans: [span],
    links: detections.slice(0, 256).map((detection, index) => {
      const skillInvocationId = deriveSkillInvocationId(
        session.session_id,
        detection.skill_name,
        index,
      );
      return LocalTelemetrySkillLink.make({
        link_id: stableTelemetryId(
          "selftune.local-telemetry.opencode.skill-link.v1",
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
