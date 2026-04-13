#!/usr/bin/env bun
/**
 * grade-session.ts
 *
 * Rubric-based grader for Claude Code skill sessions.
 * Migrated from grade_session.py.
 *
 * Grades via an installed agent CLI selected from the LLM-backed agent set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { CLAUDE_CODE_PROJECTS_DIR, SELFTUNE_CONFIG_DIR, TELEMETRY_LOG } from "../constants.js";
import { getDb } from "../localdb/db.js";
import { querySessionTelemetry, querySkillUsageRecords } from "../localdb/queries.js";
import type {
  ExecutionMetrics,
  GraderOutput,
  GradingExpectation,
  GradingResult,
  SessionTelemetryRecord,
  SessionType,
  SkillUsageRecord,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import {
  detectLlmAgent as _detectAgent,
  isLlmBackedAgent,
  LLM_BACKED_AGENT_CANDIDATES,
  stripMarkdownFences as _stripMarkdownFences,
  callViaAgent,
} from "../utils/llm-call.js";
import {
  buildTelemetryFromTranscript,
  findTranscriptPathForSession,
  readExcerpt,
} from "../utils/transcript.js";
import { type PreGateContext, runPreGates } from "./pre-gates.js";

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
  // First pass: prefer sessions with actual Skill tool invocations (skills_invoked)
  for (let i = telemetry.length - 1; i >= 0; i--) {
    if (telemetry[i].skills_invoked?.includes(skillName)) return telemetry[i];
  }
  // Fallback: sessions where SKILL.md was read (skills_triggered)
  for (let i = telemetry.length - 1; i >= 0; i--) {
    if (telemetry[i].skills_triggered?.includes(skillName)) return telemetry[i];
  }
  return null;
}

export function latestSkillUsageForSkill(
  skillUsage: SkillUsageRecord[],
  skillName: string,
): SkillUsageRecord | null {
  for (let i = skillUsage.length - 1; i >= 0; i--) {
    const record = skillUsage[i];
    if (record.skill_name === skillName && record.triggered) return record;
  }
  return null;
}

export interface ResolvedSessionContext {
  telemetry: SessionTelemetryRecord;
  sessionId: string;
  transcriptPath: string;
  source: "telemetry" | "transcript_fallback" | "skill_usage_fallback";
}

function buildSkillUsageFallbackTelemetry(record: SkillUsageRecord): SessionTelemetryRecord {
  return {
    timestamp: record.timestamp,
    session_id: record.session_id,
    cwd: "",
    transcript_path: "",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [record.skill_name],
    skills_invoked: [record.skill_name],
    assistant_turns: 0,
    errors_encountered: 0,
    transcript_chars: 0,
    last_user_query: record.query,
    source: record.source ?? "skill_usage_fallback",
  };
}

export function resolveSessionById(
  telemetry: SessionTelemetryRecord[],
  sessionId: string,
  projectsDir: string = CLAUDE_CODE_PROJECTS_DIR,
): ResolvedSessionContext | null {
  const direct = findSession(telemetry, sessionId);
  if (direct) {
    return {
      telemetry: direct,
      sessionId: direct.session_id,
      transcriptPath: direct.transcript_path ?? "",
      source: "telemetry",
    };
  }

  const transcriptPath = findTranscriptPathForSession(sessionId, projectsDir);
  if (!transcriptPath) return null;

  const rebuilt = buildTelemetryFromTranscript(sessionId, transcriptPath);
  if (!rebuilt) return null;

  return {
    telemetry: rebuilt,
    sessionId,
    transcriptPath,
    source: "transcript_fallback",
  };
}

export function resolveLatestSessionForSkill(
  telemetry: SessionTelemetryRecord[],
  skillUsage: SkillUsageRecord[],
  skillName: string,
  projectsDir: string = CLAUDE_CODE_PROJECTS_DIR,
): ResolvedSessionContext | null {
  const direct = latestSessionForSkill(telemetry, skillName);
  if (direct) {
    return {
      telemetry: direct,
      sessionId: direct.session_id,
      transcriptPath: direct.transcript_path ?? "",
      source: "telemetry",
    };
  }

  const usage = latestSkillUsageForSkill(skillUsage, skillName);
  if (!usage) return null;

  const transcriptPath = findTranscriptPathForSession(usage.session_id, projectsDir);
  if (!transcriptPath) {
    const fallback = buildSkillUsageFallbackTelemetry(usage);
    return {
      telemetry: fallback,
      sessionId: fallback.session_id,
      transcriptPath: fallback.transcript_path,
      source: "skill_usage_fallback",
    };
  }

  const rebuilt = buildTelemetryFromTranscript(usage.session_id, transcriptPath);
  if (!rebuilt) {
    const fallback = buildSkillUsageFallbackTelemetry(usage);
    fallback.transcript_path = transcriptPath;
    return {
      telemetry: fallback,
      sessionId: fallback.session_id,
      transcriptPath,
      source: "skill_usage_fallback",
    };
  }

  if (!rebuilt.skills_triggered.includes(skillName)) {
    rebuilt.skills_triggered = [...rebuilt.skills_triggered, skillName];
  }
  if (rebuilt.skills_invoked && !rebuilt.skills_invoked.includes(skillName)) {
    rebuilt.skills_invoked = [...rebuilt.skills_invoked, skillName];
  }
  if (!rebuilt.last_user_query) {
    rebuilt.last_user_query = usage.query;
  }

  return {
    telemetry: rebuilt,
    sessionId: rebuilt.session_id,
    transcriptPath,
    source: "transcript_fallback",
  };
}

export function buildDefaultGradingOutputPath(sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SELFTUNE_CONFIG_DIR, "grading", `result-${safeSessionId}.json`);
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
// Auto-derive expectations from SKILL.md
// ---------------------------------------------------------------------------

export interface DerivedExpectations {
  expectations: string[];
  derived: boolean;
  source: string;
}

const GENERIC_EXPECTATIONS: string[] = [
  "The skill was triggered during the session",
  "The task was completed successfully without critical errors",
  "No unhandled errors were encountered",
];

/**
 * Derive grading expectations from a skill's SKILL.md file.
 *
 * Resolution order for SKILL.md path:
 * 1. Explicit `skillPath` argument
 * 2. Lookup from skill_usage_log.jsonl records
 * 3. Falls back to generic expectations if not found
 */
export function deriveExpectationsFromSkill(
  skillName: string,
  skillPath?: string,
): DerivedExpectations {
  // Resolve the SKILL.md path
  let resolvedPath = skillPath;

  if (!resolvedPath) {
    // Try to find from skill_usage_log via SQLite
    try {
      const db = getDb();
      const usageRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
      for (let i = usageRecords.length - 1; i >= 0; i--) {
        if (usageRecords[i].skill_name === skillName && usageRecords[i].skill_path) {
          resolvedPath = usageRecords[i].skill_path;
          break;
        }
      }
    } catch {
      // DB not available
    }
  }

  if (!resolvedPath || !existsSync(resolvedPath)) {
    return {
      expectations: GENERIC_EXPECTATIONS,
      derived: false,
      source: resolvedPath ? `SKILL.md not found at ${resolvedPath}` : "no SKILL.md path found",
    };
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch {
    return {
      expectations: GENERIC_EXPECTATIONS,
      derived: false,
      source: `failed to read ${resolvedPath}`,
    };
  }

  const expectations: string[] = [`The "${skillName}" skill was triggered during the session`];

  // Extract description from first paragraph after title
  const descMatch = content.match(/^#\s+.+\n+([^\n#][^\n]*)/m);
  if (descMatch) {
    const desc = descMatch[1].trim();
    if (desc.length > 10) {
      expectations.push(`The skill fulfilled its purpose: ${desc.slice(0, 120)}`);
    }
  }

  // Extract "When to Use" section content
  const whenMatch = content.match(/##\s*When\s+to\s+Use\b[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|$)/i);
  if (whenMatch) {
    const lines = whenMatch[1]
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 5);
    if (lines.length > 0) {
      expectations.push(`The session context matched a "When to Use" trigger for ${skillName}`);
    }
  }

  // Add standard quality expectations
  expectations.push("The task was completed successfully without critical errors");
  expectations.push("No unhandled errors were encountered");

  // Cap at 5 expectations
  return {
    expectations: expectations.slice(0, 5),
    derived: true,
    source: resolvedPath,
  };
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
    artifact_count: telemetry.artifact_count,
    session_type: telemetry.session_type,
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

  const sessionType: SessionType = (telemetry.session_type as SessionType) ?? "mixed";
  const SESSION_TYPE_CONTEXT: Record<SessionType, string> = {
    dev: "This is a development session — code output and commits are expected productivity signals.",
    research:
      "This is a research session — information gathering and synthesis are the primary outputs, not code changes.",
    content:
      "This is a content/writing session — document creation is the primary output, not code commits.",
    mixed:
      "This is a mixed session — evaluate based on what was actually accomplished, not code-specific metrics.",
  };
  const sessionTypeContext = SESSION_TYPE_CONTEXT[sessionType] ?? SESSION_TYPE_CONTEXT.mixed;

  return `Skill: ${skillName}

=== SESSION CONTEXT ===
Session type: ${sessionType}
${sessionTypeContext}

=== PROCESS TELEMETRY ===
Skills triggered: ${JSON.stringify(telemetry.skills_triggered ?? [])}
Assistant turns: ${telemetry.assistant_turns ?? "?"}
Errors: ${telemetry.errors_encountered ?? "?"}
Total tool calls: ${telemetry.total_tool_calls ?? "?"}
Artifacts produced: ${telemetry.artifact_count ?? "?"}

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
// Shared grading flow
// ---------------------------------------------------------------------------

function normalizeExpectations(expectations: GradingExpectation[]): GradingExpectation[] {
  return expectations.map((e) => ({
    ...e,
    score: e.score ?? (e.passed ? 1.0 : 0.0),
    source: e.source ?? ("llm" as const),
  }));
}

function assembleResultFromExpectations(
  expectations: GradingExpectation[],
  telemetry: SessionTelemetryRecord,
  sessionId: string,
  skillName: string,
  transcriptPath: string,
): GradingResult {
  const passedCount = expectations.filter((e) => e.passed).length;
  const totalCount = expectations.length;
  const graduated = buildGraduatedSummary(expectations);

  return {
    session_id: sessionId ?? "unknown",
    skill_name: skillName ?? "unknown",
    transcript_path: transcriptPath ?? "",
    graded_at: new Date().toISOString(),
    expectations,
    summary: {
      passed: passedCount,
      failed: totalCount - passedCount,
      total: totalCount,
      pass_rate: totalCount > 0 ? passedCount / totalCount : 0,
      mean_score: graduated.mean_score,
      score_std_dev: graduated.score_std_dev,
    },
    execution_metrics: buildExecutionMetrics(telemetry ?? ({} as SessionTelemetryRecord)),
    claims: [],
    eval_feedback: { suggestions: [], overall: "" },
  };
}

export interface GradeSessionParams {
  expectations: string[];
  telemetry: SessionTelemetryRecord;
  sessionId: string;
  skillName: string;
  transcriptExcerpt: string;
  transcriptPath: string;
  agent: string;
  gradeViaAgentFn?: (prompt: string, agent: string) => Promise<GraderOutput>;
}

export async function gradeSession({
  expectations,
  telemetry,
  sessionId,
  skillName,
  transcriptExcerpt,
  transcriptPath,
  agent,
  gradeViaAgentFn = gradeViaAgent,
}: GradeSessionParams): Promise<GradingResult> {
  const preGateCtx: PreGateContext = {
    telemetry,
    skillName,
    transcriptExcerpt,
  };
  const preGateResult = runPreGates(expectations, preGateCtx);

  let allExpectations: GradingExpectation[];

  if (preGateResult.remaining.length === 0) {
    console.error(
      `[INFO] All ${expectations.length} expectations resolved by pre-gates, skipping LLM`,
    );
    allExpectations = preGateResult.resolved;
  } else {
    console.error(
      `[INFO] Pre-gates resolved ${preGateResult.resolved.length}/${expectations.length} expectations`,
    );
    const prompt = buildGradingPrompt(
      preGateResult.remaining,
      telemetry,
      transcriptExcerpt,
      skillName,
    );
    console.error(
      `Grading ${preGateResult.remaining.length} expectations for skill '${skillName}'...`,
    );

    let graderOutput: GraderOutput;
    try {
      graderOutput = await gradeViaAgentFn(prompt, agent);
    } catch (err) {
      throw new Error(`Grading failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }

    const llmExpectations = normalizeExpectations(graderOutput.expectations ?? []);
    if (llmExpectations.length !== preGateResult.remaining.length) {
      throw new Error(
        `Grader returned ${llmExpectations.length} expectations for ${preGateResult.remaining.length} unresolved expectations`,
      );
    }

    allExpectations = [...preGateResult.resolved, ...llmExpectations];
  }

  return assembleResultFromExpectations(
    allExpectations,
    telemetry,
    sessionId,
    skillName,
    transcriptPath,
  );
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
  const result = assembleResultFromExpectations(
    normalizeExpectations(graderOutput?.expectations ?? []),
    telemetry,
    sessionId,
    skillName,
    transcriptPath,
  );
  return {
    ...result,
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
      "skill-path": { type: "string" },
      expectations: { type: "string", multiple: true },
      "evals-json": { type: "string" },
      "eval-id": { type: "string" },
      "session-id": { type: "string" },
      transcript: { type: "string" },
      "telemetry-log": { type: "string", default: TELEMETRY_LOG },
      output: { type: "string" },
      agent: { type: "string" },
      "show-transcript": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune grade — Grade a skill session

Usage:
  selftune grade --skill <name> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (for auto-deriving expectations)
  --expectations      Expectation strings (repeatable)
  --evals-json        Path to evals JSON file
  --eval-id           Eval ID within evals JSON
  --session-id        Grade a specific session by ID
  --transcript        Path to transcript file
  --telemetry-log     Path to telemetry log (default: ~/.claude/session_telemetry_log.jsonl)
  --output            Output path for grading JSON (default: ~/.selftune/grading/result-<session>.json)
  --agent             Agent CLI to use (${LLM_BACKED_AGENT_CANDIDATES.join(", ")})
  --show-transcript   Print transcript excerpt before grading
  -h, --help          Show this help message`);
    process.exit(0);
  }

  const skill = values.skill;
  if (!skill) {
    throw new CLIError("--skill is required", "MISSING_FLAG", "selftune grade --skill <name>");
  }

  // --- Determine agent ---
  let agent: string | null = null;
  const validAgents = [...LLM_BACKED_AGENT_CANDIDATES];
  if (values.agent) {
    if (!isLlmBackedAgent(values.agent)) {
      throw new CLIError(
        `Invalid --agent '${values.agent}'. Expected one of: ${validAgents.join(", ")}`,
        "INVALID_FLAG",
        `selftune grade --skill <name> --agent ${validAgents[0]}`,
      );
    }
    agent = values.agent;
  } else {
    agent = _detectAgent();
  }

  if (!agent) {
    throw new CLIError(
      `No supported agent CLI (${LLM_BACKED_AGENT_CANDIDATES.join("/")}) found in PATH`,
      "AGENT_NOT_FOUND",
      "Install Claude Code, Codex, OpenCode, or Pi, then retry",
    );
  }

  console.error(`[INFO] Grading via agent: ${agent}`);

  // --- Resolve expectations ---
  let expectations: string[] = [];
  if (values["evals-json"] && values["eval-id"] != null) {
    const evalIdNum = Number(values["eval-id"]);
    if (!Number.isFinite(evalIdNum) || !Number.isInteger(evalIdNum)) {
      throw new CLIError(
        `--eval-id must be a finite integer, got: ${values["eval-id"]}`,
        "INVALID_FLAG",
        "selftune grade --eval-id <integer>",
      );
    }
    expectations = loadExpectationsFromEvalsJson(values["evals-json"], evalIdNum);
  } else if (values.expectations?.length) {
    expectations = values.expectations;
  } else {
    // Auto-derive expectations from SKILL.md
    const derived = deriveExpectationsFromSkill(skill, values["skill-path"]);
    expectations = derived.expectations;
    if (derived.derived) {
      console.error(
        `[INFO] Auto-derived ${derived.expectations.length} expectations from ${derived.source}`,
      );
    } else {
      console.error(
        `[WARN] No --expectations or --evals-json provided. Using generic expectations (${derived.source})`,
      );
    }
  }

  // --- Resolve session ---
  let telemetry = {} as SessionTelemetryRecord;
  let transcriptPath = "";
  let sessionId = "unknown";

  const db = getDb();
  const telRecords = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const skillUsageRecords = querySkillUsageRecords(db) as SkillUsageRecord[];

  if (values.transcript) {
    transcriptPath = values.transcript;
    telemetry =
      buildTelemetryFromTranscript(
        values["session-id"] ?? basename(transcriptPath, ".jsonl"),
        transcriptPath,
      ) ?? ({} as SessionTelemetryRecord);
    for (let i = telRecords.length - 1; i >= 0; i--) {
      if (telRecords[i].transcript_path === transcriptPath) {
        telemetry = telRecords[i];
        sessionId = telRecords[i].session_id ?? "unknown";
        break;
      }
    }
    if (telemetry.session_id) sessionId = telemetry.session_id;
  } else if (values["session-id"]) {
    sessionId = values["session-id"];
    const resolved = resolveSessionById(telRecords, sessionId);
    telemetry = resolved?.telemetry ?? ({} as SessionTelemetryRecord);
    transcriptPath = resolved?.transcriptPath ?? "";
  } else {
    const resolved = resolveLatestSessionForSkill(telRecords, skillUsageRecords, skill);
    telemetry = resolved?.telemetry ?? ({} as SessionTelemetryRecord);
    if (resolved) {
      sessionId = resolved.sessionId;
      transcriptPath = resolved.transcriptPath;
      const note =
        resolved.source === "telemetry" ? "" : ` (${resolved.source.replaceAll("_", " ")})`;
      console.error(`[INFO] Grading most recent '${skill}' session: ${sessionId}${note}`);
    } else {
      console.error(
        `[WARN] No session found for skill '${skill}' in telemetry or recovered usage data.`,
      );
    }
  }

  const transcriptExcerpt = transcriptPath ? readExcerpt(transcriptPath) : "(no transcript)";

  if (values["show-transcript"]) {
    console.log("=== TRANSCRIPT EXCERPT ===");
    console.log(transcriptExcerpt);
    console.log("==========================\n");
  }

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
    throw new CLIError(
      `Grading failed: ${err instanceof Error ? err.message : String(err)}`,
      "OPERATION_FAILED",
      "Check agent availability and try again",
    );
  }

  const outputPath = values.output ?? buildDefaultGradingOutputPath(sessionId);
  const outputDir = dirname(outputPath);
  if (outputDir !== ".") {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");

  // Persist to SQLite for upload staging (fail-open)
  try {
    const { writeGradingResultToDb } = await import("../localdb/direct-write.js");
    writeGradingResultToDb(result);
  } catch {
    // fail-open: grading file is already written above
  }

  printSummary(result);
  console.log(`\nWrote ${outputPath}`);
}

// Guard: only run when invoked directly
if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
