import * as Schema from "effect/Schema";

const Count = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * Harness-neutral process evidence retained beside an outcome score. These
 * counters explain how an arm operated; they are not collapsed into a reward.
 */
export const TrajectoryProcessMetrics = Schema.Struct({
  turns: Count,
  input_tokens: Count,
  output_tokens: Count,
  tool_calls: Count,
  failed_tool_calls: Count,
  repeated_actions: Count,
  user_corrections: Count,
  progress_events: Count,
  wall_time_ms: Count,
});
export type TrajectoryProcessMetrics = typeof TrajectoryProcessMetrics.Type;

export const emptyTrajectoryProcessMetrics = (): TrajectoryProcessMetrics => ({
  turns: 0,
  input_tokens: 0,
  output_tokens: 0,
  tool_calls: 0,
  failed_tool_calls: 0,
  repeated_actions: 0,
  user_corrections: 0,
  progress_events: 0,
  wall_time_ms: 0,
});

export function aggregateTrajectoryProcessMetrics(
  entries: ReadonlyArray<TrajectoryProcessMetrics>,
): TrajectoryProcessMetrics {
  return entries.reduce<TrajectoryProcessMetrics>(
    (total, entry) => ({
      turns: total.turns + entry.turns,
      input_tokens: total.input_tokens + entry.input_tokens,
      output_tokens: total.output_tokens + entry.output_tokens,
      tool_calls: total.tool_calls + entry.tool_calls,
      failed_tool_calls: total.failed_tool_calls + entry.failed_tool_calls,
      repeated_actions: total.repeated_actions + entry.repeated_actions,
      user_corrections: total.user_corrections + entry.user_corrections,
      progress_events: total.progress_events + entry.progress_events,
      wall_time_ms: total.wall_time_ms + entry.wall_time_ms,
    }),
    emptyTrajectoryProcessMetrics(),
  );
}
