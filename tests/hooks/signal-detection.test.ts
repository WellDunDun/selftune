import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectImprovementSignal, processPrompt } from "../../cli/selftune/hooks/prompt-log.js";
import { _setTestDb, getDb, openDb } from "../../cli/selftune/localdb/db.js";
import type { ImprovementSignalRecord, PromptSubmitPayload } from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

describe("detectImprovementSignal", () => {
  describe("positive matches — correction signals", () => {
    test("why didn't you use the commit skill?", () => {
      const result = detectImprovementSignal("why didn't you use the commit skill?", "sess-1");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("commit");
      expect(result?.consumed).toBe(false);
      expect(result?.session_id).toBe("sess-1");
    });

    test("you should have used Research", () => {
      const result = detectImprovementSignal("you should have used Research", "sess-2");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("Research");
    });

    test("next time use commit", () => {
      const result = detectImprovementSignal("next time use commit", "sess-3");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("commit");
    });

    test("you forgot to use Research", () => {
      const result = detectImprovementSignal("you forgot to use Research", "sess-4");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("Research");
    });

    test("why didn't you run the Security skill?", () => {
      const result = detectImprovementSignal("why didn't you run the Security skill?", "sess-5");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("Security");
    });

    test("why didn't you invoke commit?", () => {
      const result = detectImprovementSignal("why didn't you invoke commit?", "sess-6");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("commit");
    });
  });

  describe("positive matches — explicit request signals", () => {
    test("please use the Browser skill", () => {
      const result = detectImprovementSignal("please use the Browser skill", "sess-7");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("explicit_request");
      expect(result?.mentioned_skill).toBe("Browser");
    });

    test("use the Art skill", () => {
      const result = detectImprovementSignal("use the Art skill", "sess-8");
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("explicit_request");
      expect(result?.mentioned_skill).toBe("Art");
    });
  });

  describe("negative matches — should return null", () => {
    test("how do I use git?", () => {
      const result = detectImprovementSignal("how do I use git?", "sess-n1");
      expect(result).toBeNull();
    });

    test("can you help me with this code?", () => {
      const result = detectImprovementSignal("can you help me with this code?", "sess-n2");
      expect(result).toBeNull();
    });

    test("use strict mode", () => {
      const result = detectImprovementSignal("use strict mode", "sess-n3");
      expect(result).toBeNull();
    });

    test("I use typescript daily", () => {
      const result = detectImprovementSignal("I use typescript daily", "sess-n4");
      expect(result).toBeNull();
    });
  });

  describe("skill name extraction with installed skills list", () => {
    const installedSkills = ["commit", "research", "browser"];

    test("matches installed skill name (case-insensitive)", () => {
      const result = detectImprovementSignal(
        "why didn't you use commit?",
        "sess-s1",
        installedSkills,
      );
      expect(result).not.toBeNull();
      expect(result?.mentioned_skill).toBe("commit");
    });

    test("unknown skill still matches pattern but mentioned_skill from capture", () => {
      const result = detectImprovementSignal(
        "why didn't you use mysteryskill?",
        "sess-s2",
        installedSkills,
      );
      expect(result).not.toBeNull();
      expect(result?.signal_type).toBe("correction");
      expect(result?.mentioned_skill).toBe("mysteryskill");
    });
  });
});

describe("signal detection integration with processPrompt", () => {
  let tmpDir: string;
  let logPath: string;
  let canonicalLogPath: string;
  let promptStatePath: string;
  let signalLogPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "selftune-signal-"));
    logPath = join(tmpDir, "queries.jsonl");
    canonicalLogPath = join(tmpDir, "canonical.jsonl");
    promptStatePath = join(tmpDir, "canonical-session-state.json");
    signalLogPath = join(tmpDir, "signals.jsonl");

    const testDb = openDb(":memory:");
    _setTestDb(testDb);
  });

  afterEach(() => {
    _setTestDb(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("appends signal record when correction detected", async () => {
    const payload: PromptSubmitPayload = {
      user_prompt: "why didn't you use the commit skill?",
      session_id: "sess-int-1",
    };

    // processPrompt writes signals to SQLite via writeImprovementSignalToDb
    const result = await processPrompt(
      payload,
      logPath,
      canonicalLogPath,
      promptStatePath,
      signalLogPath,
    );
    expect(result).not.toBeNull();

    // Verify signal detection directly
    const signal = detectImprovementSignal(payload.user_prompt ?? "", "sess-int-1");
    expect(signal).not.toBeNull();
    expect(signal?.signal_type).toBe("correction");
    expect(signal?.mentioned_skill).toBe("commit");
    expect(signal?.session_id).toBe("sess-int-1");
    expect(signal?.consumed).toBe(false);

    // Verify the signal was written to SQLite
    const db = getDb();
    const row = db
      .query(
        "SELECT signal_type, mentioned_skill, session_id, consumed FROM improvement_signals LIMIT 1",
      )
      .get() as {
      signal_type: string;
      mentioned_skill: string;
      session_id: string;
      consumed: number;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.signal_type).toBe("correction");
    expect(row?.mentioned_skill).toBe("commit");
    expect(row?.session_id).toBe("sess-int-1");
  });

  test("does not append signal for normal queries", async () => {
    const payload: PromptSubmitPayload = {
      user_prompt: "help me refactor this module",
      session_id: "sess-int-2",
    };

    await processPrompt(payload, logPath, canonicalLogPath, promptStatePath, signalLogPath);

    const signals = readJsonl<ImprovementSignalRecord>(signalLogPath);
    expect(signals).toHaveLength(0);
  });
});
