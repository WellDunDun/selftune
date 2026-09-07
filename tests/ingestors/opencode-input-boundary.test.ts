import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionsFromJsonFiles,
  readSessionsFromSqlite,
} from "@selftune/harness-opencode/ingestors/opencode-ingest";
import {
  decodeMessageContent,
  parseOpenCodeMessage,
  sourceCount,
  sourceText,
} from "@selftune/harness-opencode/ingestors/opencode-contract";

describe("OpenCode input contracts", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "selftune-opencode-input-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("parses native blocks, serialized blocks, and plain text without unchecked fields", () => {
    expect(decodeMessageContent("plain request")).toEqual([
      { type: "text", text: "plain request" },
    ]);
    expect(
      decodeMessageContent('[null,42,{"type":"text","text":"Valid"},{"type":"text","text":42}]'),
    ).toEqual([{ type: "text", text: "Valid" }, { type: "text" }]);
    expect(
      parseOpenCodeMessage('{"role":"assistant","usage":{"input_tokens":"bad","output_tokens":5}}'),
    ).toMatchObject({ role: "assistant", usage: { output_tokens: 5 } });
    expect(sourceCount("12", -1, 3.5)).toBe(3);
    expect(sourceText(12, { name: "ignored" }, " valid ")).toBe("valid");
  });

  test("legacy files preserve valid messages beside malformed entries", () => {
    const sessions = join(directory, "session");
    mkdirSync(sessions);
    writeFileSync(
      join(sessions, "valid.json"),
      JSON.stringify({
        id: "session",
        created: 1_700_000_000,
        messages: [
          null,
          42,
          { role: "user", content: "Research this question" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "/skills/research/SKILL.md" } },
              { type: "tool_use", name: "Bash", input: { command: 42 } },
              { type: "tool_use", name: "constructor" },
            ],
          },
        ],
      }),
    );
    writeFileSync(join(sessions, "invalid.json"), "null");
    writeFileSync(join(sessions, "invalid-date.json"), '{"created":1e99}');
    const parsed = readSessionsFromJsonFiles(directory, null, new Set(["research"]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      session_id: "session",
      query: "Research this question",
      tool_calls: { Read: 1, Bash: 1, constructor: 1 },
      skills_triggered: ["research"],
      bash_commands: [],
      is_metadata_only: false,
    });
  });

  test("SQLite values are decoded before use and input databases stay unchanged", () => {
    const path = join(directory, "opencode.db");
    using db = new Database(path);
    db.run("CREATE TABLE session(id TEXT, created REAL, directory TEXT)");
    db.run("CREATE TABLE message(id TEXT, session_id TEXT, role TEXT, content TEXT, created REAL)");
    db.run("INSERT INTO session VALUES (?, ?, ?)", ["session", 1e99, "/project"]);
    const content = JSON.stringify([
      null,
      { type: "tool_use", name: "Read", input: { file_path: 42 } },
      { type: "tool_calls", tool_calls: [null, { function: { name: "__proto__" } }] },
    ]);
    db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
      "message",
      "session",
      "assistant",
      content,
      1e99,
    ]);
    const parsed = readSessionsFromSqlite(path, null, new Set());
    expect(parsed).toHaveLength(1);
    expect(Object.entries(parsed[0].tool_calls)).toEqual([
      ["Read", 1],
      ["__proto__", 1],
    ]);
    expect(parsed[0].skills_triggered).toEqual([]);
    expect(parsed[0].source_ended_at).toBeUndefined();
    expect(Number.isFinite(Date.parse(parsed[0].timestamp))).toBe(true);
    expect(db.query<{ content: string }, []>("SELECT content FROM message").get()?.content).toBe(
      content,
    );
  });
});
