import { describe, expect, mock, test } from "bun:test";
import type { SessionTelemetryRecord } from "../../cli/selftune/types.js";

const mockCallViaAgent = mock(async () =>
  JSON.stringify({
    expectations: [],
    summary: { passed: 0, failed: 0, total: 0, pass_rate: 0, mean_score: 0 },
    claims: [],
    eval_feedback: { suggestions: [], overall: "" },
  }),
);

mock.module("../../cli/selftune/utils/llm-call.js", () => ({
  callViaAgent: mockCallViaAgent,
  detectAgent: () => "openclaw",
  stripMarkdownFences: (text: string) => text,
}));

const { gradeSession } = await import("../../cli/selftune/grading/grade-session.js");

function makeTelemetryRecord(
  overrides: Partial<SessionTelemetryRecord> = {},
): SessionTelemetryRecord {
  return {
    timestamp: "2025-01-15T10:00:00Z",
    session_id: "sess-abc",
    cwd: "/tmp/test",
    transcript_path: "/tmp/transcript.jsonl",
    tool_calls: { Read: 1 },
    total_tool_calls: 1,
    bash_commands: [],
    skills_triggered: ["pptx"],
    assistant_turns: 2,
    errors_encountered: 0,
    transcript_chars: 200,
    last_user_query: "create slides",
    ...overrides,
  };
}

describe("gradeSession", () => {
  test("throws when the grader returns the wrong number of expectation results", async () => {
    mockCallViaAgent.mockReset();
    mockCallViaAgent.mockImplementation(async () =>
      JSON.stringify({
        expectations: [],
        summary: { passed: 0, failed: 0, total: 0, pass_rate: 0, mean_score: 0 },
        claims: [],
        eval_feedback: { suggestions: [], overall: "" },
      }),
    );

    await expect(
      gradeSession({
        expectations: ["The final output was well structured"],
        telemetry: makeTelemetryRecord(),
        sessionId: "sess-abc",
        skillName: "pptx",
        transcriptExcerpt: "[USER] create slides",
        transcriptPath: "/tmp/transcript.jsonl",
        agent: "openclaw",
      }),
    ).rejects.toThrow("Grader returned 0 expectations for 1 unresolved expectations");
  });
});
