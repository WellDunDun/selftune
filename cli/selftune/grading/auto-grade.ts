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

import { AGENT_CANDIDATES, TELEMETRY_LOG } from "../constants.js";
import { openDb } from "../localdb/db.js";
import { querySessionTelemetry, querySkillUsageRecords } from "../localdb/queries.js";
import type { GradingResult, SessionTelemetryRecord, SkillUsageRecord } from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { detectAgent as _detectAgent } from "../utils/llm-call.js";
import { readExcerpt } from "../utils/transcript.js";
import {
  buildDefaultGradingOutputPath,
  deriveExpectationsFromSkill,
  gradeSession,
  resolveLatestSessionForSkill,
  resolveSessionById,
} from "./grade-session.js";

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      "session-id": { type: "string" },
      "telemetry-log": { type: "string", default: TELEMETRY_LOG },
      output: { type: "string" },
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
  --output            Output path for grading JSON (default: ~/.selftune/grading/result-<session>.json)
  --agent             Agent CLI to use (${AGENT_CANDIDATES.join(", ")})
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
  const validAgents = [...AGENT_CANDIDATES];
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
      `[ERROR] No supported agent CLI (${AGENT_CANDIDATES.join("/")}) found in PATH.\n` +
        "Install one of the supported agent CLIs.",
    );
    process.exit(1);
  }

  console.error(`[INFO] Auto-grade via agent: ${agent}`);

  // --- Auto-find session ---
  const telemetryLog = values["telemetry-log"] ?? TELEMETRY_LOG;
  let telRecords: SessionTelemetryRecord[];
  let skillUsageRecords: SkillUsageRecord[];
  if (telemetryLog === TELEMETRY_LOG) {
    const db = openDb();
    try {
      telRecords = querySessionTelemetry(db) as SessionTelemetryRecord[];
      skillUsageRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
    } finally {
      db.close();
    }
  } else {
    telRecords = readJsonl<SessionTelemetryRecord>(telemetryLog);
    skillUsageRecords = [];
  }

  let telemetry: SessionTelemetryRecord;
  let sessionId: string;
  let transcriptPath: string;

  if (values["session-id"]) {
    sessionId = values["session-id"];
    const resolved = resolveSessionById(telRecords, sessionId);
    if (!resolved) {
      console.error(
        `[ERROR] Session '${sessionId}' not found in telemetry or recoverable transcript data. ` +
          "Check the session ID or omit --session-id to auto-select the latest matching session.",
      );
      process.exit(1);
    }
    telemetry = resolved.telemetry;
    transcriptPath = resolved.transcriptPath;
  } else {
    const resolved = resolveLatestSessionForSkill(telRecords, skillUsageRecords, skill);
    if (!resolved) {
      console.error(
        `[ERROR] No session found for skill '${skill}'. Run the skill first, or pass --session-id.`,
      );
      process.exit(1);
    }
    telemetry = resolved.telemetry;
    sessionId = resolved.sessionId ?? "unknown";
    transcriptPath = resolved.transcriptPath ?? "";
    const note =
      resolved.source === "telemetry" ? "" : ` (${resolved.source.replaceAll("_", " ")})`;
    console.error(`[INFO] Found most recent '${skill}' session: ${sessionId}${note}`);
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

  let result: GradingResult;
  try {
    result = await gradeSession({
      expectations,
      telemetry,
      sessionId,
      skillName: skill,
      transcriptExcerpt,
      transcriptPath,
      agent,
    });
  } catch (err) {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const outputPath = values.output ?? buildDefaultGradingOutputPath(sessionId);
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
