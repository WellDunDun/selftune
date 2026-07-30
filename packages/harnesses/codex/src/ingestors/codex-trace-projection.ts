import { createHash } from "node:crypto";

import {
  LocalTelemetryBatch,
  LocalTelemetrySkillLink,
  LocalTelemetrySpan,
} from "@selftune/observability";
import { deriveSkillInvocationId } from "@selftune/runtime/normalization";

import type { ParsedRollout } from "./codex-rollout.js";

function stableTelemetryId(label: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(label);
  for (const part of parts) {
    hash.update("\u0000");
    hash.update(part);
  }
  return hash.digest("hex");
}

function sourceCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Projects one source-timed Codex rollout into bounded local trace telemetry.
 * The emitted identifiers use only opaque source identity and timing; prompts,
 * paths, tool payloads, and model output never cross this boundary.
 */
export function buildLocalTelemetryBatchFromRollout(
  parsed: ParsedRollout,
): LocalTelemetryBatch | null {
  const sourceId = stableTelemetryId(
    "selftune.local-telemetry.codex.source.v1",
    parsed.session_id,
  ).slice(0, 32);
  const startedEpoch = parsed.started_at ? Date.parse(parsed.started_at) : Number.NaN;
  const endedEpoch = parsed.ended_at ? Date.parse(parsed.ended_at) : Number.NaN;
  const hasPositiveSourceInterval =
    Number.isFinite(startedEpoch) && Number.isFinite(endedEpoch) && endedEpoch > startedEpoch;
  const batchId = stableTelemetryId("selftune.local-telemetry.codex.batch.v1", sourceId).slice(
    0,
    32,
  );

  if (!hasPositiveSourceInterval || sourceCount(parsed.actionable_prompt_count ?? 0) === 0)
    return null;

  const startedAt = new Date(startedEpoch).toISOString();
  const endedAt = new Date(endedEpoch).toISOString();
  const traceId = stableTelemetryId(
    "selftune.local-telemetry.codex.trace.v1",
    sourceId,
    startedAt,
    endedAt,
  ).slice(0, 32);
  const spanId = stableTelemetryId(
    "selftune.local-telemetry.codex.span.v1",
    traceId,
    startedAt,
    endedAt,
  ).slice(0, 16);
  const span = LocalTelemetrySpan.make({
    trace_id: traceId,
    span_id: spanId,
    name: "invoke_agent codex",
    operation_name: "invoke_agent",
    // Codex rollouts are durable sessions and commonly contain multiple
    // actionable turns. Preserve that source boundary instead of discarding
    // multi-turn evidence as if it were an invalid trace.
    trace_boundary: "session",
    started_at: startedAt,
    ended_at: endedAt,
    platform: "codex",
    capture_mode: "rollout",
    source_authority: "source_truth",
    source_id: sourceId,
    ...(parsed.observed_meta?.model_provider
      ? { provider: parsed.observed_meta.model_provider }
      : {}),
    ...(parsed.observed_meta?.model ? { model: parsed.observed_meta.model } : {}),
    input_tokens: sourceCount(parsed.input_tokens),
    output_tokens: sourceCount(parsed.output_tokens),
    error_count: sourceCount(parsed.errors_encountered),
    tool_call_count: sourceCount(parsed.total_tool_calls),
  });

  return LocalTelemetryBatch.make({
    schema_version: "1.0.0",
    semantic_convention_version: "1.0.0",
    batch_id: batchId,
    spans: [span],
    links: parsed.skills_triggered.slice(0, 256).map((skillName, index) => {
      const skillInvocationId = deriveSkillInvocationId(
        parsed.session_id,
        skillName,
        index,
        "codex-rollout",
      );
      return LocalTelemetrySkillLink.make({
        link_id: stableTelemetryId(
          "selftune.local-telemetry.codex.skill-link.v1",
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
