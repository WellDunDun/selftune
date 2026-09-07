import { afterEach, beforeEach, expect, test } from "bun:test";

import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import type {
  SkillIntelligenceInstalledSkill,
  SkillTraceSignal,
} from "@selftune/skill-intelligence";
import { loadSkillIntelligence } from "@selftune/runtime/skill-intelligence";

const DIAGNOSE_PATH = "/tmp/skills/diagnose/SKILL.md";
const TDD_PATH = "/tmp/skills/tdd/SKILL.md";

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
});

function installedSkill(name: string, path: string): SkillIntelligenceInstalledSkill {
  return {
    name,
    skill_path: path,
    package_path: path.replace(/\/SKILL\.md$/, ""),
    registry_dir: "/tmp/skills",
    modified_at: "2026-07-23T00:00:00.000Z",
    skill_scope: "global",
    content: `Use ${name} for this workflow.`,
    harness: "codex",
    active: true,
    source_id: `fixture/${name}`,
  };
}

const traceSignals: ReadonlyArray<SkillTraceSignal> = [
  {
    skill_name: "diagnose",
    invocation_count: 3,
    trace_count: 3,
    error_trace_count: 2,
    duration_ms: 3_000,
    input_tokens: 300,
    output_tokens: 60,
    error_count: 2,
    tool_call_count: 6,
  },
];

test("turns supplied trace snapshots into a non-causal repeated-error pattern", () => {
  const report = loadSkillIntelligence({
    db: getDb(),
    installedSkills: [installedSkill("diagnose", DIAGNOSE_PATH), installedSkill("tdd", TDD_PATH)],
    sessions: [],
    existingSets: [],
    outcomes: [],
    traceSignals,
    configRoot: "/tmp/selftune-trace-patterns",
    now: new Date("2026-07-23T12:00:00.000Z"),
  });

  expect(report.trace_signals).toEqual([...traceSignals]);
  expect(report.execution_patterns).toEqual([
    {
      pattern_id: expect.stringMatching(/^execution-pattern-/),
      kind: "repeated_correlated_errors",
      skill_id: "diagnose",
      skill_name: "diagnose",
      trace_count: 3,
      matching_trace_count: 2,
      ratio: 0.667,
      evidence_state: "supported",
      causal_claim: false,
      reason: "Errors correlated with 2 of 3 traced diagnose executions.",
    },
  ]);
});
