import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPrompt } from "../../cli/selftune/hooks/prompt-log.js";
import { _setTestDb, getDb, openDb } from "../../cli/selftune/localdb/db.js";
import type {
  PromptSubmitPayload,
  QueryLogRecord,
} from "../../cli/selftune/types.js";

let tmpDir: string;
let canonicalLogPath: string;
let promptStatePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-prompt-log-"));
  canonicalLogPath = join(tmpDir, "canonical.jsonl");
  promptStatePath = join(tmpDir, "canonical-session-state.json");

  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to count query rows in the test database. */
function queryCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as cnt FROM queries").get() as { cnt: number };
  return row.cnt;
}

describe("prompt-log hook", () => {
  test("skips empty prompts", async () => {
    const result = await processPrompt({ user_prompt: "" }, undefined, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();
    expect(queryCount()).toBe(0);
  });

  test("skips whitespace-only prompts", async () => {
    const result = await processPrompt(
      { user_prompt: "   " },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).toBeNull();
    expect(queryCount()).toBe(0);
  });

  test("skips short prompts (less than 4 chars)", async () => {
    const result = await processPrompt({ user_prompt: "hi" }, undefined, canonicalLogPath, promptStatePath);
    expect(result).toBeNull();

    const result2 = await processPrompt(
      { user_prompt: "ok?" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result2).toBeNull();

    expect(queryCount()).toBe(0);
  });

  test("skips automated prefix messages", async () => {
    const prefixes = [
      "<tool_result>some data</tool_result>",
      "<function_result>output</function_result>",
      "[Automated message from system]",
      "[System notification]",
    ];

    for (const prefix of prefixes) {
      const result = await processPrompt(
        { user_prompt: prefix },
        undefined,
        canonicalLogPath,
        promptStatePath,
      );
      expect(result).toBeNull();
    }

    expect(queryCount()).toBe(0);
  });

  test("appends valid query and returns record", async () => {
    const payload: PromptSubmitPayload = {
      user_prompt: "Help me refactor the authentication module",
      session_id: "sess-123",
    };

    const result = await processPrompt(payload, undefined, canonicalLogPath, promptStatePath);
    expect(result).not.toBeNull();
    expect(result?.query).toBe("Help me refactor the authentication module");
    expect(result?.session_id).toBe("sess-123");
    expect(result?.timestamp).toBeTruthy();

    // Verify the record was written to SQLite
    expect(queryCount()).toBe(1);
    const db = getDb();
    const row = db.query("SELECT query, session_id FROM queries LIMIT 1").get() as { query: string; session_id: string };
    expect(row.query).toBe("Help me refactor the authentication module");
    expect(row.session_id).toBe("sess-123");
  });

  test("uses 'unknown' for missing session_id", async () => {
    const result = await processPrompt(
      { user_prompt: "valid query here" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("unknown");
  });

  test("trims whitespace from query", async () => {
    const result = await processPrompt(
      { user_prompt: "  some query with spaces  " },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).not.toBeNull();
    expect(result?.query).toBe("some query with spaces");
  });

  test("handles JSON parse errors gracefully (missing user_prompt field)", async () => {
    const result = await processPrompt(
      {} as PromptSubmitPayload,
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    expect(result).toBeNull();
  });

  test("assigns deterministic prompt ids per session order via state file", async () => {
    const r1 = await processPrompt(
      { user_prompt: "First real prompt", session_id: "sess-ordered" },
      undefined,
      canonicalLogPath,
      promptStatePath,
    );
    const r2 = await processPrompt(
      { user_prompt: "Second real prompt", session_id: "sess-ordered" },
      undefined,
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
