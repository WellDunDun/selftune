import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePiSession, readPiSessionHeader } from "@selftune/harness-pi/ingestors/pi-ingest";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "selftune-pi-boundary-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function fixture(lines: string[]): string {
  const path = join(directory, "session.jsonl");
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

const header = JSON.stringify({
  type: "session",
  id: "pi-boundary",
  timestamp: "2026-09-05T10:00:00.000Z",
});

test("keeps valid message fields beside malformed content and metrics", () => {
  const path = fixture([
    header,
    "null",
    "[]",
    "{bad-json",
    JSON.stringify({
      type: "message",
      id: "a",
      parentId: null,
      message: {
        role: "user",
        content: [
          null,
          42,
          { type: "text", text: {} },
          { type: "text", text: "Review the project" },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "b",
      parentId: "a",
      message: {
        role: "assistant",
        provider: {},
        model: "valid-model",
        usage: { input: "20", output: 7 },
        content: [
          { type: "toolCall", name: "constructor", arguments: {} },
          { type: "toolUse", name: "__proto__", input: null },
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "/skills/Example/SKILL.md", command: 42 },
          },
          { type: "toolCall", name: "bash", arguments: { command: {} } },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "bad",
      parentId: 42,
      message: { role: "user", content: "Do not turn a broken edge into a new root" },
    }),
    JSON.stringify({
      type: "message",
      id: "c",
      parentId: "b",
      message: { role: "toolResult", content: { type: "text", text: "failed", isError: true } },
    }),
  ]);
  const parsed = parsePiSession(path, new Set(["Example"]));
  expect(parsed.query).toBe("Review the project");
  expect(parsed.model).toBe("valid-model");
  expect(parsed.provider).toBeUndefined();
  expect(parsed.input_tokens).toBeUndefined();
  expect(parsed.output_tokens).toBe(7);
  expect(parsed.total_tool_calls).toBe(4);
  expect(parsed.tool_calls).toEqual(
    Object.fromEntries([
      ["constructor", 1],
      ["__proto__", 1],
      ["read", 1],
      ["bash", 1],
    ]),
  );
  expect(parsed.skills_triggered).toEqual(["Example"]);
  expect(parsed.errors_encountered).toBe(1);
  expect(parsed.bash_commands).toEqual([]);
});

test("stops cyclic trees without inventing a complete timing interval", () => {
  const path = fixture([
    header,
    JSON.stringify({
      type: "message",
      id: "a",
      parentId: "b",
      timestamp: "2026-09-05T10:01:00.000Z",
      message: { role: "user", content: "Inspect this cycle" },
    }),
    JSON.stringify({
      type: "message",
      id: "b",
      parentId: "a",
      timestamp: "2026-09-05T10:02:00.000Z",
      message: { role: "assistant", content: "done" },
    }),
  ]);
  const parsed = parsePiSession(path, new Set());
  expect(parsed.query).toBe("Inspect this cycle");
  expect(parsed.assistant_turns).toBe(1);
  expect(parsed.ended_at).toBeUndefined();
});

test("returns empty results for malformed headers and keeps discovery fallback ids", () => {
  for (const line of ["null", "[]", "{bad-json", '{"type":"message"}']) {
    const path = fixture([line]);
    expect(readPiSessionHeader(path, "fallback")).toBeNull();
    expect(parsePiSession(path, new Set()).session_id).toBe("");
  }
  const path = fixture([JSON.stringify({ type: "session", id: 42, timestamp: {} })]);
  expect(readPiSessionHeader(path, "fallback")).toEqual({
    sessionId: "fallback",
    timestamp: undefined,
  });
});
