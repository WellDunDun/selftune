import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GATES,
  type PreGate,
  type PreGateContext,
  runPreGates,
} from "../../cli/selftune/grading/pre-gates.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely retrieve a gate by name; throws if not found (clearer than `!`). */
function findGate(name: string): import("../../cli/selftune/grading/pre-gates.js").PreGate {
  const gate = DEFAULT_GATES.find((g) => g.name === name);
  if (!gate) throw new Error(`Gate "${name}" not found in DEFAULT_GATES`);
  return gate;
}

function makeCtx(overrides: Partial<PreGateContext> = {}): PreGateContext {
  return {
    telemetry: {
      timestamp: "2025-01-15T10:00:00Z",
      session_id: "sess-1",
      cwd: "/tmp",
      transcript_path: "/tmp/t.jsonl",
      tool_calls: { Read: 3, Bash: 2 },
      total_tool_calls: 5,
      bash_commands: ["ls"],
      skills_triggered: ["myskill"],
      assistant_turns: 4,
      errors_encountered: 1,
      transcript_chars: 5000,
      last_user_query: "test",
    },
    skillName: "myskill",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Individual gate pattern matching
// ---------------------------------------------------------------------------

describe("pre-gate pattern matching", () => {
  test("skill_md_read gate matches 'SKILL.md was read'", () => {
    const gate = findGate("skill_md_read");
    expect(gate.pattern.test("SKILL.md was read")).toBe(true);
    expect(gate.pattern.test("The skill.md file was read")).toBe(true);
  });

  test("skill_md_read gate does not match unrelated text", () => {
    const gate = findGate("skill_md_read");
    expect(gate.pattern.test("Output is a .pptx")).toBe(false);
  });

  test("expected_tools_called gate matches tool-related text", () => {
    const gate = findGate("expected_tools_called");
    expect(gate.pattern.test("tools were called")).toBe(true);
    expect(gate.pattern.test("tool called")).toBe(true);
  });

  test("error_count gate matches error-related text", () => {
    const gate = findGate("error_count");
    expect(gate.pattern.test("errors encountered")).toBe(true);
    expect(gate.pattern.test("error count")).toBe(true);
  });

  test("session_completed gate matches session text", () => {
    const gate = findGate("session_completed");
    expect(gate.pattern.test("session completed")).toBe(true);
    expect(gate.pattern.test("session finished")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Individual gate logic
// ---------------------------------------------------------------------------

describe("pre-gate check logic", () => {
  test("skill_md_read passes when skill is in skills_triggered", () => {
    const gate = findGate("skill_md_read");
    const ctx = makeCtx();
    expect(gate.check(ctx)).toBe(true);
  });

  test("skill_md_read fails when skill not triggered and no transcript match", () => {
    const gate = findGate("skill_md_read");
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, skills_triggered: [] },
      skillName: "myskill",
    });
    expect(gate.check(ctx)).toBe(false);
  });

  test("skill_md_read passes via transcript match", () => {
    const gate = findGate("skill_md_read");
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, skills_triggered: [] },
      transcriptExcerpt: "[TOOL] Read file SKILL.md",
    });
    expect(gate.check(ctx)).toBe(true);
  });

  test("expected_tools_called passes when tool_calls > 0", () => {
    const gate = findGate("expected_tools_called");
    expect(gate.check(makeCtx())).toBe(true);
  });

  test("expected_tools_called fails when total_tool_calls is 0", () => {
    const gate = findGate("expected_tools_called");
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, total_tool_calls: 0 },
    });
    expect(gate.check(ctx)).toBe(false);
  });

  test("error_count passes when errors <= 1", () => {
    const gate = findGate("error_count");
    expect(gate.check(makeCtx())).toBe(true); // errors_encountered: 1
  });

  test("error_count fails when errors > 1", () => {
    const gate = findGate("error_count");
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, errors_encountered: 2 },
    });
    expect(gate.check(ctx)).toBe(false);
  });

  test("session_completed passes when assistant_turns > 0", () => {
    const gate = findGate("session_completed");
    expect(gate.check(makeCtx())).toBe(true);
  });

  test("session_completed fails when assistant_turns is 0", () => {
    const gate = findGate("session_completed");
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, assistant_turns: 0 },
    });
    expect(gate.check(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPreGates orchestration
// ---------------------------------------------------------------------------

describe("runPreGates", () => {
  test("resolves matching expectations and returns remaining", () => {
    const expectations = [
      "SKILL.md was read correctly",
      "Output is a valid .pptx file",
      "session completed successfully",
    ];
    const result = runPreGates(expectations, makeCtx());

    expect(result.resolved.length).toBe(2); // skill_md_read + session_completed
    expect(result.remaining).toEqual(["Output is a valid .pptx file"]);
  });

  test("resolved expectations have source 'pre-gate'", () => {
    const result = runPreGates(["SKILL.md was read"], makeCtx());
    expect(result.resolved[0].source).toBe("pre-gate");
  });

  test("resolved expectations have score 1.0 for pass", () => {
    const result = runPreGates(["SKILL.md was read"], makeCtx());
    expect(result.resolved[0].score).toBe(1.0);
    expect(result.resolved[0].passed).toBe(true);
  });

  test("resolved expectations have score 0.0 for fail", () => {
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, skills_triggered: [] },
    });
    const result = runPreGates(["SKILL.md was read"], ctx);
    expect(result.resolved[0].score).toBe(0.0);
    expect(result.resolved[0].passed).toBe(false);
  });

  test("empty expectations returns empty results", () => {
    const result = runPreGates([], makeCtx());
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  test("no matching gates sends all to remaining", () => {
    const result = runPreGates(["completely unrelated text"], makeCtx());
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(["completely unrelated text"]);
  });

  test("custom gates via DI override defaults", () => {
    const customGate: PreGate = {
      name: "custom",
      pattern: /custom check/i,
      check: () => true,
    };
    const result = runPreGates(["custom check please"], makeCtx(), [customGate]);
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0].evidence).toContain("custom");
  });
});
