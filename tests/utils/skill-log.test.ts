import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillUsageRecord } from "../../cli/selftune/types.js";
import {
  readEffectiveSkillUsageRecords,
  writeRepairedSkillUsageRecords,
} from "../../cli/selftune/utils/skill-log.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "selftune-skill-log-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(path: string, records: SkillUsageRecord[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
}

describe("readEffectiveSkillUsageRecords", () => {
  test("returns repaired records and suppresses raw rows for repaired sessions", () => {
    const rawPath = join(tempDir, "raw.jsonl");
    const repairedPath = join(tempDir, "repaired.jsonl");
    const markerPath = join(tempDir, "sessions.json");

    writeJsonl(rawPath, [
      {
        timestamp: "2026-03-10T10:00:00Z",
        session_id: "session-a",
        skill_name: "Reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "<command-name>/context</command-name>",
        triggered: true,
      },
      {
        timestamp: "2026-03-10T11:00:00Z",
        session_id: "session-b",
        skill_name: "selftune",
        skill_path: "/skills/selftune/SKILL.md",
        query: "fix the dashboard",
        triggered: true,
      },
    ]);

    writeRepairedSkillUsageRecords(
      [
        {
          timestamp: "2026-03-10T10:05:00Z",
          session_id: "session-a",
          skill_name: "Reins",
          skill_path: "/skills/reins/SKILL.md",
          query: "review the reins repo",
          triggered: true,
          source: "claude_code_repair",
        },
      ],
      new Set(["session-a"]),
      repairedPath,
      markerPath,
    );

    expect(readEffectiveSkillUsageRecords(rawPath, repairedPath, markerPath)).toEqual([
      {
        timestamp: "2026-03-10T10:05:00Z",
        session_id: "session-a",
        skill_name: "Reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "review the reins repo",
        triggered: true,
        source: "claude_code_repair",
      },
      {
        timestamp: "2026-03-10T11:00:00Z",
        session_id: "session-b",
        skill_name: "selftune",
        skill_path: "/skills/selftune/SKILL.md",
        query: "fix the dashboard",
        triggered: true,
      },
    ]);
  });

  test("suppresses raw records even when a repaired session has zero rebuilt skill rows", () => {
    const rawPath = join(tempDir, "raw-zero.jsonl");
    const repairedPath = join(tempDir, "repaired-zero.jsonl");
    const markerPath = join(tempDir, "sessions-zero.json");

    writeJsonl(rawPath, [
      {
        timestamp: "2026-03-10T10:00:00Z",
        session_id: "session-a",
        skill_name: "Reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "<command-name>/context</command-name>",
        triggered: true,
      },
    ]);

    writeRepairedSkillUsageRecords([], new Set(["session-a"]), repairedPath, markerPath);

    expect(readEffectiveSkillUsageRecords(rawPath, repairedPath, markerPath)).toEqual([]);
  });
});
