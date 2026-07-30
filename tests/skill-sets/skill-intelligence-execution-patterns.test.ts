import { expect, test } from "bun:test";

import {
  analyzeSkillIntelligence,
  type SkillIntelligenceInstalledSkill,
} from "@selftune/skill-intelligence";

function installed(name: string, active = true): SkillIntelligenceInstalledSkill {
  return {
    name,
    skill_path: `/tmp/skills/${name}/SKILL.md`,
    package_path: `/tmp/skills/${name}`,
    registry_dir: "/tmp/skills",
    modified_at: "2026-07-23T00:00:00.000Z",
    skill_scope: "global",
    content: `Use ${name}.`,
    harness: "codex",
    active,
  };
}

test("derives a stable non-causal execution pattern from installed trace evidence", () => {
  const input = {
    installedSkills: [installed("Diagnose"), installed("inactive", false)],
    sessions: [],
    now: new Date("2026-07-23T12:00:00.000Z"),
    traceSignals: [
      {
        skill_name: " diagnose ",
        invocation_count: 3,
        trace_count: 3,
        error_trace_count: 2,
        duration_ms: 3_000,
        input_tokens: 300,
        output_tokens: 60,
        error_count: 2,
        tool_call_count: 6,
      },
      {
        skill_name: "unknown",
        invocation_count: 99,
        trace_count: 99,
        error_trace_count: 99,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        error_count: 99,
        tool_call_count: 0,
      },
      {
        skill_name: "inactive",
        invocation_count: 99,
        trace_count: 99,
        error_trace_count: 99,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        error_count: 99,
        tool_call_count: 0,
      },
    ],
  };

  const first = analyzeSkillIntelligence(input);
  const second = analyzeSkillIntelligence({
    ...input,
    traceSignals: [{ ...input.traceSignals[0]!, error_trace_count: 3 }],
  });

  expect(first.trace_signals).toEqual([
    {
      skill_name: "Diagnose",
      invocation_count: 3,
      trace_count: 3,
      error_trace_count: 2,
      duration_ms: 3_000,
      input_tokens: 300,
      output_tokens: 60,
      error_count: 2,
      tool_call_count: 6,
    },
  ]);
  expect(first.execution_patterns).toEqual([
    {
      pattern_id: expect.stringMatching(/^execution-pattern-/),
      kind: "repeated_correlated_errors",
      skill_id: "diagnose",
      skill_name: "Diagnose",
      trace_count: 3,
      matching_trace_count: 2,
      ratio: 0.667,
      evidence_state: "supported",
      causal_claim: false,
      reason: "Errors correlated with 2 of 3 traced Diagnose executions.",
    },
  ]);
  expect(second.execution_patterns[0]?.pattern_id).toBe(first.execution_patterns[0]?.pattern_id);
});
