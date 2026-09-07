import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureSkillEditPost,
  captureSkillEditPre,
  runSkillEditCaptureHook,
} from "@selftune/harness-claude-code/hooks/skill-edit-capture";

test("capture entry point fails open on malformed skill edit payloads", async () => {
  for (const payload of [
    null,
    [],
    { tool_input: { file_path: "SKILL.md" } },
    {
      hook_event_name: "PreToolUse",
      session_id: "session",
      tool_name: "Edit",
      tool_input: { file_path: 42, content: "SKILL.md" },
    },
  ]) {
    expect(await runSkillEditCaptureHook(JSON.stringify(payload))).toEqual({
      stdout: "",
      stderr: "",
      exit_code: 0,
    });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-skill-edit-capture-"));
  const skill = join(root, "release-checklist", "SKILL.md");
  const stateDir = join(root, "state");
  const artifactPath = join(root, "captures.jsonl");
  mkdirSync(join(root, "release-checklist"), { recursive: true });
  writeFileSync(skill, "# Release checklist\n\nVerify status.\n");
  return { root, skill, stateDir, artifactPath };
}

test("corrupt pending state cannot produce capture evidence and a new edit recovers", () => {
  const { root, skill, stateDir, artifactPath } = fixture();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "skill-edit-capture-session-1.json"),
      JSON.stringify({
        session_id: "session-1",
        created_at: "2026-09-06T00:00:00Z",
        data: {
          pending: { "tool-1": { target_digest: 42, pre_revision: [], pre_captured_at: null } },
        },
      }),
    );
    const payload = {
      session_id: "session-1",
      tool_name: "Edit",
      tool_use_id: "tool-1",
      tool_input: { file_path: skill },
    };
    expect(captureSkillEditPost(payload, { stateDir, artifactPath })).toBeNull();
    expect(existsSync(artifactPath)).toBe(false);
    expect(captureSkillEditPre(payload, { stateDir, artifactPath })).toBe(true);
    expect(captureSkillEditPost(payload, { stateDir, artifactPath })?.status).toBe("unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
