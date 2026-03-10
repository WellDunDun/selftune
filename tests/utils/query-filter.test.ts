import { describe, expect, test } from "bun:test";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
  isActionableQueryText,
  isActionableSkillUsageRecord,
} from "../../cli/selftune/utils/query-filter.js";
import type { QueryLogRecord, SkillUsageRecord } from "../../cli/selftune/types.js";

describe("isActionableQueryText", () => {
  test("accepts normal user queries", () => {
    expect(isActionableQueryText("build the dashboard")).toBe(true);
  });

  test("rejects system and local command payloads", () => {
    expect(isActionableQueryText("<system_instruction> hidden prompt")).toBe(false);
    expect(isActionableQueryText("<local-command-stdout> tool output")).toBe(false);
    expect(isActionableQueryText("<command-name>/context</command-name>")).toBe(false);
    expect(isActionableQueryText("<task-notification>\n<task-id>123</task-id>")).toBe(false);
    expect(isActionableQueryText("<teammate-message teammate_id=\"x\">done</teammate-message>")).toBe(
      false,
    );
    expect(isActionableQueryText("CONTEXT:\nAssistant: recap")).toBe(false);
    expect(
      isActionableQueryText(
        "This session is being continued from a previous conversation that ran out of context.",
      ),
    ).toBe(false);
  });

  test("rejects empty and non-string values", () => {
    expect(isActionableQueryText("   ")).toBe(false);
    expect(isActionableQueryText("-")).toBe(false);
    expect(isActionableQueryText(null as unknown as string)).toBe(false);
  });
});

describe("filterActionableQueryRecords", () => {
  test("skips malformed rows and non-user payloads", () => {
    const records = [
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        query: "real user query",
      },
      {
        timestamp: "2026-03-01T00:01:00Z",
        session_id: "s2",
        query: "<system_instruction> hidden prompt",
      },
      {
        timestamp: "2026-03-01T00:02:00Z",
        session_id: "s3",
      } as unknown as QueryLogRecord,
      null as unknown as QueryLogRecord,
    ];

    expect(filterActionableQueryRecords(records as QueryLogRecord[])).toEqual([
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        query: "real user query",
      },
    ]);
  });
});

describe("isActionableSkillUsageRecord", () => {
  test("accepts real skill usage rows", () => {
    expect(
      isActionableSkillUsageRecord({
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "audit the reins repo",
        triggered: true,
      }),
    ).toBe(true);
  });

  test("rejects missing-query and meta-query rows", () => {
    expect(
      isActionableSkillUsageRecord({
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "(query not found)",
        triggered: true,
      }),
    ).toBe(false);

    expect(
      isActionableSkillUsageRecord({
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "<local-command-stdout> tool output",
        triggered: true,
      }),
    ).toBe(false);
  });
});

describe("filterActionableSkillUsageRecords", () => {
  test("keeps only trustworthy rows", () => {
    const records: SkillUsageRecord[] = [
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "audit the reins repo",
        triggered: true,
      },
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s2",
        skill_name: "reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "<system_instruction> hidden prompt",
        triggered: true,
      },
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s3",
        skill_name: "reins",
        skill_path: "/skills/reins/SKILL.md",
        query: "(query not found)",
        triggered: false,
      },
    ];

    expect(filterActionableSkillUsageRecords(records)).toEqual([records[0]]);
  });
});
