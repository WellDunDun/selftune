#!/usr/bin/env bun
/**
 * grade-session.ts
 *
 * Rubric-based grader for Claude Code skill sessions.
 * Migrated from grade_session.py.
 *
 * Grades via installed agent CLI (claude/codex/opencode).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { TELEMETRY_LOG } from "../constants.js";
import type {
  ExecutionMetrics,
  GraderOutput,
  GradingExpectation,
  GradingResult,
  SessionTelemetryRecord,
} from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import {
  detectAgent as _detectAgent,
  stripMarkdownFences as _stripMarkdownFences,
  callViaAgent,
} from "../utils/llm-call.js";
import { readExcerpt } from "../utils/transcript.js";
import { type PreGateContext, runPreGates } from "./pre-gates.js";

// Re-export for backward compatibility
export { detectAgent, stripMarkdownFences } from "../utils/llm-call.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_TRANSCRIPT_LENGTH = 50000;

// ---------------------------------------------------------------------------
// Grader system prompt
// ---------------------------------------------------------------------------

export const GRADER_SYSTEM = `You are a rigorous skill session evaluator. You receive:
1. Expectations to grade (things that should be true)
2. Process telemetry: tool calls, bash commands, skills triggered, errors
3. A transcript excerpt showing what happened

Grade each expectation and output ONLY valid JSON matching this schema:
{
  "expectations": [
    {"text": "...", "passed": true/false, "evidence": "specific quote or metric", "score": 0.0-1.0}
  ],
  "summary": {"passed": N, "failed": N, "total": N, "pass_rate": 0.0, "mean_score": 0.0},
  "claims": [
    {"claim": "...", "type": "factual|process|quality", "verified": true/false, "evidence": "..."}
  ],
  "eval_feedback": {
    "suggestions": [{"assertion": "...", "reason": "..."}],
    "overall": "one sentence"
  },
  "failure_feedback": [
    {"query": "the user query that failed", "failure_reason": "why it failed", "improvement_hint": "how to fix", "invocation_type": "explicit|implicit|contextual|negative"}
  ]
}

Score guide:
- 1.0: Clear, specific evidence of full completion
- 0.7-0.9: Strong evidence with minor gaps
- 0.4-0.6: Partial evidence or partial completion
- 0.1-0.3: Weak evidence, mostly not met
- 0.0: No evidence or clearly not met

Rules:
- PASS only when there is clear, specific evidence — not assumptions
- FAIL when evidence is absent or contradictory
- Cite exact quotes or specific metric values
- Extract 2-4 implicit claims from the transcript and verify them
- Suggest eval improvements only for clear gaps
- Set score to reflect confidence level (0.0-1.0)
- For each FAILED expectation, provide a failure_feedback entry with the relevant query, specific reason for failure, and actionable improvement hint`;

// ---------------------------------------------------------------------------
// Data lookup helpers
// ---------------------------------------------------------------------------

export function findSession(
  records: SessionTelemetryRecord[],
  sessionId: string,
): SessionTelemetryRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].session_id === sessionId) return records[i];
  }
  return null;
}

export function latestSessionForSkill(
  telemetry: SessionTelemetryRecord[],
  skillName: string,
): SessionTelemetryRecord | null {
  for (let i = telemetry.length - 1; i >= 0; i--) {
    if (telemetry[i].skills_triggered?.includes(skillName)) return telemetry[i];
  }
  return null;
}

export function loadExpectationsFromEvalsJson(evalsJsonPath: string, evalId: number): string[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(evalsJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read or parse evals JSON at ${evalsJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      `Invalid evals JSON at ${evalsJsonPath}: expected a top-level object, got ${Array.isArray(data) ? "array" : typeof data}`,
    );
  }

  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.evals)) {
    throw new Error(
      `Invalid evals JSON at ${evalsJsonPath}: expected "evals" to be an array, got ${typeof record.evals}`,
    );
  }

  for (const ev of record.evals) {
    if (typeof ev !== "object" || ev === null || Array.isArray(ev)) {
      throw new Error(
        `Invalid eval entry in ${evalsJsonPath}: expected an object, got ${Array.isArray(ev) ? "array" : typeof ev}`,
      );
    }
    const entry = ev as Record<string, unknown>;
    if (entry.id === evalId) {
      if (entry.expectations === undefined || entry.expectations === null) {
        return [];
      }
      if (!Array.isArray(entry.expectations)) {
        throw new Error(
          `Invalid eval entry (id=${evalId}) in ${evalsJsonPath}: expected "expectations" to be an array, got ${typeof entry.expectations}`,
        );
      }
      for (let i = 0; i < entry.expectations.length; i++) {
        if (typeof entry.expectations[i] !== "string") {
          throw new Error(
            `Invalid eval entry (id=${evalId}) in ${evalsJsonPath}: expectations[${i}] must be a string, got ${typeof entry.expectations[i]}`,
          );
        }
      }
      return entry.expectations as string[];
    }
  }
  throw new Error(`Eval ID ${evalId} not found in ${evalsJsonPath}`);
}

// ---------------------------------------------------------------------------
// Execution metrics
// ---------------------------------------------------------------------------

export function buildExecutionMetrics(telemetry: SessionTelemetryRecord): ExecutionMetrics {
  return {
    tool_calls: telemetry.tool_calls ?? {},
    total_tool_calls: telemetry.total_tool_calls ?? 0,
    total_steps: telemetry.assistant_turns ?? 0,
    bash_commands_run: (telemetry.bash_commands ?? []).length,
    errors_encountered: telemetry.errors_encountered ?? 0,
    skills_triggered: telemetry.skills_triggered ?? [],
    transcript_chars: telemetry.transcript_chars ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Graduated scoring
// ---------------------------------------------------------------------------

/**
 * Compute graduated scoring summary from expectations.
 * Uses score field if present, defaults to 1.0 for pass, 0.0 for fail.
 */
export function buildGraduatedSummary(expectations: GradingExpectation[]): {
  mean_score: number;
  score_std_dev: number;
} {
  if (expectations.length === 0) {
    return { mean_score: 0, score_std_dev: 0 };
  }

  const scores = expectations.map((e) => {
    const fallback = e.passed ? 1.0 : 0.0;
    const raw = e.score ?? fallback;
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(1, Math.max(0, raw));
  });
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;

  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean_score: Math.round(mean * 1000) / 1000,
    score_std_dev: Math.round(stdDev * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function buildGradingPrompt(
  expectations: string[],
  telemetry: SessionTelemetryRecord,
  transcriptExcerpt: string,
  skillName: string,
): string {
  const toolSummary = JSON.stringify(telemetry.tool_calls ?? {}, null, 2);
  const commands = telemetry.bash_commands ?? [];
  const cmdSummary =
    commands
      .slice(0, 20)
      .map((c) => `  $ ${c.slice(0, 120)}`)
      .join("\n") || "  (none)";

  const expectationsList = expectations.map((e, i) => `${i + 1}. ${e}`).join("\n");

  const excerpt =
    transcriptExcerpt.length > MAX_TRANSCRIPT_LENGTH
      ? transcriptExcerpt.slice(0, MAX_TRANSCRIPT_LENGTH)
      : transcriptExcerpt;

  return `Skill: ${skillName}

=== PROCESS TELEMETRY ===
Skills triggered: ${JSON.stringify(telemetry.skills_triggered ?? [])}
Assistant turns: ${telemetry.assistant_turns ?? "?"}
Errors: ${telemetry.errors_encountered ?? "?"}
Total tool calls: ${telemetry.total_tool_calls ?? "?"}

Tool breakdown:
${toolSummary}

Bash commands:
${cmdSummary}

=== TRANSCRIPT EXCERPT ===
${excerpt}

=== EXPECTATIONS ===
${expectationsList}

Grade each expectation. Output JSON only.`;
}

// ---------------------------------------------------------------------------
// Grading via agent subprocess
// ---------------------------------------------------------------------------

export async function gradeViaAgent(prompt: string, agent: string): Promise<GraderOutput> {
  const raw = await callViaAgent(GRADER_SYSTEM, prompt, agent);
  try {
    return JSON.parse(_stripMarkdownFences(raw)) as GraderOutput;
  } catch (err) {
    throw new Error(
      `gradeViaAgent: failed to parse LLM output as JSON. Raw (truncated): ${raw.slice(0, 200)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

export function assembleResult(
  graderOutput: GraderOutput,
  telemetry: SessionTelemetryRecord,
  sessionId: string,
  skillName: string,
  transcriptPath: string,
): GradingResult {
  // Default missing scores on expectations
  const expectations = (graderOutput?.expectations ?? []).map((e) => ({
    ...e,
    score: e.score ?? (e.passed ? 1.0 : 0.0),
    source: e.source ?? ("llm" as const),
  }));

  const baseSummary = graderOutput?.summary ?? { passed: 0, failed: 0, total: 0, pass_rate: 0 };
  const graduated = buildGraduatedSummary(expectations);

  return {
    session_id: sessionId ?? "unknown",
    skill_name: skillName ?? "unknown",
    transcript_path: transcriptPath ?? "",
    graded_at: new Date().toISOString(),
    expectations,
    summary: {
      ...baseSummary,
      mean_score: graduated.mean_score,
      score_std_dev: graduated.score_std_dev,
    },
    execution_metrics: buildExecutionMetrics(telemetry ?? ({} as SessionTelemetryRecord)),
    claims: graderOutput?.claims ?? [],
    eval_feedback: graderOutput?.eval_feedback ?? { suggestions: [], overall: "" },
    failure_feedback: graderOutput?.failure_feedback,
  };
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

function printSummary(result: GradingResult): void {
  const { summary } = result;
  const rate = summary.pass_rate ?? 0;
  const meanStr =
    summary.mean_score != null ? ` | mean score: ${summary.mean_score.toFixed(2)}` : "";
  console.log(
    `\nResults: ${summary.passed}/${summary.total} passed (${Math.round(rate * 100)}%)${meanStr}`,
  );
  for (const exp of result.expectations ?? []) {
    const icon = exp.passed ? "\u2713" : "\u2717";
    const scoreStr = exp.score != null ? ` [${exp.score.toFixed(1)}]` : "";
    const sourceStr = exp.source ? ` (${exp.source})` : "";
    console.log(`  ${icon}${scoreStr}${sourceStr} ${String(exp.text ?? "").slice(0, 70)}`);
    if (!exp.passed) {
      console.log(`      -> ${String(exp.evidence ?? "").slice(0, 100)}`);
    }
  }

  const feedback = result.eval_feedback;
  if (feedback.suggestions?.length) {
    console.log(`\nEval feedback: ${feedback.overall}`);
    for (const s of feedback.suggestions) {
      console.log(`  * ${String(s.reason ?? "").slice(0, 100)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      expectations: { type: "string", multiple: true },
      "evals-json": { type: "string" },
      "eval-id": { type: "string" },
      "session-id": { type: "string" },
      transcript: { type: "string" },
      "telemetry-log": { type: "string", default: TELEMETRY_LOG },
      output: { type: "string", default: "grading.json" },
      agent: { type: "string" },
      "show-transcript": { type: "boolean", default: false },
    },
    strict: true,
  });

  const skill = values.skill;
  if (!skill) {
    console.error("[ERROR] --skill is required");
    process.exit(1);
  }

  // --- Determine agent ---
  let agent: string | null = null;
  const validAgents = ["claude", "codex", "opencode"];
  if (values.agent) {
    if (!validAgents.includes(values.agent)) {
      console.error(
        `[ERROR] Invalid --agent '${values.agent}'. Expected one of: ${validAgents.join(", ")}`,
      );
      process.exit(1);
    }
    agent = values.agent;
  } else {
    agent = _detectAgent();
  }

  if (!agent) {
    console.error(
      "[ERROR] No agent CLI (claude/codex/opencode) found in PATH.\n" +
        "Install Claude Code, Codex, or OpenCode.",
    );
    process.exit(1);
  }

  console.error(`[INFO] Grading via agent: ${agent}`);

  // --- Resolve expectations ---
  let expectations: string[] = [];
  if (values["evals-json"] && values["eval-id"] != null) {
    const evalIdNum = Number(values["eval-id"]);
    if (!Number.isFinite(evalIdNum) || !Number.isInteger(evalIdNum)) {
      console.error(`[ERROR] --eval-id must be a finite integer, got: ${values["eval-id"]}`);
      process.exit(1);
    }
    expectations = loadExpectationsFromEvalsJson(values["evals-json"], evalIdNum);
  } else if (values.expectations?.length) {
    expectations = values.expectations;
  } else {
    console.error("[ERROR] Provide --expectations or --evals-json + --eval-id");
    process.exit(1);
  }

  // --- Resolve session ---
  let telemetry = {} as SessionTelemetryRecord;
  let transcriptPath = "";
  let sessionId = "unknown";

  const telemetryLog = values["telemetry-log"] ?? TELEMETRY_LOG;
  const telRecords = readJsonl<SessionTelemetryRecord>(telemetryLog);

  if (values.transcript) {
    transcriptPath = values.transcript;
    for (let i = telRecords.length - 1; i >= 0; i--) {
      if (telRecords[i].transcript_path === transcriptPath) {
        telemetry = telRecords[i];
        sessionId = telRecords[i].session_id ?? "unknown";
        break;
      }
    }
  } else if (values["session-id"]) {
    sessionId = values["session-id"];
    telemetry = findSession(telRecords, sessionId) ?? ({} as SessionTelemetryRecord);
    transcriptPath = telemetry.transcript_path ?? "";
  } else {
    telemetry = latestSessionForSkill(telRecords, skill) ?? ({} as SessionTelemetryRecord);
    if (telemetry.session_id) {
      sessionId = telemetry.session_id;
      transcriptPath = telemetry.transcript_path ?? "";
      console.error(`[INFO] Grading most recent '${skill}' session: ${sessionId}`);
    } else {
      console.error(`[WARN] No telemetry for skill '${skill}'. Is session_stop_hook installed?`);
    }
  }

  const transcriptExcerpt = transcriptPath ? readExcerpt(transcriptPath) : "(no transcript)";

  if (values["show-transcript"]) {
    console.log("=== TRANSCRIPT EXCERPT ===");
    console.log(transcriptExcerpt);
    console.log("==========================\n");
  }

  // --- Run pre-gates first ---
  const preGateCtx: PreGateContext = {
    telemetry,
    skillName: skill,
    transcriptExcerpt,
  };
  const preGateResult = runPreGates(expectations, preGateCtx);

  let allExpectations: GradingExpectation[];

  if (preGateResult.remaining.length === 0) {
    // All expectations resolved by pre-gates — skip LLM entirely
    console.error(
      `[INFO] All ${expectations.length} expectations resolved by pre-gates, skipping LLM`,
    );
    allExpectations = preGateResult.resolved;
  } else {
    // Build prompt and grade remaining via LLM
    console.error(
      `[INFO] Pre-gates resolved ${preGateResult.resolved.length}/${expectations.length} expectations`,
    );
    const prompt = buildGradingPrompt(preGateResult.remaining, telemetry, transcriptExcerpt, skill);
    console.error(`Grading ${preGateResult.remaining.length} expectations for skill '${skill}'...`);

    let graderOutput: GraderOutput;
    try {
      graderOutput = await gradeViaAgent(prompt, agent);
    } catch (e) {
      console.error(`[ERROR] Grading failed: ${e}`);
      process.exit(1);
    }

    // Default scores on LLM results
    const llmExpectations = (graderOutput.expectations ?? []).map((e) => ({
      ...e,
      score: e.score ?? (e.passed ? 1.0 : 0.0),
      source: e.source ?? ("llm" as const),
    }));

    // Merge pre-gate + LLM results
    allExpectations = [...preGateResult.resolved, ...llmExpectations];
  }

  // Compute graduated summary
  const graduated = buildGraduatedSummary(allExpectations);
  const passedCount = allExpectations.filter((e) => e.passed).length;
  const totalCount = allExpectations.length;

  const result: GradingResult = {
    session_id: sessionId,
    skill_name: skill,
    transcript_path: transcriptPath,
    graded_at: new Date().toISOString(),
    expectations: allExpectations,
    summary: {
      passed: passedCount,
      failed: totalCount - passedCount,
      total: totalCount,
      pass_rate: totalCount > 0 ? passedCount / totalCount : 0,
      mean_score: graduated.mean_score,
      score_std_dev: graduated.score_std_dev,
    },
    execution_metrics: buildExecutionMetrics(telemetry),
    claims: [],
    eval_feedback: { suggestions: [], overall: "" },
  };

  const outputPath = values.output ?? "grading.json";
  const outputDir = dirname(outputPath);
  if (outputDir !== ".") {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");

  printSummary(result);
  console.log(`\nWrote ${outputPath}`);
}

// Guard: only run when invoked directly
if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
