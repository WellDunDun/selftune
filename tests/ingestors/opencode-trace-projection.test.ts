import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { buildLocalTelemetryBatchFromOpenCode } from "@selftune/harness-opencode/ingestors/opencode-trace-projection";
import { deriveSkillInvocationId } from "@selftune/runtime/normalization";

describe("buildLocalTelemetryBatchFromOpenCode", () => {
  test("emits bounded metadata with canonical skill correlation and no source content", () => {
    const batch = buildLocalTelemetryBatchFromOpenCode({
      timestamp: "2026-07-23T10:00:00.000Z",
      source_ended_at: "2026-07-23T10:00:05.000Z",
      session_id: "open-code-session",
      source: "opencode",
      transcript_path: "/private/project/transcript.json",
      cwd: "/private/project",
      last_user_query: "PRIVATE_PROMPT",
      query: "PRIVATE_PROMPT",
      tool_calls: { Bash: 2 },
      total_tool_calls: 2,
      bash_commands: ["PRIVATE_COMMAND"],
      skills_triggered: ["diagnose", "review"],
      skill_detections: [
        { skill_name: "diagnose", has_skill_md_read: true },
        { skill_name: "review", has_skill_md_read: false },
      ],
      assistant_turns: 1,
      errors_encountered: 1,
      transcript_chars: 999,
      model_provider: "openai",
      model: "gpt-test",
      input_tokens: 12,
      output_tokens: 8,
    });

    expect(batch.spans).toHaveLength(1);
    expect(batch.spans[0]).toMatchObject({
      platform: "opencode",
      capture_mode: "session",
      trace_boundary: "session",
      operation_name: "invoke_agent",
      input_tokens: 12,
      output_tokens: 8,
    });
    assert(batch.links);
    expect(batch.links.map((link) => link.skill_invocation_id)).toEqual([
      deriveSkillInvocationId("open-code-session", "diagnose", 0),
      deriveSkillInvocationId("open-code-session", "review", 1),
    ]);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_");
    expect(JSON.stringify(batch)).not.toContain("/private/project");
  });

  test("does not invent a trace interval when the source has no ordered end time", () => {
    const batch = buildLocalTelemetryBatchFromOpenCode({
      timestamp: "2026-07-23T10:00:00.000Z",
      session_id: "missing-end",
      source: "opencode",
      transcript_path: "source",
      cwd: "",
      last_user_query: "",
      query: "",
      tool_calls: {},
      total_tool_calls: 0,
      bash_commands: [],
      skills_triggered: [],
      assistant_turns: 0,
      errors_encountered: 0,
      transcript_chars: 0,
    });

    expect(batch.spans).toEqual([]);
    expect(batch.links).toEqual([]);
  });
});
