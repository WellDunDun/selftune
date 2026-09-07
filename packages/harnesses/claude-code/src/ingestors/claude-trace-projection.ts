import { createHash } from "node:crypto";

import {
  LocalTelemetryBatch,
  LocalTelemetrySkillLink,
  LocalTelemetrySpan,
} from "@selftune/observability";
import { deriveSkillInvocationId } from "@selftune/runtime/normalization";
import type { TranscriptSkillInvocationEvent } from "@selftune/runtime/types";

import type { ParsedSession } from "./claude-replay.js";

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

function replaySkillEvents(session: ParsedSession): readonly TranscriptSkillInvocationEvent[] {
  if (session.metrics.skill_invocation_events?.length) {
    return session.metrics.skill_invocation_events;
  }

  const latestPromptIndex = Math.max(session.user_queries.length - 1, 0);
  const invoked = session.metrics.skills_invoked ?? [];
  const skillSource = invoked.length > 0 ? invoked : session.metrics.skills_triggered;
  return skillSource.map((skillName) => ({
    skill_name: skillName,
    occurred_at: session.timestamp,
    prompt_index: latestPromptIndex,
    tool_name: invoked.length > 0 ? "Skill" : "Read",
    triggered: invoked.length > 0,
  }));
}

/**
 * Projects a Claude transcript session into bounded metadata-only local trace telemetry.
 * Opaque identifiers derive from source identity and timing; transcript text, paths, tool
 * payloads, and model output deliberately never leave the canonical operational pipeline.
 */
export function buildLocalTelemetryBatchFromSession(session: ParsedSession): LocalTelemetryBatch {
  const sourceId = stableTelemetryId(
    "selftune.local-telemetry.claude-code.source.v1",
    session.session_id,
  ).slice(0, 32);
  const batchId = stableTelemetryId(
    "selftune.local-telemetry.claude-code.batch.v1",
    sourceId,
  ).slice(0, 32);
  const startedAt = session.metrics.started_at ?? session.timestamp;
  const endedAt = session.metrics.ended_at;
  if (endedAt === undefined) return emptyBatch(batchId);
  const startedEpoch = Date.parse(startedAt);
  const endedEpoch = Date.parse(endedAt);

  if (
    !Number.isFinite(startedEpoch) ||
    !Number.isFinite(endedEpoch) ||
    endedEpoch <= startedEpoch
  ) {
    return emptyBatch(batchId);
  }

  const traceId = stableTelemetryId(
    "selftune.local-telemetry.claude-code.trace.v1",
    sourceId,
    startedAt,
    endedAt,
  ).slice(0, 32);
  const spanId = stableTelemetryId(
    "selftune.local-telemetry.claude-code.span.v1",
    traceId,
    startedAt,
    endedAt,
  ).slice(0, 16);
  const sourceSpan = {
    trace_id: traceId,
    span_id: spanId,
    name: "invoke_agent claude_code",
    operation_name: "invoke_agent",
    trace_boundary: "session",
    started_at: startedAt,
    ended_at: endedAt,
    platform: "claude_code",
    capture_mode: "transcript",
    source_authority: "source_truth",
    source_id: sourceId,
    input_tokens: sourceCount(session.metrics.input_tokens),
    output_tokens: sourceCount(session.metrics.output_tokens),
    error_count: sourceCount(session.metrics.errors_encountered),
    tool_call_count: sourceCount(session.metrics.total_tool_calls),
  } satisfies LocalTelemetrySpan;
  const span = LocalTelemetrySpan.make(
    session.metrics.model ? { ...sourceSpan, model: session.metrics.model } : sourceSpan,
  );

  return LocalTelemetryBatch.make({
    schema_version: "1.0.0",
    semantic_convention_version: "1.0.0",
    batch_id: batchId,
    spans: [span],
    links: replaySkillEvents(session)
      .slice(0, 256)
      .map((event, index) => {
        const skillInvocationId = deriveSkillInvocationId(
          session.session_id,
          event.skill_name,
          event.source_event_index ?? index,
          event.tool_call_id,
        );
        return LocalTelemetrySkillLink.make({
          link_id: stableTelemetryId(
            "selftune.local-telemetry.claude-code.skill-link.v1",
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
