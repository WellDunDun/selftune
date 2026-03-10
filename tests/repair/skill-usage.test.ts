import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildSkillUsageFromTranscripts } from "../../cli/selftune/repair/skill-usage.js";
import type { SkillUsageRecord } from "../../cli/selftune/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "selftune-repair-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(tempDir, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  return path;
}

describe("rebuildSkillUsageFromTranscripts", () => {
  test("rebuilds explicit skill invocations from actionable user prompts", () => {
    const transcript = writeTranscript("session-a.jsonl", [
      { role: "user", content: "review the reins repo" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "Reins" } }],
        timestamp: "2026-03-10T10:00:00Z",
      },
    ]);

    const rawRecords: SkillUsageRecord[] = [
      {
        timestamp: "2026-03-09T10:00:00Z",
        session_id: "old",
        skill_name: "Reins",
        skill_path: "/tmp/test-skills/reins/SKILL.md",
        query: "<command-name>/context</command-name>",
        triggered: true,
      },
    ];

    const result = rebuildSkillUsageFromTranscripts([transcript], rawRecords);

    expect([...result.repairedSessionIds]).toEqual(["session-a"]);
    expect(result.repairedRecords).toEqual([
      {
        timestamp: "2026-03-10T10:00:00Z",
        session_id: "session-a",
        skill_name: "Reins",
        skill_path: "/tmp/test-skills/reins/SKILL.md",
        query: "review the reins repo",
        triggered: true,
        source: "claude_code_repair",
      },
    ]);
  });

  test("skips meta envelopes and dedupes repeated invocations for the same prompt", () => {
    const transcript = writeTranscript("session-b.jsonl", [
      { role: "user", content: "<task-notification>\n<task-id>123</task-id>" },
      { role: "user", content: "fix the dashboard" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Skill", input: { skill: "selftune" } },
          { type: "tool_use", name: "Skill", input: { skill: "selftune" } },
        ],
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts([transcript], []);

    expect(result.repairedRecords).toHaveLength(1);
    expect(result.repairedRecords[0].query).toBe("fix the dashboard");
    expect(result.repairedRecords[0].skill_path).toBe("(repaired:selftune)");
  });
});
