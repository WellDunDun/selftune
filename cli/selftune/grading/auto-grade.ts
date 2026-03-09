#!/usr/bin/env bun
/**
 * auto-grade.ts
 *
 * Frictionless grading command that auto-finds the most recent real session
 * for a skill, auto-derives expectations from SKILL.md, grades, and outputs results.
 *
 * Usage:
 *   selftune auto-grade --skill <name> [--skill-path <path>] [--output <path>] [--agent <agent>]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { TELEMETRY_LOG } from "../constants.js";
import type { GraderOutput, GradingResult, SessionTelemetryRecord } from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { detectAgent as _detectAgent } from "../utils/llm-call.js";
import { readExcerpt } from "../utils/transcript.js";
import { type PreGateContext, runPreGates } from "./pre-gates.js";
import {
  buildExecutionMetrics,
  buildGradingPrompt,
  buildGraduatedSummary,
  deriveExpectationsFromSkill,
  gradeViaAgent,
  latestSessionForSkill,
} from "./grade-session.js";

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      "session-id": { type: "string" },
      "telemetry-log": { type: "string", default: TELEMETRY_LOG },
      output: { type: "string", default: "grading.json" },
      agent: { type: "string" },
      "show-transcript": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune auto-grade — Frictionless skill session grading

Usage:
  selftune auto-grade --skill <name> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (auto-detected if omitted)
  --session-id        Grade a specific session (auto-detects most recent if omitted)
  --telemetry-log     Path to telemetry log (default: ~/.claude/session_telemetry_log.jsonl)
  --output            Output path for grading JSON (default: grading.json)
  --agent             Agent CLI to use (claude, codex, opencode)
  --show-transcript   Print transcript excerpt before grading
  -h, --help          Show this help message`);
    process.exit(0);
  }

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

  console.error(`[INFO] Auto-grade via agent: ${agent}`);

  // --- Auto-find session ---
  const telemetryLog = values["telemetry-log"] ?? TELEMETRY_LOG;
  const telRecords = readJsonl<SessionTelemetryRecord>(telemetryLog);

  let telemetry: SessionTelemetryRecord;
  let sessionId: string;
  let transcriptPath: string;

  if (values["session-id"]) {
    sessionId = values["session-id"];
    const found = telRecords.find(
      (r) => r.session_id === sessionId,
    );
    telemetry = found ?? ({} as SessionTelemetryRecord);
    transcriptPath = telemetry.transcript_path ?? "";
    if (!found) {
      console.error(`[WARN] Session '${sessionId}' not found in telemetry log`);
    }
  } else {
    const found = latestSessionForSkill(telRecords, skill);
    if (!found) {
      console.error(
        `[ERROR] No session found for skill '${skill}'. Run the skill first, or pass --session-id.`,
      );
      process.exit(1);
    }
    telemetry = found;
    sessionId = found.session_id ?? "unknown";
    transcriptPath = found.transcript_path ?? "";
    console.error(`[INFO] Found most recent '${skill}' session: ${sessionId}`);
  }

  const transcriptExcerpt = transcriptPath ? readExcerpt(transcriptPath) : "(no transcript)";

  if (values["show-transcript"]) {
    console.log("=== TRANSCRIPT EXCERPT ===");
    console.log(transcriptExcerpt);
    console.log("==========================\n");
  }

  // --- Auto-derive expectations ---
  const derived = deriveExpectationsFromSkill(skill, values["skill-path"]);
  if (derived.derived) {
    console.error(
      `[INFO] Auto-derived ${derived.expectations.length} expectations from ${derived.source}`,
    );
  } else {
    console.error(`[WARN] Using generic expectations (${derived.source})`);
  }
  const expectations = derived.expectations;

  // --- Run pre-gates ---
  const preGateCtx: PreGateContext = {
    telemetry,
    skillName: skill,
    transcriptExcerpt,
  };
  const preGateResult = runPreGates(expectations, preGateCtx);

  let allExpectations: import("../types.js").GradingExpectation[];

  if (preGateResult.remaining.length === 0) {
    console.error(
      `[INFO] All ${expectations.length} expectations resolved by pre-gates, skipping LLM`,
    );
    allExpectations = preGateResult.resolved;
  } else {
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

    const llmExpectations = (graderOutput.expectations ?? []).map((e) => ({
      ...e,
      score: e.score ?? (e.passed ? 1.0 : 0.0),
      source: e.source ?? ("llm" as const),
    }));

    allExpectations = [...preGateResult.resolved, ...llmExpectations];
  }

  // --- Assemble result ---
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

  // Print summary
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

  console.log(`\nWrote ${outputPath}`);
}

// Guard: only run when invoked directly
if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
