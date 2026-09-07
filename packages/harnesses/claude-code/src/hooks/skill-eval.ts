#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook: skill-eval.ts
 *
 * Fires whenever Claude reads a file or invokes a skill. If the file is a
 * SKILL.md or the tool is a Skill invocation, this hook:
 *   1. Finds the triggering user query from the transcript JSONL
 *   2. Writes a usage record to SQLite via writeSkillUsageToDb()
 *
 * This builds a real-usage eval dataset over time, seeding the
 * `should_trigger: true` half of trigger evals.
 */

import { Option, Schema } from "effect";
import {
  decodeTranscriptLine,
  decodeTranscriptToolInput,
} from "@selftune/runtime/utils/transcript-contract";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { CANONICAL_LOG, SKILL_LOG } from "@selftune/runtime/constants";
import {
  appendCanonicalRecord,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
  getLatestPromptIdentity,
} from "@selftune/runtime/normalization";
import { PostToolUsePayload, type SkillUsageRecord } from "@selftune/runtime/types";
import {
  classifySkillPath,
  computeSkillVersionHash,
  isTestFixturePath,
} from "@selftune/runtime/utils/skill-discovery";
import { getLastUserMessage } from "@selftune/runtime/utils/transcript";

import {
  SILENT_HOOK_SUCCESS,
  type HookExecutionResult,
  writeHookExecutionResult,
} from "./execution-result.js";

/**
 * Extract the skill folder name from a file path ending in SKILL.md.
 * Returns null if this doesn't look like a skill file.
 */
export function extractSkillName(filePath: string): string | null {
  if (basename(filePath).toUpperCase() !== "SKILL.MD") return null;
  return basename(dirname(filePath)) || "unknown";
}

/**
 * Check whether the transcript contains a Skill tool invocation for the given
 * skill name, indicating an actual skill use rather than casual browsing.
 * Scans the transcript backwards for efficiency.
 */
export function hasSkillToolInvocation(transcriptPath: string, skillName: string): boolean {
  return countSkillToolInvocations(transcriptPath, skillName) > 0;
}

export function countSkillToolInvocations(transcriptPath: string, skillName: string): number {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    let matches = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = decodeTranscriptLine(lines[i]);
      if (Option.isNone(parsed)) continue;
      const entry = parsed.value;
      const msg = entry.message ?? entry;
      const role = msg.role ?? entry.role ?? "";
      if (role !== "assistant") continue;
      const content = msg.content ?? entry.content;
      if (content === undefined || Schema.is(Schema.String)(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || block.name !== "Skill") continue;
        const input = decodeTranscriptToolInput(block.input ?? {});
        if ((input.skill ?? input.name) === skillName) matches += 1;
      }
    }

    return matches;
  } catch {
    // silent — hooks must never block Claude
  }

  return 0;
}

export function findLatestSkillToolInvocationId(
  transcriptPath: string,
  skillName: string,
): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;

  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = decodeTranscriptLine(lines[i]);
      if (Option.isNone(parsed)) continue;
      const entry = parsed.value;
      const msg = entry.message ?? entry;
      if ((msg.role ?? entry.role) !== "assistant") continue;
      const content = msg.content ?? entry.content;
      if (content === undefined || Schema.is(Schema.String)(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || block.name !== "Skill") continue;
        const input = decodeTranscriptToolInput(block.input ?? {});
        if (input.skill === skillName || input.name === skillName) return block.id;
      }
    }
  } catch {
    // Hooks remain fail-open when transcript data is incomplete.
  }
  return undefined;
}

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended, or null if skipped.
 *
 * Handles two PostToolUse event types:
 *   - Read: when a SKILL.md file is read (original path)
 *   - Skill: when a skill is explicitly invoked via the Skill tool
 *
 * For Read events, checks whether the Read of SKILL.md was
 * preceded by an actual Skill tool invocation in the same transcript.
 * If not, the record is still logged but marked as triggered: false.
 */
export async function processToolUse(
  payload: PostToolUsePayload,
  logPath: string = SKILL_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  promptStatePath?: string,
): Promise<SkillUsageRecord | null> {
  // Handle Skill tool invocations (e.g., Skill(selftune))
  if (payload.tool_name === "Skill") {
    return await processSkillToolUse(payload, logPath, canonicalLogPath, promptStatePath);
  }

  // Only care about Read tool for SKILL.md detection
  if (payload.tool_name !== "Read") return null;

  const filePath = decodeTranscriptToolInput(payload.tool_input).file_path ?? "";
  const skillName = extractSkillName(filePath);

  if (skillName === null) return null;
  if (isTestFixturePath(filePath)) return null;

  const transcriptPath = payload.transcript_path ?? "";
  const sessionId = payload.session_id ?? "unknown";

  const query = getLastUserMessage(transcriptPath);
  if (!query) return null;

  // Distinguish actual invocation from browsing by checking for a Skill tool call
  const invocationCount = countSkillToolInvocations(transcriptPath, skillName);
  const wasInvoked = invocationCount > 0;
  const skillPathMetadata = classifySkillPath(filePath);
  const skillVersionHash = computeSkillVersionHash(filePath);

  const record: SkillUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill_name: skillName,
    skill_path: filePath,
    ...skillPathMetadata,
    query,
    triggered: wasInvoked,
    invocation_type: "contextual",
    source: "claude_code",
  };
  if (skillVersionHash) record.skill_version_hash = skillVersionHash;

  const baseInput: CanonicalBaseInput = {
    platform: "claude_code",
    capture_mode: "hook",
    source_session_kind: "interactive",
    session_id: sessionId,
    raw_source_ref: {
      path: transcriptPath || undefined,
      event_type: "PostToolUse",
    },
  };
  const latestPrompt = getLatestPromptIdentity(sessionId, promptStatePath, canonicalLogPath);
  const promptId =
    latestPrompt.last_actionable_prompt_id ??
    latestPrompt.last_prompt_id ??
    derivePromptId(sessionId, 0);
  const { invocation_mode, confidence } = deriveInvocationMode({
    has_skill_tool_call: wasInvoked,
    has_skill_md_read: !wasInvoked,
    hook_invocation_type: "contextual",
  });
  const canonical = buildCanonicalSkillInvocation({
    ...baseInput,
    skill_invocation_id: deriveSkillInvocationId(
      sessionId,
      skillName,
      Math.max(invocationCount - 1, 0),
      findLatestSkillToolInvocationId(transcriptPath, skillName),
    ),
    occurred_at: record.timestamp,
    matched_prompt_id: promptId,
    skill_name: skillName,
    skill_path: filePath,
    skill_version_hash: skillVersionHash,
    invocation_mode,
    triggered: wasInvoked,
    confidence,
    tool_name: payload.tool_name,
  });

  // Write unified record to skill_invocations (replaces separate writeSkillUsageToDb call)
  try {
    const { writeSkillCheckToDb } = await import("@selftune/runtime/localdb/direct-write");
    writeSkillCheckToDb({
      ...canonical,
      query: record.query,
      skill_path: record.skill_path,
      skill_scope: record.skill_scope,
      source: record.source,
    });
  } catch {
    /* hooks must never block */
  }

  appendCanonicalRecord(canonical, canonicalLogPath);

  return record;
}

/**
 * Classify how a Skill tool invocation was triggered:
 *
 *   explicit  — User typed /skillName (slash command) or skill was already loaded
 *   implicit  — User mentioned the skill by name in their prompt; Claude invoked it
 *   inferred  — User never mentioned the skill; Claude chose it autonomously
 *
 * Examples:
 *   "/selftune"                    → explicit (slash command)
 *   "setup selftune"               → implicit (user named the skill)
 *   "show me the dashboard" → Browser → inferred (user never said "browser")
 */
function classifyInvocationType(
  query: string,
  skillName: string,
): "explicit" | "implicit" | "inferred" {
  const trimmed = query.trim();
  const skillLower = skillName.toLowerCase();

  // /selftune or /selftune args
  if (trimmed.toLowerCase().startsWith(`/${skillLower}`)) return "explicit";

  // <command-name>/selftune</command-name> pattern (skill already loaded)
  if (trimmed.includes(`<command-name>/${skillLower}</command-name>`)) return "explicit";
  if (trimmed.includes(`<command-name>${skillLower}</command-name>`)) return "explicit";

  // User mentioned the skill name in their prompt (case-insensitive word boundary)
  const mentionPattern = new RegExp(
    `\\b${skillLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  if (mentionPattern.test(trimmed)) return "implicit";

  // Claude chose this skill entirely on its own
  return "inferred";
}

/**
 * Handle Skill tool invocations (e.g., Skill(selftune), Skill(Browser)).
 * The tool_input contains { skill: "skillName", args?: "..." }.
 * Classifies as explicit, implicit, or inferred based on user prompt.
 */
/**
 * Detect if the current transcript belongs to a subagent.
 * Returns the agent type (e.g., "Explore", "Engineer") or "main".
 */
function detectAgentType(transcriptPath: string): string {
  if (!transcriptPath) return "main";
  try {
    // Subagent transcripts live under .../subagents/agent-<id>.jsonl
    if (!/[/\\]subagents[/\\]/.test(transcriptPath)) return "main";
    const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
    if (existsSync(metaPath)) {
      const meta = Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            agentType: Schema.optionalKey(Schema.String),
          }),
        ),
      )(readFileSync(metaPath, "utf-8"));
      return Option.isSome(meta) ? (meta.value.agentType ?? "subagent") : "subagent";
    }
    return "subagent";
  } catch {
    return "main";
  }
}

async function processSkillToolUse(
  payload: PostToolUsePayload,
  _logPath: string,
  canonicalLogPath: string,
  promptStatePath?: string,
): Promise<SkillUsageRecord | null> {
  const skillName = decodeTranscriptToolInput(payload.tool_input).skill;
  if (!skillName) return null;

  const transcriptPath = payload.transcript_path ?? "";
  const sessionId = payload.session_id ?? "unknown";

  const query = getLastUserMessage(transcriptPath);
  if (!query) return null;

  const invocationType = classifyInvocationType(query, skillName);
  const invocationIndex = countSkillToolInvocations(transcriptPath, skillName) - 1;

  const record: SkillUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill_name: skillName,
    skill_path: "",
    query,
    triggered: true,
    invocation_type: invocationType,
    source: "claude_code",
  };

  const baseInput: CanonicalBaseInput = {
    platform: "claude_code",
    capture_mode: "hook",
    source_session_kind: "interactive",
    session_id: sessionId,
    raw_source_ref: {
      path: transcriptPath || undefined,
      event_type: "PostToolUse",
    },
  };
  const latestPrompt = getLatestPromptIdentity(sessionId, promptStatePath, canonicalLogPath);
  const promptId =
    latestPrompt.last_actionable_prompt_id ??
    latestPrompt.last_prompt_id ??
    derivePromptId(sessionId, 0);
  const { invocation_mode, confidence } = deriveInvocationMode({
    hook_invocation_type: invocationType,
  });
  // Detect if this invocation is from a subagent
  const agentType = detectAgentType(transcriptPath);

  const canonical = buildCanonicalSkillInvocation({
    ...baseInput,
    skill_invocation_id: deriveSkillInvocationId(
      sessionId,
      skillName,
      Math.max(invocationIndex, 0),
      payload.tool_use_id,
    ),
    occurred_at: record.timestamp,
    matched_prompt_id: promptId,
    skill_name: skillName,
    skill_path: "",
    invocation_mode,
    triggered: true,
    confidence,
    tool_name: payload.tool_name,
    agent_type: agentType,
  });

  // Write unified record to skill_invocations (replaces separate writeSkillUsageToDb call)
  try {
    const { writeSkillCheckToDb } = await import("@selftune/runtime/localdb/direct-write");
    writeSkillCheckToDb({
      ...canonical,
      query: record.query,
      skill_path: record.skill_path,
      skill_scope: record.skill_scope,
      source: record.source,
    });
  } catch {
    /* hooks must never block */
  }

  appendCanonicalRecord(canonical, canonicalLogPath);

  return record;
}

export async function runSkillEvalHook(rawStdin: string): Promise<HookExecutionResult> {
  try {
    const preview = rawStdin.slice(0, 4096);

    // Fast-path: skill-eval only handles PostToolUse events.
    if (!preview.includes('"PostToolUse"')) return SILENT_HOOK_SUCCESS;

    // Secondary fast-path: only Read and Skill tools are relevant.
    // Most PostToolUse events are for Bash/Write/Edit — skip those entirely.
    if (!preview.includes('"Read"') && !preview.includes('"Skill"')) {
      return SILENT_HOOK_SUCCESS;
    }

    const payload = Schema.decodeUnknownSync(Schema.fromJsonString(PostToolUsePayload))(rawStdin);
    await processToolUse(payload);
  } catch {
    // silent — hooks must never block Claude
  }
  return SILENT_HOOK_SUCCESS;
}

export async function cliMain(stdinText?: string): Promise<number> {
  const rawStdin = stdinText ?? (await Bun.stdin.text());
  return writeHookExecutionResult(await runSkillEvalHook(rawStdin));
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  process.exitCode = await cliMain();
}
