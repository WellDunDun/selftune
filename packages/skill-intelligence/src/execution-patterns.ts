import { createHash } from "node:crypto";

import type { SkillIntelligenceInstalledSkill } from "./types.js";

export interface SkillTraceSignal {
  skill_name: string;
  invocation_count: number;
  trace_count: number;
  error_trace_count: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  error_count: number;
  tool_call_count: number;
}

export type SkillExecutionPatternKind = "repeated_correlated_errors";

export interface SkillExecutionPattern {
  pattern_id: string;
  kind: SkillExecutionPatternKind;
  skill_id: string;
  skill_name: string;
  trace_count: number;
  matching_trace_count: number;
  ratio: number;
  evidence_state: "supported";
  causal_claim: false;
  reason: string;
}

function normalizedSkillId(name: string): string {
  return name.trim().toLowerCase();
}

function roundedRatio(numerator: number, denominator: number): number {
  return Number((numerator / denominator).toFixed(3));
}

function patternId(skillId: string, kind: SkillExecutionPatternKind): string {
  const digest = createHash("sha256").update(`${kind}:${skillId}`).digest("hex").slice(0, 16);
  return `execution-pattern-${digest}`;
}

function activeSkillsById(
  installedSkills: ReadonlyArray<SkillIntelligenceInstalledSkill>,
): ReadonlyMap<string, SkillIntelligenceInstalledSkill> {
  const skills = new Map<string, SkillIntelligenceInstalledSkill>();
  for (const skill of installedSkills) {
    if (skill.active === false) continue;
    const id = normalizedSkillId(skill.name);
    if (!id || skills.has(id)) continue;
    skills.set(id, skill);
  }
  return skills;
}

function normalizedSignals(
  traceSignals: ReadonlyArray<SkillTraceSignal>,
  skillsById: ReadonlyMap<string, SkillIntelligenceInstalledSkill>,
): SkillTraceSignal[] {
  const signalsById = new Map<string, SkillTraceSignal>();
  for (const signal of traceSignals) {
    const id = normalizedSkillId(signal.skill_name);
    const installed = skillsById.get(id);
    if (!installed) continue;
    const existing = signalsById.get(id);
    if (existing) {
      existing.invocation_count += signal.invocation_count;
      existing.trace_count += signal.trace_count;
      existing.error_trace_count += signal.error_trace_count;
      existing.duration_ms += signal.duration_ms;
      existing.input_tokens += signal.input_tokens;
      existing.output_tokens += signal.output_tokens;
      existing.error_count += signal.error_count;
      existing.tool_call_count += signal.tool_call_count;
      continue;
    }
    signalsById.set(id, { ...signal, skill_name: installed.name });
  }
  return [...signalsById.values()].toSorted((left, right) =>
    normalizedSkillId(left.skill_name).localeCompare(normalizedSkillId(right.skill_name)),
  );
}

export function deriveSkillExecutionPatterns(input: {
  installedSkills: ReadonlyArray<SkillIntelligenceInstalledSkill>;
  traceSignals?: ReadonlyArray<SkillTraceSignal>;
}): {
  trace_signals: SkillTraceSignal[];
  execution_patterns: SkillExecutionPattern[];
} {
  const skillsById = activeSkillsById(input.installedSkills);
  const trace_signals = normalizedSignals(input.traceSignals ?? [], skillsById);
  const execution_patterns: SkillExecutionPattern[] = trace_signals.flatMap((signal) => {
    const traceCount = signal.trace_count;
    const matchingTraceCount = signal.error_trace_count;
    if (traceCount < 3 || matchingTraceCount < 2 || matchingTraceCount / traceCount < 0.5) {
      return [];
    }
    const skillId = normalizedSkillId(signal.skill_name);
    const ratio = roundedRatio(matchingTraceCount, traceCount);
    const pattern: SkillExecutionPattern = {
      pattern_id: patternId(skillId, "repeated_correlated_errors"),
      kind: "repeated_correlated_errors",
      skill_id: skillId,
      skill_name: signal.skill_name,
      trace_count: traceCount,
      matching_trace_count: matchingTraceCount,
      ratio,
      evidence_state: "supported",
      causal_claim: false,
      reason: `Errors correlated with ${matchingTraceCount} of ${traceCount} traced ${signal.skill_name} executions.`,
    };
    return [pattern];
  });
  return { trace_signals, execution_patterns };
}
