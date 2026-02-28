#!/usr/bin/env bun
/**
 * grade-session.ts
 *
 * Rubric-based grader for Claude Code skill sessions.
 * Migrated from grade_session.py.
 *
 * Two modes:
 *   1. --use-agent  (default when no ANTHROPIC_API_KEY) — invokes installed agent CLI
 *   2. --use-api    (default when ANTHROPIC_API_KEY set) — calls Anthropic API directly
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { TELEMETRY_LOG } from "../constants.js";
import type {
  ExecutionMetrics,
  GraderOutput,
  GradingResult,
  SessionTelemetryRecord,
} from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import {
  detectAgent as _detectAgent,
  stripMarkdownFences as _stripMarkdownFences,
  callViaAgent,
  callViaApi,
} from "../utils/llm-call.js";
import { readExcerpt } from "../utils/transcript.js";

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
    {"text": "...", "passed": true/false, "evidence": "specific quote or metric"}
  ],
  "summary": {"passed": N, "failed": N, "total": N, "pass_rate": 0.0},
  "claims": [
    {"claim": "...", "type": "factual|process|quality", "verified": true/false, "evidence": "..."}
  ],
  "eval_feedback": {
    "suggestions": [{"assertion": "...", "reason": "..."}],
    "overall": "one sentence"
  }
}

Rules:
- PASS only when there is clear, specific evidence — not assumptions
- FAIL when evidence is absent or contradictory
- Cite exact quotes or specific metric values
- Extract 2-4 implicit claims from the transcript and verify them
- Suggest eval improvements only for clear gaps`;

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
  const data = JSON.parse(readFileSync(evalsJsonPath, "utf-8"));
  for (const ev of data.evals ?? []) {
    if (ev.id === evalId) return ev.expectations ?? [];
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
  return JSON.parse(_stripMarkdownFences(raw)) as GraderOutput;
}

// ---------------------------------------------------------------------------
// Grading via direct Anthropic API
// ---------------------------------------------------------------------------

export async function gradeViaApi(prompt: string): Promise<GraderOutput> {
  const raw = await callViaApi(GRADER_SYSTEM, prompt);
  return JSON.parse(_stripMarkdownFences(raw)) as GraderOutput;
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
  return {
    session_id: sessionId ?? "unknown",
    skill_name: skillName ?? "unknown",
    transcript_path: transcriptPath ?? "",
    graded_at: new Date().toISOString(),
    expectations: graderOutput?.expectations ?? [],
    summary: graderOutput?.summary ?? { passed: 0, failed: 0, total: 0, pass_rate: 0 },
    execution_metrics: buildExecutionMetrics(telemetry ?? ({} as SessionTelemetryRecord)),
    claims: graderOutput?.claims ?? [],
    eval_feedback: graderOutput?.eval_feedback ?? { suggestions: [], overall: "" },
  };
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

function printSummary(result: GradingResult): void {
  const { summary } = result;
  const rate = summary.pass_rate ?? 0;
  console.log(`\nResults: ${summary.passed}/${summary.total} passed (${Math.round(rate * 100)}%)`);
  for (const exp of result.expectations) {
    const icon = exp.passed ? "\u2713" : "\u2717";
    console.log(`  ${icon} ${exp.text.slice(0, 70)}`);
    if (!exp.passed) {
      console.log(`      -> ${exp.evidence.slice(0, 100)}`);
    }
  }

  const feedback = result.eval_feedback;
  if (feedback.suggestions?.length) {
    console.log(`\nEval feedback: ${feedback.overall}`);
    for (const s of feedback.suggestions) {
      console.log(`  * ${s.reason.slice(0, 100)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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
      "use-agent": { type: "boolean", default: false },
      "use-api": { type: "boolean", default: false },
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

  // --- Determine mode ---
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  let mode: "agent" | "api";
  let agent: string | null = null;

  if (values["use-api"]) {
    mode = "api";
  } else if (values["use-agent"]) {
    mode = "agent";
  } else {
    const availableAgent = _detectAgent();
    if (availableAgent) {
      mode = "agent";
    } else if (hasApiKey) {
      mode = "api";
    } else {
      console.error(
        "[ERROR] No agent CLI (claude/codex/opencode) found in PATH " +
          "and ANTHROPIC_API_KEY not set.\n" +
          "Install Claude Code, Codex, or OpenCode, or set ANTHROPIC_API_KEY.",
      );
      process.exit(1);
    }
  }

  if (mode === "agent") {
    const validAgents = ["claude", "codex", "opencode"];
    if (values.agent && validAgents.includes(values.agent)) {
      agent = values.agent;
    } else {
      agent = _detectAgent();
    }
    if (!agent) {
      console.error(
        "[ERROR] --use-agent specified but no agent found in PATH.\n" +
          "Install claude, codex, or opencode, or use --use-api instead.",
      );
      process.exit(1);
    }
    console.error(`[INFO] Grading via agent: ${agent}`);
  } else {
    console.error("[INFO] Grading via direct Anthropic API");
  }

  // --- Resolve expectations ---
  let expectations: string[] = [];
  if (values["evals-json"] && values["eval-id"] != null) {
    expectations = loadExpectationsFromEvalsJson(values["evals-json"], Number(values["eval-id"]));
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

  // --- Build prompt and grade ---
  const prompt = buildGradingPrompt(expectations, telemetry, transcriptExcerpt, skill);

  console.error(`Grading ${expectations.length} expectations for skill '${skill}'...`);

  let graderOutput: GraderOutput;
  try {
    if (mode === "agent") {
      graderOutput = await gradeViaAgent(prompt, agent as string);
    } else {
      graderOutput = await gradeViaApi(prompt);
    }
  } catch (e) {
    console.error(`[ERROR] Grading failed: ${e}`);
    process.exit(1);
  }

  const result = assembleResult(graderOutput, telemetry, sessionId, skill, transcriptPath);

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
const isMain =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("grade-session.ts");

if (isMain) {
  main().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
