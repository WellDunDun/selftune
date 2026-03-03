/**
 * pre-gates.ts
 *
 * Deterministic pre-gate checks that resolve grading expectations without LLM.
 * Each gate matches an expectation text pattern and resolves it using telemetry data.
 */

import type { GradingExpectation, SessionTelemetryRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Gate definitions
// ---------------------------------------------------------------------------

export interface PreGate {
  name: string;
  pattern: RegExp;
  check: (ctx: PreGateContext) => boolean;
}

export interface PreGateContext {
  telemetry: SessionTelemetryRecord;
  skillName: string;
  transcriptExcerpt?: string;
}

export interface PreGateResult {
  resolved: GradingExpectation[];
  remaining: string[];
}

/** Default set of pre-gates. */
export const DEFAULT_GATES: PreGate[] = [
  {
    name: "skill_md_read",
    pattern: /skill\.md.*read/i,
    check: (ctx) => {
      // Check if skills_triggered contains the skill name
      const triggered = ctx.telemetry.skills_triggered ?? [];
      if (triggered.includes(ctx.skillName)) return true;
      // Also check if transcript mentions reading SKILL.md
      if (ctx.transcriptExcerpt && /Read.*SKILL\.md/i.test(ctx.transcriptExcerpt)) return true;
      return false;
    },
  },
  {
    name: "expected_tools_called",
    pattern: /tool[s]?\s+(were\s+)?called/i,
    check: (ctx) => (ctx.telemetry.total_tool_calls ?? 0) > 0,
  },
  {
    name: "error_count",
    pattern: /error[s]?\s*(count|encountered)/i,
    check: (ctx) => (ctx.telemetry.errors_encountered ?? 0) <= 1,
  },
  {
    name: "session_completed",
    pattern: /session\s*(completed|finished)/i,
    check: (ctx) => (ctx.telemetry.assistant_turns ?? 0) > 0,
  },
];

// ---------------------------------------------------------------------------
// Pre-gate runner
// ---------------------------------------------------------------------------

/**
 * Run pre-gate checks against expectations. Returns resolved expectations
 * (with source: "pre-gate" and score: 1.0 or 0.0) and remaining expectation
 * texts that need LLM grading.
 */
export function runPreGates(
  expectations: string[],
  ctx: PreGateContext,
  gates: PreGate[] = DEFAULT_GATES,
): PreGateResult {
  const resolved: GradingExpectation[] = [];
  const remaining: string[] = [];

  for (const text of expectations) {
    let matched = false;
    for (const gate of gates) {
      if (gate.pattern.test(text)) {
        const passed = gate.check(ctx);
        resolved.push({
          text,
          passed,
          evidence: `Pre-gate "${gate.name}": ${passed ? "PASS" : "FAIL"}`,
          score: passed ? 1.0 : 0.0,
          source: "pre-gate",
        });
        matched = true;
        break; // first matching gate wins
      }
    }
    if (!matched) {
      remaining.push(text);
    }
  }

  return { resolved, remaining };
}
