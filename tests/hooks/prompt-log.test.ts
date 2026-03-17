import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPrompt } from "../../cli/selftune/hooks/prompt-log.js";
import type {
  PromptSubmitPayload,
  QueryLogRecord,
} from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

let tmpDir: string;
let logPath: string;
let canonicalLogPath: string;
let promptStatePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-prompt-log-"));
  logPath = join(tmpDir, "queries.jsonl");
  canonicalLogPath = join(tmpDir, "canonical.jsonl");
  promptStatePath = join(tmpDir, "canonical-session-state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("prompt-log hook", () => {
  test("skips empty prompts", () => {
    const result = processPrompt({ user_prompt: "" }, logPath, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();
    expect(readJsonl(logPath)).toEqual([]);
  });

  test("skips whitespace-only prompts", () => {
    const result = processPrompt(
      { user_prompt: "   " },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).toBeNull();
    expect(readJsonl(logPath)).toEqual([]);
  });

  test("skips short prompts (less than 4 chars)", () => {
    const result = processPrompt({ user_prompt: "hi" }, logPath, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();

    const result2 = processPrompt(
      { user_prompt: "ok?" },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result2).toBeNull();

    expect(readJsonl(logPath)).toEqual([]);
  });

  test("skips automated prefix messages", () => {
    const prefixes = [
      "<tool_result>some data</tool_result>",
      "<function_result>output</function_result>",
      "[Automated message from system]",
      "[System notification]",
    ];

    for (const prefix of prefixes) {
      const result = processPrompt(
        { user_prompt: prefix },
        logPath,
        canonicalLogPath,
        promptStatePath,
      );
      expect(result).toBeNull();
    }

    expect(readJsonl(logPath)).toEqual([]);
  });

  test("appends valid query and returns record", () => {
    const payload: PromptSubmitPayload = {
      user_prompt: "Help me refactor the authentication module",
      session_id: "sess-123",
    };

    const result = processPrompt(payload, logPath, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("Help me refactor the authentication module");
    expect(result?.session_id).toBe("sess-123");
    expect(result?.timestamp).toBeTruthy();
  });

  test("uses 'unknown' for missing session_id", () => {
    const result = processPrompt(
      { user_prompt: "valid query here" },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("unknown");
  });

  test("trims whitespace from query", () => {
    const result = processPrompt(
      { user_prompt: "  some query with spaces  " },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).not.toBeNull();
    expect(result?.query).toBe("some query with spaces");
  });

  test("handles JSON parse errors gracefully (missing user_prompt field)", () => {
    // Simulate a payload without user_prompt — processPrompt handles it
    const result = processPrompt(
      {} as PromptSubmitPayload,
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).toBeNull();
  });

  test("assigns deterministic prompt ids per session order via state file", () => {
    const r1 = processPrompt(
      { user_prompt: "First real prompt", session_id: "sess-ordered" },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    const r2 = processPrompt(
      { user_prompt: "Second real prompt", session_id: "sess-ordered" },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );

    // Both prompts should be processed successfully
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.query).toBe("First real prompt");
    expect(r2?.query).toBe("Second real prompt");

    // Verify prompt state file tracks the session counter (2 prompts = next index 2)
    const { readFileSync } = require("node:fs");
    const state = JSON.parse(readFileSync(promptStatePath, "utf-8"));
    expect(state.next_prompt_index).toBe(2);
    expect(state.last_prompt_id).toBe("sess-ordered:p1");
  });
});
