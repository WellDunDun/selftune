import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSkillName, processToolUse } from "../../cli/selftune/hooks/skill-eval.js";
import type { PostToolUsePayload, SkillUsageRecord } from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-skill-eval-"));
  logPath = join(tmpDir, "skill_usage.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractSkillName", () => {
  test("extracts skill name from SKILL.md path", () => {
    expect(extractSkillName("/mnt/skills/public/pptx/SKILL.md")).toBe("pptx");
    expect(extractSkillName("/skills/pdf/SKILL.md")).toBe("pdf");
    expect(extractSkillName("/a/b/c/my-skill/SKILL.md")).toBe("my-skill");
  });

  test("handles case-insensitive SKILL.md", () => {
    expect(extractSkillName("/skills/test/skill.md")).toBe("test");
    expect(extractSkillName("/skills/test/Skill.Md")).toBe("test");
  });

  test("returns null for non-SKILL.md files", () => {
    expect(extractSkillName("/src/auth.ts")).toBeNull();
    expect(extractSkillName("/README.md")).toBeNull();
    expect(extractSkillName("/skills/pptx/README.md")).toBeNull();
  });
});

describe("skill-eval hook", () => {
  test("ignores non-Read tools", () => {
    const payload: PostToolUsePayload = {
      tool_name: "Write",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-1",
    };

    const result = processToolUse(payload, logPath);
    expect(result).toBeNull();
    expect(readJsonl(logPath)).toEqual([]);
  });

  test("ignores non-SKILL.md reads", () => {
    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/src/utils.ts" },
      session_id: "sess-2",
    };

    const result = processToolUse(payload, logPath);
    expect(result).toBeNull();
    expect(readJsonl(logPath)).toEqual([]);
  });

  test("extracts skill name correctly and writes record with triggered=true when Skill tool was invoked", () => {
    // Create a transcript with a Skill tool invocation so triggered is true
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Create a presentation" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "pptx" } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/mnt/skills/public/pptx/SKILL.md" },
      session_id: "sess-3",
      transcript_path: transcriptPath,
    };

    const result = processToolUse(payload, logPath);
    expect(result).not.toBeNull();
    expect(result?.skill_name).toBe("pptx");
    expect(result?.skill_path).toBe("/mnt/skills/public/pptx/SKILL.md");
    expect(result?.triggered).toBe(true);

    const records = readJsonl<SkillUsageRecord>(logPath);
    expect(records).toHaveLength(1);
    expect(records[0].skill_name).toBe("pptx");
  });

  test("marks triggered=false when SKILL.md is read without Skill tool invocation (browsing)", () => {
    const transcriptPath = join(tmpDir, "transcript-browse.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "Let me look at what skills are available" })}\n`,
    );

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/mnt/skills/public/pptx/SKILL.md" },
      session_id: "sess-3b",
      transcript_path: transcriptPath,
    };

    const result = processToolUse(payload, logPath);
    expect(result).not.toBeNull();
    expect(result?.skill_name).toBe("pptx");
    expect(result?.triggered).toBe(false);
  });

  test("finds user query from transcript", () => {
    const transcriptPath = join(tmpDir, "transcript2.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "First question" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Looking into it..." }],
      }),
      JSON.stringify({ role: "user", content: "Now make a PDF please" }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-4",
      transcript_path: transcriptPath,
    };

    const result = processToolUse(payload, logPath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("Now make a PDF please");
  });

  test("uses fallback when transcript is missing", () => {
    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-5",
      transcript_path: join(tmpDir, "nonexistent.jsonl"),
    };

    const result = processToolUse(payload, logPath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("(query not found)");
  });

  test("writes correct usage record format", () => {
    const transcriptPath = join(tmpDir, "transcript3.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Generate slides" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "pptx" } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const payload: PostToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pptx/SKILL.md" },
      session_id: "sess-6",
      transcript_path: transcriptPath,
    };

    const result = processToolUse(payload, logPath);
    expect(result).not.toBeNull();

    const records = readJsonl<SkillUsageRecord>(logPath);
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record.timestamp).toBeTruthy();
    expect(record.session_id).toBe("sess-6");
    expect(record.skill_name).toBe("pptx");
    expect(record.skill_path).toBe("/skills/pptx/SKILL.md");
    expect(record.query).toBe("Generate slides");
    expect(record.triggered).toBe(true);
  });
});
