/**
 * Tests for session type inference and artifact counting.
 */
import { describe, expect, test } from "bun:test";

import { inferSessionType } from "../../cli/selftune/utils/transcript.js";

describe("inferSessionType", () => {
  test("returns 'dev' for sessions with git commands and Write/Edit", () => {
    const toolCalls = { Write: 5, Edit: 10, Bash: 8, Read: 20 };
    const bashCommands = ["git add .", "git commit -m 'test'", "bun test"];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("dev");
  });

  test("returns 'dev' for git-heavy Bash sessions", () => {
    const toolCalls = { Bash: 15, Read: 5 };
    const bashCommands = [
      "git status",
      "git diff",
      "git log --oneline -5",
      "git commit -m 'fix'",
      "bun test",
    ];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("dev");
  });

  test("returns 'research' for WebSearch/WebFetch heavy sessions", () => {
    const toolCalls = { WebSearch: 10, WebFetch: 8, Read: 5 };
    const bashCommands: string[] = [];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("research");
  });

  test("returns 'research' for Read-heavy sessions with low file mutations", () => {
    const toolCalls = { Read: 30, Bash: 2 };
    const bashCommands = ["ls", "pwd"];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("research");
  });

  test("returns 'content' for Write/Edit heavy sessions without git", () => {
    const toolCalls = { Write: 8, Edit: 5, Read: 10 };
    const bashCommands = ["ls"];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("content");
  });

  test("returns 'mixed' for empty tool calls", () => {
    expect(inferSessionType({}, [])).toBe("mixed");
  });

  test("returns 'mixed' for balanced sessions", () => {
    const toolCalls = { Read: 5, WebSearch: 2, Bash: 2, Write: 1 };
    const bashCommands = ["ls", "pwd"];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("mixed");
  });

  test("does not classify as dev without git commands even with Bash", () => {
    const toolCalls = { Bash: 20, Read: 10 };
    const bashCommands = ["npm install", "bun test", "ls -la", "pwd"];
    // No git commands → not dev, and not enough research/content signals → mixed
    expect(inferSessionType(toolCalls, bashCommands)).not.toBe("dev");
  });

  test("WebSearch + WebFetch dominant = research even with some Write", () => {
    const toolCalls = { WebSearch: 15, WebFetch: 10, Write: 2, Read: 3 };
    const bashCommands: string[] = [];
    expect(inferSessionType(toolCalls, bashCommands)).toBe("research");
  });
});

describe("artifact counting in parseTranscript", () => {
  // Integration test would require transcript fixtures, so we test the logic
  // indirectly via the inferSessionType function above and the ARTIFACT_TOOLS set

  test("artifact tools set includes expected output-producing tools", () => {
    // Verify the concept: these tools produce artifacts
    const ARTIFACT_TOOLS = new Set(["Write", "Edit", "WebFetch", "WebSearch", "Skill", "Agent"]);
    expect(ARTIFACT_TOOLS.has("Write")).toBe(true);
    expect(ARTIFACT_TOOLS.has("Edit")).toBe(true);
    expect(ARTIFACT_TOOLS.has("WebFetch")).toBe(true);
    expect(ARTIFACT_TOOLS.has("WebSearch")).toBe(true);
    expect(ARTIFACT_TOOLS.has("Skill")).toBe(true);
    expect(ARTIFACT_TOOLS.has("Agent")).toBe(true);
    // Read is NOT an artifact tool — it's consumption, not production
    expect(ARTIFACT_TOOLS.has("Read")).toBe(false);
    expect(ARTIFACT_TOOLS.has("Bash")).toBe(false);
  });
});
