import { describe, expect, test } from "bun:test";
import type { QueryLogRecord, SkillUsageRecord } from "../../cli/selftune/types.js";
import {
  extractActionableQueryText,
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
  isActionableQueryText,
  isActionableSkillUsageRecord,
} from "../../cli/selftune/utils/query-filter.js";

describe("isActionableQueryText", () => {
  test("accepts normal user queries", () => {
    expect(isActionableQueryText("build the dashboard")).toBe(true);
  });

  test("rejects system and local command payloads", () => {
    expect(isActionableQueryText("<system_instruction> hidden prompt")).toBe(false);
    expect(isActionableQueryText("<local-command-stdout> tool output")).toBe(false);
    expect(isActionableQueryText("<command-name>/context</command-name>")).toBe(false);
    expect(isActionableQueryText("<task-notification>\n<task-id>123</task-id>")).toBe(false);
    expect(isActionableQueryText('<teammate-message teammate_id="x">done</teammate-message>')).toBe(
      false,
    );
    expect(isActionableQueryText("CONTEXT:\nAssistant: recap")).toBe(false);
    expect(
      isActionableQueryText(
        "This session is being continued from a previous conversation that ran out of context.",
      ),
    ).toBe(false);
  });

  test("rejects wrapper/system-reminder and deferred-tools noise", () => {
    // Pure system-reminder block (no user content after)
    expect(
      isActionableQueryText("<system-reminder>\nPAI Dynamic Context loaded\n</system-reminder>"),
    ).toBe(false);

    // Available deferred tools listing
    expect(
      isActionableQueryText(
        "<available-deferred-tools>\nNotebookEdit\nWebFetch\n</available-deferred-tools>",
      ),
    ).toBe(false);

    // Fast mode info block
    expect(
      isActionableQueryText("<fast_mode_info>\nFast mode uses the same model\n</fast_mode_info>"),
    ).toBe(false);

    // Skill listing injection
    expect(
      isActionableQueryText("The following skills are available for use with the Skill tool:"),
    ).toBe(false);
  });

  test("rejects hook callback output lines", () => {
    expect(
      isActionableQueryText("SessionStart:startup hook success: <system-reminder>PAI loaded"),
    ).toBe(false);
    expect(isActionableQueryText("UserPromptSubmit:Callback hook success: Success")).toBe(false);
    expect(isActionableQueryText("PreToolUse:Read hook returned: OK")).toBe(false);
    expect(isActionableQueryText("PostToolUse:Bash hook returned: OK")).toBe(false);
    expect(isActionableQueryText("Stop:session cleanup completed")).toBe(false);
    expect(isActionableQueryText("Stop:Callback hook success: OK")).toBe(false);
    expect(isActionableQueryText("Stop:hook finalize done")).toBe(false);
  });

  test("preserves user prompts starting with Stop:", () => {
    expect(isActionableQueryText("Stop: using the old API and migrate this")).toBe(true);
    expect(isActionableQueryText("Stop the deployment pipeline")).toBe(true);
  });

  test("rejects injected git context blocks", () => {
    expect(
      isActionableQueryText("gitStatus: This is the git status at the start of the conversation."),
    ).toBe(false);
  });

  test("rejects empty and non-string values", () => {
    expect(isActionableQueryText("   ")).toBe(false);
    expect(isActionableQueryText("-")).toBe(false);
    expect(isActionableQueryText(null as unknown as string)).toBe(false);
  });

  test("accepts conductor-wrapped prompts when user content follows the wrapper", () => {
    const wrapped = "<system_instruction>hidden prompt</system_instruction>\n\nfix the dashboard";
    expect(isActionableQueryText(wrapped)).toBe(true);
    expect(extractActionableQueryText(wrapped)).toBe("fix the dashboard");
  });

  test("strips system-reminder wrappers to find real user content", () => {
    const wrapped =
      "<system-reminder>\nPAI Dynamic Context loaded\n</system-reminder>\n\nfix the bug";
    expect(isActionableQueryText(wrapped)).toBe(true);
    expect(extractActionableQueryText(wrapped)).toBe("fix the bug");
  });

  test("strips multiple stacked wrapper tags to find real user content", () => {
    const wrapped =
      "<system-reminder>context</system-reminder>\n" +
      "<available-deferred-tools>tools list</available-deferred-tools>\n\n" +
      "deploy to production";
    expect(isActionableQueryText(wrapped)).toBe(true);
    expect(extractActionableQueryText(wrapped)).toBe("deploy to production");
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

  test("normalizes wrapped prompts to the underlying user query", () => {
    const records: QueryLogRecord[] = [
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        query: "<system_instruction>hidden</system_instruction>\n\nfix the dashboard",
      },
    ];

    expect(filterActionableQueryRecords(records)).toEqual([
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        query: "fix the dashboard",
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

  test("accepts wrapped skill usage rows when they contain a real user query", () => {
    expect(
      isActionableSkillUsageRecord({
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "selftune",
        skill_path: "/skills/selftune/SKILL.md",
        query:
          "<system_instruction>hidden prompt</system_instruction>\n\nmy claude code isn't working",
        triggered: true,
      }),
    ).toBe(true);
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

  test("normalizes wrapped skill usage rows to the underlying user query", () => {
    const records: SkillUsageRecord[] = [
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "selftune",
        skill_path: "/skills/selftune/SKILL.md",
        query:
          "<system_instruction>hidden prompt</system_instruction>\n\nmy claude code isn't working",
        triggered: true,
        source: "codex_rollout",
      },
    ];

    expect(filterActionableSkillUsageRecords(records)).toEqual([
      {
        timestamp: "2026-03-01T00:00:00Z",
        session_id: "s1",
        skill_name: "selftune",
        skill_path: "/skills/selftune/SKILL.md",
        query: "my claude code isn't working",
        triggered: true,
        source: "codex_rollout",
      },
    ]);
  });
});
