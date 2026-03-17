/**
 * baseline.ts
 *
 * Measures the value a skill adds over a no-skill baseline.
 *
 * Runs trigger checks against an EMPTY string description (no-skill baseline)
 * and against the current description (with-skill), then computes lift.
 * A skill "adds value" when lift >= 0.05 (5 percentage points).
 */

import { parseArgs } from "node:util";

import type { BaselineResult, EvalEntry } from "../types.js";
import { callLlm } from "../utils/llm-call.js";
import { buildTriggerCheckPrompt, parseTriggerResponse } from "../utils/trigger-check.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaselineOptions {
  evalSet: EvalEntry[];
  skillDescription: string;
  skillName: string;
  agent: string;
  modelFlag?: string;
}

export interface BaselineMeasurement {
  skill_name: string;
  baseline_pass_rate: number;
  with_skill_pass_rate: number;
  lift: number;
  adds_value: boolean;
  per_entry: BaselineResult[];
  measured_at: string;
}

/**
 * Injectable dependencies for measureBaseline(). When omitted, the real
 * module imports are used. Pass overrides in tests to avoid real LLM calls.
 */
export interface BaselineDeps {
  callLlm?: typeof callLlm;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIFT_THRESHOLD = 0.05;
const SYSTEM_PROMPT = "You are an evaluation assistant. Answer only YES or NO.";

// ---------------------------------------------------------------------------
// Core measurement
// ---------------------------------------------------------------------------

/** Measure baseline vs. with-skill trigger accuracy across an eval set. */
export async function measureBaseline(
  options: BaselineOptions,
  _deps: BaselineDeps = {},
): Promise<BaselineMeasurement> {
  const { evalSet, skillDescription, skillName, agent, modelFlag } = options;
  const _callLlm = _deps.callLlm ?? callLlm;

  if (evalSet.length === 0) {
    return {
      skill_name: skillName,
      baseline_pass_rate: 0,
      with_skill_pass_rate: 0,
      lift: 0,
      adds_value: false,
      per_entry: [],
      measured_at: new Date().toISOString(),
    };
  }

  const perEntry: BaselineResult[] = [];
  let baselinePassed = 0;
  let withSkillPassed = 0;

  for (const entry of evalSet) {
    // --- Baseline check (empty description) ---
    const baselinePrompt = buildTriggerCheckPrompt("", entry.query);
    const baselineRaw = await _callLlm(SYSTEM_PROMPT, baselinePrompt, agent, modelFlag);
    const baselineTriggered = parseTriggerResponse(baselineRaw);
    const baselinePass =
      (entry.should_trigger && baselineTriggered) || (!entry.should_trigger && !baselineTriggered);

    if (baselinePass) baselinePassed++;

    perEntry.push({
      skill_name: skillName,
      query: entry.query,
      with_skill: false,
      triggered: baselineTriggered,
      pass: baselinePass,
      measured_at: new Date().toISOString(),
    });

    // --- With-skill check (actual description) ---
    const withSkillPrompt = buildTriggerCheckPrompt(skillDescription, entry.query);
    const withSkillRaw = await _callLlm(SYSTEM_PROMPT, withSkillPrompt, agent, modelFlag);
    const withSkillTriggered = parseTriggerResponse(withSkillRaw);
    const withSkillPass =
      (entry.should_trigger && withSkillTriggered) ||
      (!entry.should_trigger && !withSkillTriggered);

    if (withSkillPass) withSkillPassed++;

    perEntry.push({
      skill_name: skillName,
      query: entry.query,
      with_skill: true,
      triggered: withSkillTriggered,
      pass: withSkillPass,
      measured_at: new Date().toISOString(),
    });
  }

  const total = evalSet.length;
  const baselinePassRate = baselinePassed / total;
  const withSkillPassRate = withSkillPassed / total;
  const lift = withSkillPassRate - baselinePassRate;

  return {
    skill_name: skillName,
    baseline_pass_rate: baselinePassRate,
    with_skill_pass_rate: withSkillPassRate,
    lift,
    adds_value: lift >= LIFT_THRESHOLD,
    per_entry: perEntry,
    measured_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      "eval-set": { type: "string" },
      agent: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune grade baseline — Measure skill value vs. no-skill baseline

Usage:
  selftune grade baseline --skill <name> --skill-path <path> [options]

Options:
  --skill         Skill name (required)
  --skill-path    Path to SKILL.md (required)
  --eval-set      Path to eval set JSON (optional, builds from logs if omitted)
  --agent         Agent CLI to use (claude, codex, opencode)
  --help          Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    console.error("[ERROR] --skill and --skill-path are required");
    process.exit(1);
  }

  const { existsSync, readFileSync } = await import("node:fs");

  // Read skill description
  const skillPath = values["skill-path"];
  if (!existsSync(skillPath)) {
    console.error(`[ERROR] SKILL.md not found at ${skillPath}`);
    process.exit(1);
  }
  const skillDescription = readFileSync(skillPath, "utf-8");

  // Load eval set
  let evalSet: EvalEntry[];
  if (values["eval-set"] && existsSync(values["eval-set"])) {
    const raw = readFileSync(values["eval-set"], "utf-8");
    evalSet = JSON.parse(raw) as EvalEntry[];
  } else {
    // Build from logs via SQLite
    const { getDb } = await import("../localdb/db.js");
    const { querySkillUsageRecords, queryQueryLog } = await import("../localdb/queries.js");
    const { buildEvalSet } = await import("./hooks-to-evals.js");
    const db = getDb();
    const skillRecords = querySkillUsageRecords(db);
    const queryRecords = queryQueryLog(db);
    evalSet = buildEvalSet(skillRecords as Parameters<typeof buildEvalSet>[0], queryRecords as Parameters<typeof buildEvalSet>[1], values.skill);
  }

  // Detect agent
  const { detectAgent } = await import("../utils/llm-call.js");
  const requestedAgent = values.agent;
  if (requestedAgent && !Bun.which(requestedAgent)) {
    console.error(
      JSON.stringify({
        level: "error",
        code: "agent_not_in_path",
        message: `Agent CLI '${requestedAgent}' not found in PATH.`,
        action: "Install it or omit --agent to use auto-detection.",
      }),
    );
    process.exit(1);
  }
  const agent = requestedAgent ?? detectAgent();
  if (!agent) {
    console.error(
      JSON.stringify({
        level: "error",
        code: "agent_not_found",
        message: "No agent CLI (claude/codex/opencode) found in PATH.",
        action: "Install Claude Code, Codex, or OpenCode.",
      }),
    );
    process.exit(1);
  }

  const result = await measureBaseline({
    evalSet,
    skillDescription,
    skillName: values.skill,
    agent,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.adds_value ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    process.exit(1);
  });
}
