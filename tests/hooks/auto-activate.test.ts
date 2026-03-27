import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateRules,
  loadSessionState,
  saveSessionState,
} from "../../cli/selftune/hooks/auto-activate.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import {
  type SkillInvocationWriteInput,
  writeEvolutionAuditToDb,
  writeQueryToDb,
  writeSkillCheckToDb,
} from "../../cli/selftune/localdb/direct-write.js";
import type { ActivationContext, ActivationRule, SessionState } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-auto-activate-"));
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Session state persistence
// ---------------------------------------------------------------------------

describe("session state", () => {
  test("loadSessionState returns empty state for missing file", () => {
    const state = loadSessionState(join(tmpDir, "nonexistent.json"), "sess-1");
    expect(state.session_id).toBe("sess-1");
    expect(state.suggestions_shown).toEqual([]);
  });

  test("saveSessionState writes and loadSessionState reads back", () => {
    const path = join(tmpDir, "state.json");
    const state: SessionState = {
      session_id: "sess-42",
      suggestions_shown: ["rule-a", "rule-b"],
      updated_at: new Date().toISOString(),
    };
    saveSessionState(path, state);

    const loaded = loadSessionState(path, "sess-42");
    expect(loaded.session_id).toBe("sess-42");
    expect(loaded.suggestions_shown).toContain("rule-a");
    expect(loaded.suggestions_shown).toContain("rule-b");
  });

  test("loadSessionState returns empty state for corrupt file", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not valid json!!!", "utf-8");
    const state = loadSessionState(path, "sess-x");
    expect(state.session_id).toBe("sess-x");
    expect(state.suggestions_shown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

describe("evaluateRules", () => {
  function makeContext(overrides?: Partial<ActivationContext>): ActivationContext {
    return {
      session_id: "sess-test",
      query_log_path: join(tmpDir, "queries.jsonl"),
      telemetry_log_path: join(tmpDir, "telemetry.jsonl"),
      evolution_audit_log_path: join(tmpDir, "evolution_audit.jsonl"),
      selftune_dir: tmpDir,
      settings_path: join(tmpDir, "settings.json"),
      ...overrides,
    };
  }

  test("returns empty array when no rules fire", () => {
    const rules: ActivationRule[] = [
      { id: "r1", description: "never fires", evaluate: () => null },
    ];
    const statePath = join(tmpDir, "state.json");
    const result = evaluateRules(rules, makeContext(), statePath);
    expect(result).toEqual([]);
  });

  test("returns suggestions for firing rules", () => {
    const rules: ActivationRule[] = [
      { id: "r1", description: "always fires", evaluate: () => "Do something" },
      { id: "r2", description: "never fires", evaluate: () => null },
      { id: "r3", description: "also fires", evaluate: () => "Do another thing" },
    ];
    const statePath = join(tmpDir, "state.json");
    const result = evaluateRules(rules, makeContext(), statePath);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Do something");
    expect(result[1]).toContain("Do another thing");
  });

  test("skips rules already shown this session", () => {
    const statePath = join(tmpDir, "state.json");
    // Pre-populate session state
    const state: SessionState = {
      session_id: "sess-test",
      suggestions_shown: ["r1"],
      updated_at: new Date().toISOString(),
    };
    saveSessionState(statePath, state);

    const rules: ActivationRule[] = [
      { id: "r1", description: "already shown", evaluate: () => "Repeat!" },
      { id: "r2", description: "new", evaluate: () => "Fresh suggestion" },
    ];
    const result = evaluateRules(rules, makeContext(), statePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Fresh suggestion");
  });

  test("updates session state after evaluation", () => {
    const statePath = join(tmpDir, "state.json");
    const rules: ActivationRule[] = [
      { id: "r1", description: "fires", evaluate: () => "Suggestion 1" },
    ];
    evaluateRules(rules, makeContext(), statePath);

    const state = loadSessionState(statePath, "sess-test");
    expect(state.suggestions_shown).toContain("r1");
  });

  test("handles rule evaluation errors gracefully (fail-open)", () => {
    const rules: ActivationRule[] = [
      {
        id: "r-crash",
        description: "throws",
        evaluate: () => {
          throw new Error("boom");
        },
      },
      { id: "r-ok", description: "works fine", evaluate: () => "All good" },
    ];
    const statePath = join(tmpDir, "state.json");
    // Should not throw, and should still return the working rule
    const result = evaluateRules(rules, makeContext(), statePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("All good");
  });
});

// ---------------------------------------------------------------------------
// Default activation rules (integration-style)
// ---------------------------------------------------------------------------

describe("default activation rules", () => {
  function makeContext(overrides?: Partial<ActivationContext>): ActivationContext {
    return {
      session_id: "sess-default",
      query_log_path: join(tmpDir, "queries.jsonl"),
      telemetry_log_path: join(tmpDir, "telemetry.jsonl"),
      evolution_audit_log_path: join(tmpDir, "evolution_audit.jsonl"),
      selftune_dir: tmpDir,
      settings_path: join(tmpDir, "settings.json"),
      ...overrides,
    };
  }

  test("post-session diagnostic fires when >2 unmatched queries", async () => {
    // Import default rules dynamically to test them
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "post-session-diagnostic");
    expect(rule).toBeDefined();

    // Seed SQLite with 4 queries for this session
    writeQueryToDb({ timestamp: "2025-01-01T00:00:00Z", session_id: "sess-default", query: "query 1" });
    writeQueryToDb({ timestamp: "2025-01-01T00:01:00Z", session_id: "sess-default", query: "query 2" });
    writeQueryToDb({ timestamp: "2025-01-01T00:02:00Z", session_id: "sess-default", query: "query 3" });
    writeQueryToDb({ timestamp: "2025-01-01T00:03:00Z", session_id: "sess-default", query: "query 4" });

    // Seed SQLite with only 1 matched skill usage for this session
    writeSkillCheckToDb({
      skill_invocation_id: "si_test_activate_1",
      session_id: "sess-default",
      occurred_at: "2025-01-01T00:01:00Z",
      skill_name: "pdf",
      invocation_mode: "implicit",
      triggered: true,
      confidence: 1.0,
      skill_path: "/skills/pdf/SKILL.md",
      query: "query 1",
    } as SkillInvocationWriteInput);

    const ctx = makeContext();

    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("selftune last");
    expect(suggestion).toContain("unmatched");
  });

  test("post-session diagnostic does NOT fire with <=2 unmatched queries", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "post-session-diagnostic");

    // Seed SQLite with only 2 queries, 0 skill usages -> 2 unmatched (not > 2)
    writeQueryToDb({ timestamp: "2025-01-01T00:00:00Z", session_id: "sess-default", query: "q1" });
    writeQueryToDb({ timestamp: "2025-01-01T00:01:00Z", session_id: "sess-default", query: "q2" });

    const ctx = makeContext();
    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).toBeNull();
  });

  test("post-session diagnostic fails open when SQLite reads throw", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "post-session-diagnostic");

    const db = openDb(":memory:");
    _setTestDb(db);
    db.close();

    const ctx = makeContext();
    expect(rule?.evaluate(ctx)).toBeNull();
  });

  test("grading-threshold rule fires when pass rate < 0.6", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "grading-threshold-breach");
    expect(rule).toBeDefined();

    // Create a grading result with low pass rate
    const gradingDir = join(tmpDir, "grading");
    mkdirSync(gradingDir, { recursive: true });
    const gradingResult = {
      session_id: "sess-default",
      skill_name: "test-skill",
      graded_at: "2025-01-01T00:00:00Z",
      summary: { passed: 2, failed: 5, total: 7, pass_rate: 0.29 },
    };
    writeFileSync(
      join(gradingDir, "result-sess-default.json"),
      JSON.stringify(gradingResult),
      "utf-8",
    );

    const ctx = makeContext();
    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("selftune evolve");
  });

  test("grading-threshold rule does NOT fire when pass rate >= 0.6", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "grading-threshold-breach");

    const gradingDir = join(tmpDir, "grading");
    mkdirSync(gradingDir, { recursive: true });
    const gradingResult = {
      session_id: "sess-default",
      skill_name: "test-skill",
      graded_at: "2025-01-01T00:00:00Z",
      summary: { passed: 8, failed: 2, total: 10, pass_rate: 0.8 },
    };
    writeFileSync(
      join(gradingDir, "result-sess-default.json"),
      JSON.stringify(gradingResult),
      "utf-8",
    );

    const ctx = makeContext();
    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).toBeNull();
  });

  test("stale-evolution fails open when SQLite reads throw", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "stale-evolution");

    const db = openDb(":memory:");
    _setTestDb(db);
    db.close();

    const ctx = makeContext();
    expect(rule?.evaluate(ctx)).toBeNull();
  });

  test("stale-evolution rule fires with old audit + pending false negatives", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "stale-evolution");
    expect(rule).toBeDefined();

    // Seed SQLite with evolution audit entry older than 7 days
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    writeEvolutionAuditToDb({
      timestamp: oldDate,
      proposal_id: "prop-1",
      action: "deployed",
      details: "old deployment",
    });

    // Create false negatives file
    const fnDir = join(tmpDir, "false-negatives");
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(
      join(fnDir, "pending.json"),
      JSON.stringify([{ query: "unhandled query", session_id: "s1" }]),
      "utf-8",
    );

    const ctx = makeContext();
    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("selftune evolve");
    expect(suggestion).toContain("7 days");
  });

  test("regression-detected rule fires when snapshot shows regression", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "regression-detected");
    expect(rule).toBeDefined();

    // Create a monitoring snapshot showing regression
    const snapshotDir = join(tmpDir, "monitoring");
    mkdirSync(snapshotDir, { recursive: true });
    const snapshot = {
      timestamp: new Date().toISOString(),
      skill_name: "pdf",
      window_sessions: 10,
      pass_rate: 0.4,
      false_negative_rate: 0.3,
      regression_detected: true,
      baseline_pass_rate: 0.8,
    };
    writeFileSync(join(snapshotDir, "latest-snapshot.json"), JSON.stringify(snapshot), "utf-8");

    const ctx = makeContext();
    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("selftune rollback");
  });

  test("regression-detected rule does NOT fire when no regression", async () => {
    const { DEFAULT_RULES } = await import("../../cli/selftune/activation-rules.js");
    const rule = DEFAULT_RULES.find((r) => r.id === "regression-detected");

    const snapshotDir = join(tmpDir, "monitoring");
    mkdirSync(snapshotDir, { recursive: true });
    const snapshot = {
      timestamp: new Date().toISOString(),
      skill_name: "pdf",
      window_sessions: 10,
      pass_rate: 0.85,
      false_negative_rate: 0.05,
      regression_detected: false,
      baseline_pass_rate: 0.8,
    };
    writeFileSync(join(snapshotDir, "latest-snapshot.json"), JSON.stringify(snapshot), "utf-8");

    const ctx = makeContext();
    const suggestion = rule?.evaluate(ctx);
    expect(suggestion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PAI coexistence
// ---------------------------------------------------------------------------

describe("PAI coexistence", () => {
  test("defers skill-level suggestions when PAI hook is registered", async () => {
    const { checkPaiCoexistence } = await import("../../cli/selftune/hooks/auto-activate.js");

    // Create settings.json with PAI's hook registered
    const settingsPath = join(tmpDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "bun run skill-activation-prompt.ts",
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );

    const result = checkPaiCoexistence(settingsPath);
    expect(result).toBe(true);
  });

  test("does not defer when PAI hook is not registered", async () => {
    const { checkPaiCoexistence } = await import("../../cli/selftune/hooks/auto-activate.js");

    const settingsPath = join(tmpDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "bun run prompt-log.ts" }],
            },
          ],
        },
      }),
      "utf-8",
    );

    const result = checkPaiCoexistence(settingsPath);
    expect(result).toBe(false);
  });

  test("does not defer when settings file is missing", async () => {
    const { checkPaiCoexistence } = await import("../../cli/selftune/hooks/auto-activate.js");
    const result = checkPaiCoexistence(join(tmpDir, "nonexistent.json"));
    expect(result).toBe(false);
  });
});
