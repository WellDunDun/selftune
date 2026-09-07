import { describe, expect, test } from "bun:test";

import {
  collectCodexTaskReplayProcess,
  parseCodexTaskReplayOutput,
} from "../../packages/runtime/evolution/host-task-replay.js";

const openStream = () => new ReadableStream<Uint8Array>({ start: () => undefined });

const closedStream = () =>
  new ReadableStream<Uint8Array>({
    start: (controller) => controller.close(),
  });

describe("collectCodexTaskReplayProcess", () => {
  test("retains valid neighboring message blocks and usage through malformed events", () => {
    const parsed = parseCodexTaskReplayOutput(
      [
        "null",
        "[]",
        "{broken",
        '{"type":"thread.started","thread_id":"thread-valid"}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"not an assistant response"}]}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[null,42,{"text":{}},{"text":" valid response "}]}}',
        '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":45}}',
        '{"type":"turn.completed","usage":{"input_tokens":"9000","output_tokens":0},"thread_id":{}}',
        '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":1.5}}',
      ].join("\n"),
    );
    expect(parsed).toEqual({
      output: "valid response",
      sessionId: "thread-valid",
      inputTokens: 120,
      outputTokens: 0,
      runtimeError: null,
    });
  });

  test("preserves string and structured runtime errors without accepting malformed messages", () => {
    expect(parseCodexTaskReplayOutput('{"error":"failed to start"}').runtimeError).toBe(
      "failed to start",
    );
    expect(
      parseCodexTaskReplayOutput(
        [
          '{"type":"turn.failed","error":{"message":"quota exhausted"}}',
          '{"type":"turn.failed","error":{"message":42}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":{},"content":"invalid"}}',
        ].join("\n"),
      ),
    ).toMatchObject({ runtimeError: "quota exhausted", output: "" });
  });

  test("times out when an exited Codex process leaves inherited streams open", async () => {
    const signals: number[] = [];

    await expect(
      collectCodexTaskReplayProcess(
        {
          stdout: openStream(),
          stderr: openStream(),
          exited: Promise.resolve(0),
          kill: (signal) => signals.push(signal ?? 15),
        },
        { timeoutMs: 5, terminationGraceMs: 1 },
      ),
    ).rejects.toThrow("Codex task replay timed out after 5ms.");
    expect(signals).toEqual([15]);
  });

  test("force-kills a Codex process that ignores graceful timeout termination", async () => {
    const signals: number[] = [];

    await expect(
      collectCodexTaskReplayProcess(
        {
          stdout: closedStream(),
          stderr: closedStream(),
          exited: new Promise<number>(() => undefined),
          kill: (signal) => signals.push(signal ?? 15),
        },
        { timeoutMs: 5, terminationGraceMs: 5 },
      ),
    ).rejects.toThrow("Codex task replay timed out after 5ms.");
    expect(signals).toEqual([15, 9]);
  });

  test("extracts the final Codex task response and usage from JSONL", () => {
    const parsed = parseCodexTaskReplayOutput(
      [
        '{"type":"thread.started","thread_id":"task-thread-1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first draft"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"final draft"}}',
        '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":45}}',
      ].join("\n"),
    );

    expect(parsed).toEqual({
      output: "final draft",
      sessionId: "task-thread-1",
      inputTokens: 120,
      outputTokens: 45,
      runtimeError: null,
    });
  });
});
