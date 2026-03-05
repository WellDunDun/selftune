import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTokenUsage,
  getLastUserMessage,
  parseTranscript,
  readExcerpt,
} from "../../cli/selftune/utils/transcript.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-transcript-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(tmpDir, name);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

describe("parseTranscript", () => {
  test("returns empty metrics for missing file", () => {
    const m = parseTranscript(join(tmpDir, "nope.jsonl"));
    expect(m.assistant_turns).toBe(0);
    expect(m.total_tool_calls).toBe(0);
  });

  test("parses variant A (nested message)", () => {
    const path = writeTranscript("va.jsonl", [
      { type: "user", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/foo/SKILL.md" } },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      },
    ]);
    const m = parseTranscript(path);
    expect(m.assistant_turns).toBe(1);
    expect(m.total_tool_calls).toBe(2);
    expect(m.tool_calls.Read).toBe(1);
    expect(m.tool_calls.Bash).toBe(1);
    expect(m.bash_commands).toEqual(["ls -la"]);
    expect(m.skills_triggered).toEqual(["foo"]);
    expect(m.last_user_query).toBe("hello");
  });

  test("parses variant B (flat role/content)", () => {
    const path = writeTranscript("vb.jsonl", [
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }],
      },
    ]);
    const m = parseTranscript(path);
    expect(m.assistant_turns).toBe(1);
    expect(m.tool_calls.Edit).toBe(1);
    expect(m.last_user_query).toBe("fix the bug");
  });

  test("counts errors from tool_result entries", () => {
    const path = writeTranscript("errors.jsonl", [
      { type: "tool_result", is_error: true },
      {
        role: "user",
        content: [
          { type: "tool_result", is_error: true },
          { type: "tool_result", is_error: false },
        ],
      },
    ]);
    const m = parseTranscript(path);
    expect(m.errors_encountered).toBe(2);
  });

  test("extracts user text from content blocks", () => {
    const path = writeTranscript("blocks.jsonl", [
      {
        role: "user",
        content: [
          { type: "text", text: "first part" },
          { type: "text", text: "second part" },
        ],
      },
    ]);
    const m = parseTranscript(path);
    expect(m.last_user_query).toBe("first part second part");
  });
});

describe("getLastUserMessage", () => {
  test("returns null for missing file", () => {
    expect(getLastUserMessage(join(tmpDir, "nope.jsonl"))).toBeNull();
  });

  test("walks backwards to find last user message", () => {
    const path = writeTranscript("walk.jsonl", [
      { role: "user", content: "first message" },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
      { role: "user", content: "second message" },
      { role: "assistant", content: [{ type: "text", text: "response 2" }] },
    ]);
    expect(getLastUserMessage(path)).toBe("second message");
  });

  test("handles nested message format", () => {
    const path = writeTranscript("nested.jsonl", [
      { type: "user", message: { role: "user", content: "nested query" } },
    ]);
    expect(getLastUserMessage(path)).toBe("nested query");
  });
});

describe("readExcerpt", () => {
  test("returns not found for missing file", () => {
    expect(readExcerpt(join(tmpDir, "nope.jsonl"))).toBe("(transcript not found)");
  });

  test("produces readable excerpt", () => {
    const path = writeTranscript("excerpt.jsonl", [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll help" },
          { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    ]);
    const excerpt = readExcerpt(path);
    expect(excerpt).toContain("[USER] do something");
    expect(excerpt).toContain("[ASSISTANT] I'll help");
    expect(excerpt).toContain("[TOOL:Bash] echo hi");
  });

  test("truncates long excerpts", () => {
    const longContent = "x".repeat(200);
    const entries = Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      content: `${longContent} message ${i}`,
    }));
    const path = writeTranscript("long.jsonl", entries);
    const excerpt = readExcerpt(path, 500);
    expect(excerpt.length).toBeLessThanOrEqual(550); // some tolerance for truncation marker
    expect(excerpt).toContain("... [truncated] ...");
  });
});

describe("extractTokenUsage", () => {
  test("returns zeros for missing file", () => {
    const result = extractTokenUsage(join(tmpDir, "nope.jsonl"));
    expect(result).toEqual({ input: 0, output: 0 });
  });

  test("sums usage tokens from JSONL entries", () => {
    const path = writeTranscript("tokens.jsonl", [
      { usage: { input_tokens: 100, output_tokens: 50 } },
      { usage: { input_tokens: 200, output_tokens: 75 } },
      { role: "user", content: "no usage here" },
      { usage: { input_tokens: 300, output_tokens: 125 } },
    ]);
    const result = extractTokenUsage(path);
    expect(result.input).toBe(600);
    expect(result.output).toBe(250);
  });

  test("ignores entries without usage field", () => {
    const path = writeTranscript("no-usage.jsonl", [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    const result = extractTokenUsage(path);
    expect(result).toEqual({ input: 0, output: 0 });
  });

  test("handles partial usage objects gracefully", () => {
    const path = writeTranscript("partial.jsonl", [
      { usage: { input_tokens: 100 } },
      { usage: { output_tokens: 50 } },
    ]);
    const result = extractTokenUsage(path);
    expect(result.input).toBe(100);
    expect(result.output).toBe(50);
  });
});
