import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import {
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  classifyIsActionable,
  classifyPromptKind,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
  getLatestPromptIdentity,
  hashPrompt,
  NORMALIZER_VERSION,
  reservePromptIdentity,
} from "../../cli/selftune/normalization.js";
import { CANONICAL_SCHEMA_VERSION } from "../../cli/selftune/types.js";

describe("classifyPromptKind", () => {
  test("classifies user prompts", () => {
    expect(classifyPromptKind("Fix the bug in auth.ts")).toBe("user");
    expect(classifyPromptKind("Build me a landing page")).toBe("user");
  });

  test("classifies tool output", () => {
    expect(classifyPromptKind("<tool_result>some output</tool_result>")).toBe("tool_output");
    expect(classifyPromptKind("<function_result>result</function_result>")).toBe("tool_output");
  });

  test("classifies system instructions", () => {
    expect(classifyPromptKind("[Automated process started]")).toBe("system_instruction");
    expect(classifyPromptKind("[System message]")).toBe("system_instruction");
    expect(classifyPromptKind("[Request interrupted by user]")).toBe("system_instruction");
  });

  test("classifies task notifications", () => {
    expect(classifyPromptKind("<task-notification>task done</task-notification>")).toBe(
      "task_notification",
    );
    expect(classifyPromptKind("Completing task for user")).toBe("task_notification");
  });

  test("classifies teammate messages", () => {
    expect(classifyPromptKind("<teammate-message from='agent-1'>hello</teammate-message>")).toBe(
      "teammate_message",
    );
  });

  test("classifies continuation prompts", () => {
    expect(
      classifyPromptKind(
        "This session is being continued from a previous conversation that ran out of context.",
      ),
    ).toBe("continuation");
    expect(classifyPromptKind("Continue from where you left off.")).toBe("continuation");
  });

  test("classifies meta prompts", () => {
    expect(classifyPromptKind("<system_instruction>you are...</system_instruction>")).toBe("meta");
    expect(classifyPromptKind("<command-name>ls</command-name>")).toBe("meta");
    expect(classifyPromptKind("Tool loaded.")).toBe("meta");
    expect(classifyPromptKind("CONTEXT: some context")).toBe("meta");
  });

  test("handles edge cases", () => {
    expect(classifyPromptKind("")).toBe("unknown");
    expect(classifyPromptKind("   ")).toBe("unknown");
    // @ts-expect-error Testing invalid input
    expect(classifyPromptKind(null)).toBe("unknown");
    // @ts-expect-error Testing invalid input
    expect(classifyPromptKind(42)).toBe("unknown");
  });
});

describe("classifyIsActionable", () => {
  test("returns true for real user prompts", () => {
    expect(classifyIsActionable("Fix the bug in auth.ts")).toBe(true);
    expect(classifyIsActionable("Build me a landing page")).toBe(true);
  });

  test("returns false for system/meta prompts", () => {
    expect(classifyIsActionable("<tool_result>output</tool_result>")).toBe(false);
    expect(classifyIsActionable("[Automated process]")).toBe(false);
    expect(classifyIsActionable("<task-notification>done</task-notification>")).toBe(false);
  });

  test("returns false for empty/short", () => {
    expect(classifyIsActionable("")).toBe(false);
    expect(classifyIsActionable("-")).toBe(false);
  });
});

describe("deriveInvocationMode", () => {
  test("explicit for skill tool call", () => {
    const result = deriveInvocationMode({ has_skill_tool_call: true });
    expect(result.invocation_mode).toBe("explicit");
    expect(result.confidence).toBe(1.0);
  });

  test("implicit for SKILL.md read", () => {
    const result = deriveInvocationMode({ has_skill_md_read: true });
    expect(result.invocation_mode).toBe("implicit");
    expect(result.confidence).toBe(0.7);
  });

  test("inferred for text mention only", () => {
    const result = deriveInvocationMode({ is_text_mention_only: true });
    expect(result.invocation_mode).toBe("inferred");
    expect(result.confidence).toBe(0.4);
  });

  test("repaired for repair overlay", () => {
    const result = deriveInvocationMode({ is_repaired: true });
    expect(result.invocation_mode).toBe("repaired");
    expect(result.confidence).toBe(0.9);
  });

  test("explicit takes priority over implicit", () => {
    const result = deriveInvocationMode({
      has_skill_tool_call: true,
      has_skill_md_read: true,
    });
    expect(result.invocation_mode).toBe("explicit");
    expect(result.confidence).toBe(1.0);
  });

  test("repaired takes priority over explicit", () => {
    const result = deriveInvocationMode({
      is_repaired: true,
      has_skill_tool_call: true,
    });
    expect(result.invocation_mode).toBe("repaired");
    expect(result.confidence).toBe(0.9);
  });
});

describe("ID derivation", () => {
  beforeEach(() => {
    _setTestDb(openDb(":memory:"));
  });
  afterEach(() => {
    _setTestDb(null);
  });

  test("derivePromptId is deterministic", () => {
    expect(derivePromptId("sess-123", 0)).toBe("sess-123:p0");
    expect(derivePromptId("sess-123", 5)).toBe("sess-123:p5");
  });

  test("deriveSkillInvocationId is deterministic", () => {
    expect(deriveSkillInvocationId("sess-123", "Research", 0)).toBe("sess-123:s:Research:0");
  });

  test("hashPrompt is deterministic", () => {
    const h1 = hashPrompt("Fix the bug");
    const h2 = hashPrompt("Fix the bug");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16);
  });

  test("hashPrompt differs for different text", () => {
    expect(hashPrompt("Fix the bug")).not.toBe(hashPrompt("Build the app"));
  });

  test("reservePromptIdentity tracks prompt order within a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-normalization-state-"));
    const statePath = join(dir, "canonical-session-state.json");

    try {
      expect(reservePromptIdentity("sess-123", true, statePath)).toEqual({
        prompt_id: "sess-123:p0",
        prompt_index: 0,
      });
      expect(reservePromptIdentity("sess-123", false, statePath)).toEqual({
        prompt_id: "sess-123:p1",
        prompt_index: 1,
      });
      expect(getLatestPromptIdentity("sess-123", statePath)).toEqual({
        last_prompt_id: "sess-123:p1",
        last_actionable_prompt_id: "sess-123:p0",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers prompt state from a custom canonical log path", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-normalization-recovery-"));
    const statePath = join(dir, "canonical-session-state.json");
    const canonicalLogPath = join(dir, "canonical.jsonl");

    try {
      writeFileSync(
        canonicalLogPath,
        `${[
          JSON.stringify(
            buildCanonicalPrompt({
              platform: "claude_code",
              capture_mode: "hook",
              source_session_kind: "interactive",
              session_id: "sess-456",
              raw_source_ref: { event_type: "UserPromptSubmit" },
              prompt_id: "sess-456:p0",
              occurred_at: "2026-03-10T00:00:00Z",
              prompt_text: "Fix the auth bug",
              prompt_index: 0,
              is_actionable: true,
            }),
          ),
          JSON.stringify(
            buildCanonicalPrompt({
              platform: "claude_code",
              capture_mode: "hook",
              source_session_kind: "interactive",
              session_id: "sess-456",
              raw_source_ref: { event_type: "UserPromptSubmit" },
              prompt_id: "sess-456:p1",
              occurred_at: "2026-03-10T00:00:01Z",
              prompt_text: "<task-notification>done</task-notification>",
              prompt_index: 1,
              is_actionable: false,
            }),
          ),
        ].join("\n")}\n`,
        "utf-8",
      );

      expect(getLatestPromptIdentity("sess-456", statePath, canonicalLogPath)).toEqual({
        last_prompt_id: "sess-456:p1",
        last_actionable_prompt_id: "sess-456:p0",
      });
      expect(reservePromptIdentity("sess-456", true, statePath, canonicalLogPath)).toEqual({
        prompt_id: "sess-456:p2",
        prompt_index: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCanonicalSession", () => {
  test("populates all required base fields", () => {
    const record = buildCanonicalSession({
      platform: "codex",
      capture_mode: "batch_ingest",
      source_session_kind: "replayed",
      session_id: "sess-abc",
      raw_source_ref: { path: "/some/file.jsonl" },
      started_at: "2026-03-10T00:00:00Z",
      model: "gpt-4",
      provider: "openai",
    });

    expect(record.record_kind).toBe("session");
    expect(record.schema_version).toBe(CANONICAL_SCHEMA_VERSION);
    expect(record.normalizer_version).toBe(NORMALIZER_VERSION);
    expect(record.platform).toBe("codex");
    expect(record.capture_mode).toBe("batch_ingest");
    expect(record.source_session_kind).toBe("replayed");
    expect(record.session_id).toBe("sess-abc");
    expect(record.raw_source_ref.path).toBe("/some/file.jsonl");
    expect(record.started_at).toBe("2026-03-10T00:00:00Z");
    expect(record.model).toBe("gpt-4");
    expect(record.provider).toBe("openai");
    expect(record.normalized_at).toBeTruthy();
  });

  test("omits undefined optional fields", () => {
    const record = buildCanonicalSession({
      platform: "claude_code",
      capture_mode: "hook",
      source_session_kind: "interactive",
      session_id: "sess-xyz",
      raw_source_ref: { event_type: "Stop" },
    });

    expect(record.model).toBeUndefined();
    expect(record.branch).toBeUndefined();
    expect(record.session_key).toBeUndefined();
  });
});

describe("buildCanonicalPrompt", () => {
  test("auto-classifies prompt kind and actionability", () => {
    const record = buildCanonicalPrompt({
      platform: "claude_code",
      capture_mode: "hook",
      source_session_kind: "interactive",
      session_id: "sess-1",
      raw_source_ref: { event_type: "UserPromptSubmit" },
      prompt_id: "sess-1:p0",
      occurred_at: "2026-03-10T00:00:00Z",
      prompt_text: "Fix the authentication bug",
    });

    expect(record.record_kind).toBe("prompt");
    expect(record.prompt_kind).toBe("user");
    expect(record.is_actionable).toBe(true);
    expect(record.prompt_hash).toBeTruthy();
    expect(record.prompt_hash?.length).toBe(16);
  });

  test("classifies meta prompts correctly", () => {
    const record = buildCanonicalPrompt({
      platform: "claude_code",
      capture_mode: "hook",
      source_session_kind: "interactive",
      session_id: "sess-1",
      raw_source_ref: {},
      prompt_id: "sess-1:p1",
      occurred_at: "2026-03-10T00:00:00Z",
      prompt_text: "<task-notification>task done</task-notification>",
    });

    expect(record.prompt_kind).toBe("task_notification");
    expect(record.is_actionable).toBe(false);
  });

  test("allows overriding classification", () => {
    const record = buildCanonicalPrompt({
      platform: "codex",
      capture_mode: "wrapper",
      source_session_kind: "interactive",
      session_id: "sess-2",
      raw_source_ref: {},
      prompt_id: "sess-2:p0",
      occurred_at: "2026-03-10T00:00:00Z",
      prompt_text: "do something",
      prompt_kind: "continuation",
      is_actionable: false,
    });

    expect(record.prompt_kind).toBe("continuation");
    expect(record.is_actionable).toBe(false);
  });
});

describe("buildCanonicalSkillInvocation", () => {
  test("populates all required fields", () => {
    const record = buildCanonicalSkillInvocation({
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "replayed",
      session_id: "sess-1",
      raw_source_ref: { path: "/transcript.jsonl" },
      skill_invocation_id: "sess-1:s:Research:0",
      occurred_at: "2026-03-10T00:00:00Z",
      matched_prompt_id: "sess-1:p0",
      skill_name: "Research",
      invocation_mode: "explicit",
      triggered: true,
      confidence: 1.0,
    });

    expect(record.record_kind).toBe("skill_invocation");
    expect(record.skill_name).toBe("Research");
    expect(record.invocation_mode).toBe("explicit");
    expect(record.confidence).toBe(1.0);
    expect(record.triggered).toBe(true);
  });
});

describe("buildCanonicalExecutionFact", () => {
  test("populates tool metrics", () => {
    const record = buildCanonicalExecutionFact({
      platform: "codex",
      capture_mode: "batch_ingest",
      source_session_kind: "replayed",
      session_id: "sess-1",
      raw_source_ref: { path: "/rollout.jsonl" },
      occurred_at: "2026-03-10T00:00:00Z",
      tool_calls_json: { command_execution: 3, file_change: 2 },
      total_tool_calls: 5,
      bash_commands_redacted: ["npm test", "git status"],
      assistant_turns: 4,
      errors_encountered: 1,
      input_tokens: 1500,
      output_tokens: 800,
    });

    expect(record.record_kind).toBe("execution_fact");
    expect(record.total_tool_calls).toBe(5);
    expect(record.assistant_turns).toBe(4);
    expect(record.input_tokens).toBe(1500);
    expect(record.output_tokens).toBe(800);
  });
});
