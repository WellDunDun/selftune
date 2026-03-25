import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractSkillNameFromPath,
  isSkillMdWrite,
  processPreToolUse,
} from "../../cli/selftune/hooks/skill-change-guard.js";
import type { PreToolUsePayload } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-skill-guard-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

describe("isSkillMdWrite", () => {
  test("detects Write to SKILL.md", () => {
    expect(isSkillMdWrite("Write", "/skills/pdf/SKILL.md")).toBe(true);
  });

  test("detects Edit to SKILL.md", () => {
    expect(isSkillMdWrite("Edit", "/mnt/skills/public/pptx/SKILL.md")).toBe(true);
  });

  test("detects case-insensitive SKILL.md", () => {
    expect(isSkillMdWrite("Write", "/skills/test/skill.md")).toBe(true);
    expect(isSkillMdWrite("Edit", "/skills/test/Skill.Md")).toBe(true);
  });

  test("ignores non-Write/Edit tools", () => {
    expect(isSkillMdWrite("Read", "/skills/pdf/SKILL.md")).toBe(false);
    expect(isSkillMdWrite("Bash", "/skills/pdf/SKILL.md")).toBe(false);
    expect(isSkillMdWrite("Grep", "/skills/pdf/SKILL.md")).toBe(false);
  });

  test("ignores non-SKILL.md files", () => {
    expect(isSkillMdWrite("Write", "/skills/pdf/README.md")).toBe(false);
    expect(isSkillMdWrite("Write", "/src/auth.ts")).toBe(false);
    expect(isSkillMdWrite("Edit", "/skills/pdf/config.json")).toBe(false);
  });
});

describe("extractSkillNameFromPath", () => {
  test("extracts skill name from SKILL.md path", () => {
    expect(extractSkillNameFromPath("/mnt/skills/public/pptx/SKILL.md")).toBe("pptx");
    expect(extractSkillNameFromPath("/skills/pdf/SKILL.md")).toBe("pdf");
    expect(extractSkillNameFromPath("/a/b/my-skill/SKILL.md")).toBe("my-skill");
  });

  test("returns unknown for root-level SKILL.md", () => {
    expect(extractSkillNameFromPath("/SKILL.md")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Hook processing
// ---------------------------------------------------------------------------

describe("skill-change-guard hook", () => {
  test("returns suggestion for Write to SKILL.md", () => {
    const payload: PreToolUsePayload = {
      tool_name: "Write",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-1",
    };

    const statePath = join(tmpDir, "state.json");
    const result = processPreToolUse(payload, statePath);
    expect(result).not.toBeNull();
    expect(result).toContain("selftune watch");
    expect(result).toContain("pdf");
  });

  test("returns suggestion for Edit to SKILL.md", () => {
    const payload: PreToolUsePayload = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/mnt/skills/public/pptx/SKILL.md",
        old_string: "x",
        new_string: "y",
      },
      session_id: "sess-2",
    };

    const statePath = join(tmpDir, "state.json");
    const result = processPreToolUse(payload, statePath);
    expect(result).not.toBeNull();
    expect(result).toContain("selftune watch");
    expect(result).toContain("pptx");
  });

  test("returns null for non-SKILL.md writes", () => {
    const payload: PreToolUsePayload = {
      tool_name: "Write",
      tool_input: { file_path: "/src/auth.ts" },
      session_id: "sess-3",
    };

    const statePath = join(tmpDir, "state.json");
    const result = processPreToolUse(payload, statePath);
    expect(result).toBeNull();
  });

  test("returns null for Read tool on SKILL.md", () => {
    const payload: PreToolUsePayload = {
      tool_name: "Read",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-4",
    };

    const statePath = join(tmpDir, "state.json");
    const result = processPreToolUse(payload, statePath);
    expect(result).toBeNull();
  });

  test("does not repeat suggestion for same skill in same session", () => {
    const statePath = join(tmpDir, "state.json");

    const payload: PreToolUsePayload = {
      tool_name: "Write",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-5",
    };

    // First call should return suggestion
    const first = processPreToolUse(payload, statePath);
    expect(first).not.toBeNull();

    // Second call should return null (already suggested)
    const second = processPreToolUse(payload, statePath);
    expect(second).toBeNull();
  });

  test("handles missing file_path gracefully", () => {
    const payload: PreToolUsePayload = {
      tool_name: "Write",
      tool_input: {},
      session_id: "sess-6",
    };

    const statePath = join(tmpDir, "state.json");
    const result = processPreToolUse(payload, statePath);
    expect(result).toBeNull();
  });

  test("handles missing session_id gracefully", () => {
    const payload: PreToolUsePayload = {
      tool_name: "Write",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
    };

    const statePath = join(tmpDir, "state.json");
    const result = processPreToolUse(payload, statePath);
    expect(result).not.toBeNull();
    expect(result).toContain("selftune watch");
  });
});
