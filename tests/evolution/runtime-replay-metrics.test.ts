import { describe, expect, test } from "bun:test";
import { extractClaudeRuntimeReplayMetrics } from "../../packages/runtime/evolution/validate-host-replay.js";

describe("runtime replay metrics", () => {
  test("extracts Claude stream-json metrics for live replay dashboards", () => {
    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session-1",
          model: "claude-opus-4-6[1m]",
        }),
      ),
    ).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "session-1",
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    });

    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "assistant",
          session_id: "session-1",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              cache_creation_input_tokens: 11,
              cache_read_input_tokens: 22,
            },
          },
        }),
      ),
    ).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "session-1",
      input_tokens: 3,
      output_tokens: 1,
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 22,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    });

    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "result",
          session_id: "session-1",
          duration_ms: 14621,
          total_cost_usd: 0.08946875,
          num_turns: 1,
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_creation_input_tokens: 13225,
            cache_read_input_tokens: 13395,
          },
          modelUsage: {
            "claude-opus-4-6[1m]": {
              inputTokens: 3,
            },
          },
        }),
      ),
    ).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "session-1",
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 13225,
      cache_read_input_tokens: 13395,
      total_cost_usd: 0.08946875,
      duration_ms: 14621,
      num_turns: 1,
    });
  });
});
