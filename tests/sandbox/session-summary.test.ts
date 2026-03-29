/**
 * Tests for session summary generation.
 */
import { describe, expect, test } from "bun:test";

import type { TranscriptMetrics } from "../../cli/selftune/types.js";
import { generateSessionSummary } from "../../cli/selftune/utils/transcript.js";

function makeMetrics(overrides: Partial<TranscriptMetrics> = {}): TranscriptMetrics {
  return {
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    skills_invoked: [],
    assistant_turns: 0,
    errors_encountered: 0,
    transcript_chars: 0,
    last_user_query: "",
    ...overrides,
  };
}

describe("generateSessionSummary", () => {
  test("dev session mentions files changed", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "dev",
        files_changed: 7,
        tool_calls: { Write: 3, Edit: 10, Bash: 5, Read: 20 },
        total_tool_calls: 38,
        last_user_query: "Refactored auth middleware and added rate limiting tests",
      }),
    );
    expect(summary).toContain("7 files changed");
    expect(summary).toContain("Edit");
  });

  test("research session mentions searches", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "research",
        tool_calls: { WebSearch: 8, WebFetch: 4, Read: 15 },
        total_tool_calls: 27,
        last_user_query: "Find best practices for connection pooling in PostgreSQL",
      }),
    );
    expect(summary).toContain("12 searches");
    expect(summary).toContain("15 reads");
  });

  test("content session mentions files created/edited", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "content",
        files_changed: 3,
        tool_calls: { Write: 3, Read: 5 },
        total_tool_calls: 8,
        last_user_query: "Create README and contributing guide",
      }),
    );
    expect(summary).toContain("3 files created/edited");
  });

  test("mixed session mentions tool calls and tool count", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "mixed",
        tool_calls: { Read: 5, WebSearch: 2, Bash: 3, Write: 1 },
        total_tool_calls: 11,
        last_user_query: "Investigate and fix the flaky test",
      }),
    );
    expect(summary).toContain("11 tool calls");
    expect(summary).toContain("4 tools");
  });

  test("summary is always under 120 chars", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "dev",
        files_changed: 42,
        tool_calls: { Write: 20, Edit: 30, Bash: 15, Read: 50 },
        total_tool_calls: 115,
        last_user_query:
          "Implement the entire authentication system with OAuth2 support including refresh tokens and PKCE flow for mobile clients",
      }),
    );
    expect(summary.length).toBeLessThanOrEqual(120);
  });

  test("empty metrics produce a reasonable fallback", () => {
    const summary = generateSessionSummary(makeMetrics());
    expect(summary).toBeTruthy();
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(120);
  });

  test("empty metrics with no query produce fallback message", () => {
    const summary = generateSessionSummary(makeMetrics());
    expect(summary).toBe("Empty session — no tool calls or queries");
  });

  test("dev session without files_changed uses 0", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "dev",
        tool_calls: { Bash: 5 },
        total_tool_calls: 5,
        bash_commands: ["git status"],
        last_user_query: "Check git status",
      }),
    );
    expect(summary).toContain("0 files changed");
  });

  test("defaults to mixed when session_type is undefined", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        tool_calls: { Read: 3, Bash: 2 },
        total_tool_calls: 5,
        last_user_query: "Look at the code",
      }),
    );
    expect(summary).toContain("5 tool calls");
    expect(summary).toContain("2 tools");
  });

  test("includes last_user_query in summary", () => {
    const summary = generateSessionSummary(
      makeMetrics({
        session_type: "content",
        files_changed: 1,
        tool_calls: { Write: 1 },
        total_tool_calls: 1,
        last_user_query: "Write the config file",
      }),
    );
    expect(summary).toContain("Write the config file");
  });
});
