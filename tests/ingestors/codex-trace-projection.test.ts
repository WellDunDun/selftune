import { expect, test } from "bun:test";

import { buildLocalTelemetryBatchFromRollout } from "@selftune/harness-codex/ingestors/codex-trace-projection";

test("projects a source-timed multi-turn Codex session as one session trace", () => {
  const batch = buildLocalTelemetryBatchFromRollout({
    timestamp: "2026-07-24T10:00:00.000Z",
    started_at: "2026-07-24T10:00:00.000Z",
    ended_at: "2026-07-24T10:05:00.000Z",
    actionable_prompt_count: 3,
    session_id: "multi-turn-codex-session",
    source: "codex_rollout",
    rollout_path: "/private/source/rollout.jsonl",
    query: "Diagnose the failure",
    tool_calls: { bash: 2 },
    total_tool_calls: 2,
    bash_commands: ["npm test"],
    skills_triggered: ["diagnose"],
    skills_invoked: ["diagnose"],
    skill_evidence: { diagnose: "explicit" },
    assistant_turns: 3,
    errors_encountered: 1,
    input_tokens: 120,
    output_tokens: 30,
    transcript_chars: 900,
    cwd: "/private/source",
    transcript_path: "/private/source/rollout.jsonl",
    last_user_query: "Diagnose the failure",
  });

  expect(batch?.spans).toHaveLength(1);
  expect(batch?.spans[0]).toMatchObject({
    trace_boundary: "session",
    platform: "codex",
    capture_mode: "rollout",
    source_authority: "source_truth",
  });
  expect(batch?.links).toHaveLength(1);
});

test("does not create an empty receipt for non-actionable or invalid-timing rollouts", () => {
  const parsed = {
    timestamp: "2026-07-24T10:00:00.000Z",
    session_id: "not-a-trace",
    source: "codex_rollout",
    rollout_path: "/private/source/rollout.jsonl",
    query: "",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    skills_invoked: [],
    skill_evidence: {},
    assistant_turns: 0,
    errors_encountered: 0,
    input_tokens: 0,
    output_tokens: 0,
    transcript_chars: 0,
    cwd: "",
    transcript_path: "/private/source/rollout.jsonl",
    last_user_query: "",
  };

  expect(buildLocalTelemetryBatchFromRollout(parsed)).toBeNull();
  expect(
    buildLocalTelemetryBatchFromRollout({
      ...parsed,
      started_at: "2026-07-24T10:00:00.000Z",
      ended_at: "2026-07-24T10:00:00.000Z",
      actionable_prompt_count: 1,
    }),
  ).toBeNull();
});
