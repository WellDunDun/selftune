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
