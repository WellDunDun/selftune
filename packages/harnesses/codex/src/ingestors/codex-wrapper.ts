#!/usr/bin/env bun
/**
 * Codex CLI wrapper: codex-wrapper.ts
 *
 * Drop-in wrapper for `codex exec --json` that tees the JSONL event stream
 * into our shared skill eval log format.
 *
 * Usage:
 *   bun codex-wrapper.ts --full-auto "make me a slide deck"
 *
 * The wrapper:
 *   1. Runs `codex exec --json <your args>` as a subprocess
 *   2. Streams stdout (JSONL events) to your terminal in real time
 *   3. Writes to SQLite via writeQueryToDb, writeSessionTelemetryToDb,
 *      writeSkillUsageToDb (Phase 3: JSONL writes removed)
 */

import { Option } from "effect";
import { decodeRolloutLine } from "./rollout-contract.js";
import { homedir } from "node:os";
import { join } from "node:path";

import { CANONICAL_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import {
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillUsageToDb,
} from "@selftune/runtime/localdb/direct-write";
import {
  appendCanonicalRecords,
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
} from "@selftune/runtime/normalization";
import type {
  CanonicalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";
import { extractActionableQueryText } from "@selftune/runtime/utils/query-filter";
import {
  getInternalPromptTargetSkill,
  isWrappedNonUserPart,
} from "@selftune/runtime/utils/skill-detection";
import {
  classifySkillPath,
  extractExplicitSkillMentions,
  extractSkillNamesFromInstructions,
  extractSkillNamesFromPathReferences,
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositorySkillDirs,
} from "@selftune/runtime/utils/skill-discovery";

const SKILL_NAME_CACHE = new Map<string, Set<string>>();

/** Return the set of skill names installed in Codex skill directories. */
export function findCodexSkillNames(
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
  adminDir: string = "/etc/codex/skills",
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): Set<string> {
  const cacheKey = [cwd, homeDir, adminDir, codexHome].join("\u0000");
  const cached = SKILL_NAME_CACHE.get(cacheKey);
  if (cached) return new Set(cached);

  const names = findInstalledSkillNames([
    ...findRepositorySkillDirs(cwd),
    join(homeDir, ".agents", "skills"),
    adminDir,
    join(codexHome, "skills"),
    join(codexHome, "skills", ".system"),
  ]);
  SKILL_NAME_CACHE.set(cacheKey, names);
  return new Set(names);
}

/**
 * Extract the user prompt from codex exec args.
 * The prompt is the last positional argument (not a flag).
 */
export function extractPromptFromArgs(args: string[]): string {
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.length > 0 ? positional[positional.length - 1] : "";
}

export interface ParsedCodexStream {
  thread_id?: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  input_tokens: number;
  output_tokens: number;
  agent_summary?: string;
  transcript_chars: number;
}

/**
 * Parse Codex JSONL event lines and extract telemetry.
 */
export function parseJsonlStream(lines: string[], skillNames: Set<string>): ParsedCodexStream {
  let threadId = "unknown";
  const toolCalls: Record<string, number> = {};
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  let errors = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const agentMessages: string[] = [];
  const sessionSkillNames = new Set(skillNames);
  const markSkillTriggered = (skillName: string): void => {
    if (!skillsTriggered.includes(skillName)) {
      skillsTriggered.push(skillName);
    }
  };
  // Only session metadata declares the installed skill inventory. Transcript
  // messages are untrusted content and may quote arbitrary skill lists.
  const rememberTrustedSessionSkillNames = (text: string | undefined): void => {
    if (!text) return;
    for (const skillName of extractSkillNamesFromInstructions(text, sessionSkillNames)) {
      sessionSkillNames.add(skillName);
    }
  };
  const detectExplicitSkillReads = (text: string | undefined): void => {
    if (!text) return;
    for (const skillName of extractSkillNamesFromPathReferences(text, sessionSkillNames)) {
      markSkillTriggered(skillName);
    }
  };
  const detectExplicitPromptSkillMentions = (text: string | undefined): void => {
    if (!text) return;
    if (isWrappedNonUserPart(text)) return;
    const actionableQuery = extractActionableQueryText(text);
    const internalTargetSkill = getInternalPromptTargetSkill(
      actionableQuery ?? text,
      sessionSkillNames,
    );
    if (internalTargetSkill) {
      markSkillTriggered(internalTargetSkill);
      return;
    }
    // A null actionable query is wrapper-only or other non-user scaffolding.
    // Never fall back to scanning the raw wrapper for explicit skill names.
    if (!actionableQuery) return;
    for (const skillName of extractSkillNamesFromPathReferences(
      actionableQuery,
      sessionSkillNames,
    )) {
      markSkillTriggered(skillName);
    }
    for (const skillName of extractExplicitSkillMentions(actionableQuery, sessionSkillNames)) {
      markSkillTriggered(skillName);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const decoded = decodeRolloutLine(line);
    if (Option.isNone(decoded)) continue;
    const event = decoded.value;
    const etype = event.type ?? "";

    if (etype === "thread.started") {
      threadId = event.thread_id ?? "unknown";
    } else if (etype === "session_meta") {
      const payload = event.payload ?? {};
      rememberTrustedSessionSkillNames(payload.instructions);
      rememberTrustedSessionSkillNames(payload.base_instructions?.text);
    } else if (etype === "turn.started") {
      turns += 1;
    } else if (etype === "turn.completed") {
      const usage = event.usage ?? {};
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
    } else if (etype === "turn.failed") {
      errors += 1;
    } else if (etype === "item.completed" || etype === "item.started" || etype === "item.updated") {
      const item = event.item ?? {};
      const itemType = item.item_type ?? item.type ?? "";

      if (etype === "item.completed") {
        if (itemType === "command_execution") {
          toolCalls.command_execution = (toolCalls.command_execution ?? 0) + 1;
          const cmd = (item.command ?? "").trim();
          if (cmd) bashCommands.push(cmd);
          if (item.exit_code !== 0 && item.exit_code !== undefined) {
            errors += 1;
          }
        } else if (itemType === "file_change") {
          toolCalls.file_change = (toolCalls.file_change ?? 0) + 1;
        } else if (itemType === "mcp_tool_call") {
          const toolName = item.tool ?? "unknown";
          const key = `mcp:${toolName}`;
          toolCalls[key] = (toolCalls[key] ?? 0) + 1;
        } else if (itemType === "web_search") {
          toolCalls.web_search = (toolCalls.web_search ?? 0) + 1;
        } else if (itemType === "agent_message") {
          const text = item.text ?? "";
          if (text) agentMessages.push(text.slice(0, 500));
        } else if (itemType === "reasoning") {
          toolCalls.reasoning = (toolCalls.reasoning ?? 0) + 1;
        }
      }

      if (etype === "item.completed" && itemType === "command_execution") {
        detectExplicitSkillReads(item.command);
      }
    } else if (etype === "response_item") {
      const payload = event.payload ?? {};
      const itemType = payload.type ?? "";
      if (itemType === "function_call") {
        detectExplicitSkillReads(payload.arguments);
      } else if (itemType === "message") {
        const parts = payload.content?.flatMap((part) => (part?.text ? [part.text] : [])) ?? [];
        if (payload.role === "user") {
          for (const part of parts) {
            detectExplicitPromptSkillMentions(part);
          }
        }
      } else if (itemType === "agent_reasoning") {
        detectExplicitSkillReads(payload.text);
      }
    } else if (etype === "error") {
      errors += 1;
    }
  }

  return {
    thread_id: threadId,
    tool_calls: toolCalls,
    total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    bash_commands: bashCommands,
    skills_triggered: skillsTriggered,
    assistant_turns: turns,
    errors_encountered: errors,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    agent_summary: agentMessages.slice(0, 3).join(" | "),
    transcript_chars: lines.reduce((sum, l) => sum + l.length, 0),
  };
}

/** Write the user prompt to SQLite. */
export function logQuery(prompt: string, sessionId: string, _logPath: string = QUERY_LOG): void {
  if (!prompt || prompt.length < 4) return;
  const record: QueryLogRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    query: prompt,
    source: "codex",
  };
  writeQueryToDb(record);
}

/** Write session metrics to SQLite. */
export function logTelemetry(
  metrics: Omit<ParsedCodexStream, "thread_id">,
  prompt: string,
  sessionId: string,
  cwd: string,
  _logPath: string = TELEMETRY_LOG,
): void {
  const record: SessionTelemetryRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    cwd,
    transcript_path: "",
    last_user_query: prompt,
    source: "codex",
    ...metrics,
  };
  writeSessionTelemetryToDb(record);
}

/** Write a skill trigger to SQLite. */
export function logSkillTrigger(
  skillName: string,
  prompt: string,
  sessionId: string,
  cwd: string = process.cwd(),
  logPath: string = SKILL_LOG,
  homeDir: string = homedir(),
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): void {
  const skillPath =
    findInstalledSkillPath(skillName, [
      ...findRepositorySkillDirs(cwd),
      join(homeDir, ".agents", "skills"),
      "/etc/codex/skills",
      join(codexHome, "skills"),
      join(codexHome, "skills", ".system"),
    ]) ?? `(codex:${skillName})`;
  const record: SkillUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill_name: skillName,
    skill_path: skillPath,
    ...classifySkillPath(skillPath, homeDir, codexHome),
    query: prompt,
    triggered: true,
    source: "codex",
  };
  writeSkillUsageToDb(record);
}

/** Build canonical records from a wrapper session. */
export function buildCanonicalRecordsFromWrapper(
  metrics: ParsedCodexStream,
  prompt: string,
  sessionId: string,
  cwd: string,
): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  const now = new Date().toISOString();
  const baseInput: CanonicalBaseInput = {
    platform: "codex",
    capture_mode: "wrapper",
    source_session_kind: "interactive",
    session_id: sessionId,
    raw_source_ref: { event_type: "codex_wrapper" },
  };

  records.push(
    buildCanonicalSession({
      ...baseInput,
      started_at: now,
      workspace_path: cwd || undefined,
    }),
  );

  const promptEmitted = Boolean(prompt && prompt.length >= 4);
  const promptId = promptEmitted ? derivePromptId(sessionId, 0) : undefined;

  if (promptId) {
    records.push(
      buildCanonicalPrompt({
        ...baseInput,
        prompt_id: promptId,
        occurred_at: now,
        prompt_text: prompt,
        prompt_index: 0,
      }),
    );
  }

  for (let i = 0; i < metrics.skills_triggered.length; i++) {
    const skillName = metrics.skills_triggered[i];
    const { invocation_mode, confidence } = deriveInvocationMode({
      is_text_mention_only: true,
    });
    records.push(
      buildCanonicalSkillInvocation({
        ...baseInput,
        skill_invocation_id: deriveSkillInvocationId(sessionId, skillName, i),
        occurred_at: now,
        matched_prompt_id: promptId,
        skill_name: skillName,
        skill_path: `(codex:${skillName})`,
        invocation_mode,
        triggered: true,
        confidence,
      }),
    );
  }

  records.push(
    buildCanonicalExecutionFact({
      ...baseInput,
      occurred_at: now,
      prompt_id: promptId,
      tool_calls_json: metrics.tool_calls,
      total_tool_calls: metrics.total_tool_calls,
      bash_commands_redacted: metrics.bash_commands,
      assistant_turns: metrics.assistant_turns,
      errors_encountered: metrics.errors_encountered,
      input_tokens: metrics.input_tokens ?? undefined,
      output_tokens: metrics.output_tokens ?? undefined,
    }),
  );

  return records;
}

/** Write canonical records to appropriate log files. */
export function logCanonicalRecords(
  records: CanonicalRecord[],
  canonicalLogPath: string = CANONICAL_LOG,
): void {
  appendCanonicalRecords(records, canonicalLogPath);
}

// --- CLI main ---
export async function cliMain(): Promise<void> {
  const extraArgs = process.argv.slice(2);

  if (extraArgs.length === 0) {
    process.stderr.write("Usage: codex-wrapper.ts [codex exec flags] <prompt>\n");
    process.stderr.write("  Wraps `codex exec --json` and logs skill eval telemetry.\n");
    process.exit(1);
  }

  const prompt = extractPromptFromArgs(extraArgs);
  const skillNames = findCodexSkillNames();
  const cwd = process.cwd();

  // Build the codex command -- always add --json
  let cmd = ["codex", "exec", "--json", ...extraArgs];

  // Deduplicate --json
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const c of cmd) {
    if (c === "--json" && seen.has("--json")) continue;
    deduped.push(c);
    seen.add(c);
  }
  cmd = deduped;

  const collectedLines: string[] = [];

  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "inherit",
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      process.stdout.write(chunk);
      buffer += chunk;

      // Process complete lines
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed) {
          collectedLines.push(trimmed);
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      collectedLines.push(buffer.trim());
    }

    await proc.exited;

    // Parse and log
    const metrics = parseJsonlStream(collectedLines, skillNames);
    const sessionId = metrics.thread_id ?? "unknown";

    const { thread_id: _, ...metricsWithoutThread } = metrics;

    logQuery(prompt, sessionId);
    logTelemetry(metricsWithoutThread, prompt, sessionId, cwd);

    for (const skillName of metrics.skills_triggered) {
      logSkillTrigger(skillName, prompt, sessionId, cwd);
    }

    // Emit canonical records (additive)
    const canonical = buildCanonicalRecordsFromWrapper(metrics, prompt, sessionId, cwd);
    logCanonicalRecords(canonical);

    process.exit(proc.exitCode ?? 0);
  } catch (e) {
    if (e instanceof Error && e.message.includes("ENOENT")) {
      process.stderr.write(
        "[codex-wrapper] Error: `codex` not found in PATH. Is Codex CLI installed?\n",
      );
      process.exit(1);
    }
    throw e;
  }
}

// Run main if executed directly
if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
