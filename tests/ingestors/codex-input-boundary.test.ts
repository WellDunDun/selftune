import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRolloutFile } from "@selftune/harness-codex/ingestors/codex-rollout";

let tmpDir = "";
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-codex-boundary-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createRolloutFile(
  root: string,
  year: string,
  month: string,
  day: string,
  name: string,
  content: string,
): string {
  const directory = join(root, "sessions", year, month, day);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("retains valid evidence beside malformed fields and prototype-colliding tool names", () => {
  const rollout = createRolloutFile(
    tmpDir,
    "2026",
    "09",
    "05",
    "rollout-boundary.jsonl",
    [
      "null",
      "[]",
      JSON.stringify({
        type: "session_meta",
        payload: { id: "boundary", cwd: 42, instructions: {} },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [null, 42, { text: {} }, { text: "use Example skill" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", name: "constructor", arguments: {} },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "custom_tool_call", name: "__proto__", input: 42 },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: "100", output_tokens: 7 },
      }),
      ...[0, 1, "0", null, false, {}].map((exit_code) =>
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: {}, exit_code },
        }),
      ),
    ].join("\n"),
  );
  const result = parseRolloutFile(rollout, new Set(["Example"]));
  expect(result?.session_id).toBe("boundary");
  expect(result?.query).toBe("use Example skill");
  expect(result?.skills_invoked).toEqual(["Example"]);
  expect(result?.input_tokens).toBe(0);
  expect(result?.output_tokens).toBe(7);
  expect(result?.tool_calls).toEqual(
    Object.fromEntries([
      ["constructor", 1],
      ["__proto__", 1],
      ["command_execution", 6],
    ]),
  );
  expect(result?.total_tool_calls).toBe(8);
  expect(result?.errors_encountered).toBe(5);
  expect(result?.bash_commands).toEqual([]);
});
