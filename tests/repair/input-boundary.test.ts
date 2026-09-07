import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rebuildSkillUsageFromTranscripts } from "@selftune/orchestration/repair/skill-usage";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "selftune-repair-boundary-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test("does not mark an unreadable transcript body as repaired", () => {
  const path = join(directory, "broken.jsonl");
  writeFileSync(path, 'null\n[]\n{bad-json\n{"message":42}\n', "utf8");
  const result = rebuildSkillUsageFromTranscripts([path], []);
  expect(result.repairedSessionIds.size).toBe(0);
  expect(result.repairedRecords).toEqual([]);
});

test("preserves skill calls and launcher paths beside malformed content", () => {
  const path = join(directory, "valid-siblings.jsonl");
  const launcher = join(directory, "skills", "Example");
  writeFileSync(
    path,
    [
      "null",
      "[]",
      JSON.stringify({
        role: "user",
        content: [
          null,
          42,
          { type: "text", text: {} },
          { type: "text", text: "Use Example skill" },
        ],
      }),
      JSON.stringify({
        role: "assistant",
        content: [
          null,
          { type: "tool_use", name: "Read", input: { file_path: 42 } },
          { type: "tool_use", id: "call-1", name: "Skill", input: { skill: "Example", name: {} } },
        ],
      }),
      JSON.stringify({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [
              null,
              false,
              { text: {} },
              { content: `Base directory for this skill: ${launcher}` },
            ],
          },
        ],
      }),
    ].join("\n"),
    "utf8",
  );
  const result = rebuildSkillUsageFromTranscripts([path], [], directory, join(directory, "codex"));
  expect([...result.repairedSessionIds]).toEqual(["valid-siblings"]);
  expect(result.repairedRecords).toHaveLength(1);
  expect(result.repairedRecords[0]).toMatchObject({
    skill_name: "Example",
    skill_path: join(launcher, "SKILL.md"),
    query: "Use Example skill",
    triggered: true,
    skill_path_resolution_source: "launcher_base_dir",
  });
});
