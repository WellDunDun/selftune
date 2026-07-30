import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureSkillEditPost,
  captureSkillEditPre,
} from "@selftune/harness-claude-code/hooks/skill-edit-capture";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-skill-edit-capture-"));
  const skill = join(root, "release-checklist", "SKILL.md");
  const stateDir = join(root, "state");
  const artifactPath = join(root, "captures.jsonl");
  mkdirSync(join(root, "release-checklist"), { recursive: true });
  writeFileSync(skill, "# Release checklist\n\nVerify status.\n");
  return { root, skill, stateDir, artifactPath };
}

test("captures a changed whole-package revision without durable contents or paths", () => {
  const { root, skill, stateDir, artifactPath } = fixture();
  try {
    const pre = {
      hook_event_name: "PreToolUse" as const,
      session_id: "session-1",
      tool_name: "Edit",
      tool_use_id: "tool-1",
      tool_input: { file_path: skill },
    };
    expect(captureSkillEditPre(pre, { stateDir, artifactPath })).toBe(true);
    writeFileSync(skill, "# Release checklist\n\nVerify the live portal status.\n");
    const artifact = captureSkillEditPost(
      { ...pre, hook_event_name: "PostToolUse", tool_response: { success: true } },
      { stateDir, artifactPath },
    );

    expect(artifact).toMatchObject({ status: "captured", session_id: "session-1" });
    expect(artifact?.pre_revision).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact?.post_revision).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact?.pre_revision).not.toBe(artifact?.post_revision);
    const durable = readFileSync(artifactPath, "utf8");
    expect(durable).not.toContain(skill);
    expect(durable).not.toContain("Verify the live portal status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores non-SKILL targets and records failed or unchanged edits without promotion", () => {
  const { root, skill, stateDir, artifactPath } = fixture();
  try {
    const plain = {
      session_id: "session-1",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.md") },
    };
    expect(captureSkillEditPre(plain, { stateDir, artifactPath })).toBe(false);
    expect(captureSkillEditPost(plain, { stateDir, artifactPath })).toBeNull();

    const unchanged = { ...plain, tool_use_id: "unchanged", tool_input: { file_path: skill } };
    captureSkillEditPre(unchanged, { stateDir, artifactPath });
    expect(captureSkillEditPost(unchanged, { stateDir, artifactPath })?.status).toBe("unchanged");

    const failed = { ...unchanged, tool_use_id: "failed" };
    captureSkillEditPre(failed, { stateDir, artifactPath });
    expect(
      captureSkillEditPost(
        { ...failed, tool_response: { is_error: true } },
        { stateDir, artifactPath },
      )?.status,
    ).toBe("failed");

    const otherSkill = join(root, "other", "SKILL.md");
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(otherSkill, "# Other\n");
    const mismatched = { ...unchanged, tool_use_id: "mismatched" };
    captureSkillEditPre(mismatched, { stateDir, artifactPath });
    expect(
      captureSkillEditPost(
        { ...mismatched, tool_input: { file_path: otherSkill } },
        { stateDir, artifactPath },
      )?.status,
    ).toBe("failed");
    const records = readFileSync(artifactPath, "utf8");
    expect(records).not.toContain('"status":"captured"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
