import { describe, expect, test } from "bun:test";

import {
  extractClaudeRuntimeReplayMetrics,
  parseClaudeRuntimeReplayOutput,
  parseCodexRuntimeReplayOutput,
  parseOpenCodeRuntimeReplayOutput,
} from "../../packages/runtime/evolution/validate-host-replay/parsers.js";

const skills = new Set(["research"]);
const skillPath = "/tmp/.agents/skills/research/SKILL.md";

describe("replay parser input boundaries", () => {
  test("Claude keeps valid skill events beside malformed blocks and fields", () => {
    const raw = [
      null,
      42,
      {
        type: "assistant",
        session_id: "session",
        error: "provider error",
        message: {
          content: [
            null,
            42,
            { type: "tool_use", name: "Skill", input: { skill: "research" } },
            { type: "tool_use", name: "Read", input: { file_path: skillPath } },
            { type: "tool_use", name: "Read", input: { file_path: 42 } },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expect(parseClaudeRuntimeReplayOutput(raw)).toMatchObject({
      sessionId: "session",
      runtimeError: "provider error",
      triggeredSkillNames: ["research"],
      readSkillPaths: [skillPath],
      rawOutput: raw,
    });
  });

  test("Claude metrics retain valid numbers and reject malformed siblings", () => {
    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "assistant",
          model: 42,
          session_id: {},
          message: {
            model: "claude-test[1m]",
            usage: {
              input_tokens: "100",
              output_tokens: 8,
              cache_read_input_tokens: null,
            },
          },
        }),
      ),
    ).toMatchObject({
      model: "claude-test",
      session_id: null,
      input_tokens: null,
      output_tokens: 8,
      cache_read_input_tokens: null,
    });
    for (const line of ["null", "[]", "42", "not JSON"]) {
      expect(extractClaudeRuntimeReplayMetrics(line)).toBeNull();
    }
  });

  test("Codex keeps string and structured errors and ignores malformed text blocks", () => {
    const raw = [
      null,
      { type: "thread.started", thread_id: "thread" },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [null, 42, { text: "use research for this question" }, { text: {} }],
        },
      },
      { type: "turn.failed", error: { message: "quota exceeded" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expect(parseCodexRuntimeReplayOutput(raw, skills)).toMatchObject({
      sessionId: "thread",
      runtimeError: "quota exceeded",
      triggeredSkillNames: ["research"],
    });
    expect(
      parseCodexRuntimeReplayOutput('{"error":"provider unavailable"}', skills).runtimeError,
    ).toBe("provider unavailable");
  });

  test.each([1, "1", null, {}, false])(
    "malformed or failing exit status is never success: %j",
    (exit) => {
      const codex = JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: `cat ${skillPath}`,
          exit_code: exit,
        },
      });
      expect(parseCodexRuntimeReplayOutput(codex, skills).runtimeError).toBeDefined();
      const opencode = JSON.stringify({
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: `cat ${skillPath}` },
          metadata: { exit },
        },
      });
      expect(parseOpenCodeRuntimeReplayOutput(opencode, skills).runtimeError).toBeDefined();
    },
  );

  test("OpenCode nested parts preserve reads, session IDs, and errors", () => {
    const raw = [
      null,
      {
        part: {
          type: "tool",
          sessionID: "session",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: skillPath },
            metadata: { exit: 0 },
          },
        },
      },
      { type: "step-finish", reason: "error", text: 42 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expect(parseOpenCodeRuntimeReplayOutput(raw, skills)).toMatchObject({
      sessionId: "session",
      triggeredSkillNames: ["research"],
      readSkillPaths: [skillPath],
      runtimeError: "step finished with error",
    });
  });
});
