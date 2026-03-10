import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPrompt } from "../../cli/selftune/hooks/prompt-log.js";
import type {
  CanonicalPromptRecord,
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

  test("appends valid query to JSONL", () => {
    const payload: PromptSubmitPayload = {
      user_prompt: "Help me refactor the authentication module",
      session_id: "sess-123",
    };

    const result = processPrompt(payload, logPath, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("Help me refactor the authentication module");
    expect(result?.session_id).toBe("sess-123");
    expect(result?.timestamp).toBeTruthy();

    const records = readJsonl<QueryLogRecord>(logPath);
    expect(records).toHaveLength(1);
    expect(records[0].query).toBe("Help me refactor the authentication module");
    expect(records[0].session_id).toBe("sess-123");

    // Verify canonical prompt record was also emitted
    const canonicalRecords = readJsonl<CanonicalPromptRecord>(canonicalLogPath);
    expect(canonicalRecords).toHaveLength(1);
    expect(canonicalRecords[0].prompt_id).toBe("sess-123:p0");
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

  test("assigns deterministic prompt ids per session order", () => {
    processPrompt(
      { user_prompt: "First real prompt", session_id: "sess-ordered" },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );
    processPrompt(
      { user_prompt: "Second real prompt", session_id: "sess-ordered" },
      logPath,
      canonicalLogPath,
      promptStatePath,
    );

    const canonicalRecords = readJsonl<CanonicalPromptRecord>(canonicalLogPath);
    expect(canonicalRecords.map((record) => record.prompt_id)).toEqual([
      "sess-ordered:p0",
      "sess-ordered:p1",
    ]);
    expect(canonicalRecords.map((record) => record.prompt_index)).toEqual([0, 1]);
  });
});
