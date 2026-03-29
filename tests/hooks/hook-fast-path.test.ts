import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// readStdinWithPreview unit tests
//
// Note: readStdinWithPreview() reads from Bun.stdin which cannot be easily
// mocked in unit tests. Instead we test the preview/keyword detection logic
// that the hooks rely on — the `.includes()` fast-path checks.
// ---------------------------------------------------------------------------

describe("hook fast-path keyword detection", () => {
  // Simulated payloads (what readStdinWithPreview would return)

  const userPromptPayload = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-abc123",
    prompt: "show me the dashboard",
  });

  const postToolUseReadPayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "sess-abc123",
    tool_name: "Read",
    tool_input: { file_path: "/home/user/.claude/skills/selftune/SKILL.md" },
  });

  const postToolUseSkillPayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "sess-abc123",
    tool_name: "Skill",
    tool_input: { skill: "selftune" },
  });

  const postToolUseBashPayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "sess-abc123",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
  });

  const preToolUsePayload = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "sess-abc123",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  });

  const stopPayload = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "sess-abc123",
    transcript_path: "/tmp/transcript.jsonl",
  });

  // --- prompt-log fast-path checks ---

  describe("prompt-log fast-path", () => {
    it("matches UserPromptSubmit events", () => {
      const preview = userPromptPayload.slice(0, 4096);
      expect(preview.includes('"UserPromptSubmit"')).toBe(true);
    });

    it("rejects PostToolUse events", () => {
      const preview = postToolUseReadPayload.slice(0, 4096);
      expect(preview.includes('"UserPromptSubmit"')).toBe(false);
    });

    it("rejects PreToolUse events", () => {
      const preview = preToolUsePayload.slice(0, 4096);
      expect(preview.includes('"UserPromptSubmit"')).toBe(false);
    });

    it("rejects Stop events", () => {
      const preview = stopPayload.slice(0, 4096);
      expect(preview.includes('"UserPromptSubmit"')).toBe(false);
    });
  });

  // --- skill-eval fast-path checks ---

  describe("skill-eval fast-path", () => {
    it("matches PostToolUse + Read combination", () => {
      const preview = postToolUseReadPayload.slice(0, 4096);
      expect(preview.includes('"PostToolUse"')).toBe(true);
      expect(preview.includes('"Read"') || preview.includes('"Skill"')).toBe(true);
    });

    it("matches PostToolUse + Skill combination", () => {
      const preview = postToolUseSkillPayload.slice(0, 4096);
      expect(preview.includes('"PostToolUse"')).toBe(true);
      expect(preview.includes('"Read"') || preview.includes('"Skill"')).toBe(true);
    });

    it("rejects PostToolUse + Bash (no Read or Skill)", () => {
      const preview = postToolUseBashPayload.slice(0, 4096);
      expect(preview.includes('"PostToolUse"')).toBe(true);
      // Secondary check should reject: neither Read nor Skill present
      expect(preview.includes('"Read"') || preview.includes('"Skill"')).toBe(false);
    });

    it("rejects UserPromptSubmit events entirely", () => {
      const preview = userPromptPayload.slice(0, 4096);
      expect(preview.includes('"PostToolUse"')).toBe(false);
    });

    it("rejects Stop events entirely", () => {
      const preview = stopPayload.slice(0, 4096);
      expect(preview.includes('"PostToolUse"')).toBe(false);
    });
  });

  // --- preview window edge cases ---

  describe("preview window edge cases", () => {
    it("handles payload shorter than preview window", () => {
      const tiny = '{"hook_event_name":"UserPromptSubmit"}';
      const preview = tiny.slice(0, 4096);
      expect(preview).toBe(tiny);
      expect(preview.includes('"UserPromptSubmit"')).toBe(true);
    });

    it("handles empty payload", () => {
      const empty = "";
      const preview = empty.slice(0, 4096);
      expect(preview).toBe("");
      expect(preview.includes('"UserPromptSubmit"')).toBe(false);
      expect(preview.includes('"PostToolUse"')).toBe(false);
    });

    it("handles keyword at boundary of preview window", () => {
      // Build a payload where the event name is near the 4096 boundary
      const padding = "x".repeat(4070);
      const late = `{"padding":"${padding}","hook_event_name":"PostToolUse"}`;
      const smallPreview = late.slice(0, 4096);

      // The prefix '{"padding":"' is 13 bytes, then 4070 x's, then '","hook_event_name":"PostToolUse"}'
      // Total offset to '"PostToolUse"' = 13 + 4070 + 22 = 4105, which exceeds the 4096 preview
      // So the keyword should NOT appear in the truncated preview
      expect(smallPreview.includes('"PostToolUse"')).toBe(false);

      // But the full payload does contain it — the hook falls through to full parse (safe)
      expect(late.includes('"PostToolUse"')).toBe(true);
    });

    it("custom preview size works correctly", () => {
      const payload = '{"hook_event_name":"UserPromptSubmit","data":"lots of data here"}';
      const tinyPreview = payload.slice(0, 20);
      // With only 20 bytes, the keyword won't be found — that's the expected safe fallback
      expect(tinyPreview.includes('"UserPromptSubmit"')).toBe(false);
      // Full text still has it
      expect(payload.includes('"UserPromptSubmit"')).toBe(true);
    });
  });
});
