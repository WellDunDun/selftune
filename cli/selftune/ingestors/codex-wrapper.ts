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
 *   3. Parses events and writes to:
 *        ~/.claude/all_queries_log.jsonl
 *        ~/.claude/session_telemetry_log.jsonl
 *        ~/.claude/skill_usage_log.jsonl
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CANONICAL_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
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
} from "../normalization.js";
import type {
  CanonicalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { appendJsonl } from "../utils/jsonl.js";

const CODEX_SKILLS_DIRS = [
  join(process.cwd(), ".codex", "skills"),
  join(homedir(), ".codex", "skills"),
];

/** Return the set of skill names installed in Codex skill directories. */
export function findCodexSkillNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of CODEX_SKILLS_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      try {
        if (statSync(skillDir).isDirectory() && existsSync(join(skillDir, "SKILL.md"))) {
          names.add(entry);
        }
      } catch {
        // Skip broken symlinks or inaccessible entries
      }
    }
  }
  return names;
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
  thread_id: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  input_tokens: number;
  output_tokens: number;
  agent_summary: string;
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

  // Precompile word-boundary regex for each skill name (avoids rebuilding per item)
  const skillPatterns = Array.from(skillNames, (name) => ({
    name,
    pattern: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  }));

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const etype = (event.type as string) ?? "";

    if (etype === "thread.started") {
      threadId = (event.thread_id as string) ?? "unknown";
    } else if (etype === "turn.started") {
      turns += 1;
    } else if (etype === "turn.completed") {
      const usage = (event.usage as Record<string, number>) ?? {};
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
    } else if (etype === "turn.failed") {
      errors += 1;
    } else if (etype === "item.completed" || etype === "item.started" || etype === "item.updated") {
      const item = (event.item as Record<string, unknown>) ?? {};
      const itemType = (item.item_type as string) ?? (item.type as string) ?? "";

      if (etype === "item.completed") {
        if (itemType === "command_execution") {
          toolCalls.command_execution = (toolCalls.command_execution ?? 0) + 1;
          const cmd = ((item.command as string) ?? "").trim();
          if (cmd) bashCommands.push(cmd);
          if ((item.exit_code as number) !== 0 && item.exit_code !== undefined) {
            errors += 1;
          }
        } else if (itemType === "file_change") {
          toolCalls.file_change = (toolCalls.file_change ?? 0) + 1;
        } else if (itemType === "mcp_tool_call") {
          const toolName = (item.tool as string) ?? "unknown";
          const key = `mcp:${toolName}`;
          toolCalls[key] = (toolCalls[key] ?? 0) + 1;
        } else if (itemType === "web_search") {
          toolCalls.web_search = (toolCalls.web_search ?? 0) + 1;
        } else if (itemType === "agent_message") {
          const text = (item.text as string) ?? "";
          if (text) agentMessages.push(text.slice(0, 500));
        } else if (itemType === "reasoning") {
          toolCalls.reasoning = (toolCalls.reasoning ?? 0) + 1;
        }
      }

      // Detect skill names in text on completed events (whole-word match)
      const textContent = ((item.text as string) ?? "") + ((item.command as string) ?? "");
      for (const { name: sName, pattern } of skillPatterns) {
        if (
          etype === "item.completed" &&
          !skillsTriggered.includes(sName) &&
          pattern.test(textContent)
        ) {
          skillsTriggered.push(sName);
        }
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

/** Append the user prompt to all_queries_log.jsonl. */
export function logQuery(prompt: string, sessionId: string, logPath: string = QUERY_LOG): void {
  if (!prompt || prompt.length < 4) return;
  const record: QueryLogRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    query: prompt,
    source: "codex",
  };
  appendJsonl(logPath, record);
}

/** Append session metrics to session_telemetry_log.jsonl. */
export function logTelemetry(
  metrics: Omit<ParsedCodexStream, "thread_id">,
  prompt: string,
  sessionId: string,
  cwd: string,
  logPath: string = TELEMETRY_LOG,
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
  appendJsonl(logPath, record);
}

/** Append a skill trigger to skill_usage_log.jsonl. */
export function logSkillTrigger(
  skillName: string,
  prompt: string,
  sessionId: string,
  logPath: string = SKILL_LOG,
): void {
  const record: SkillUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill_name: skillName,
    skill_path: `(codex:${skillName})`,
    query: prompt,
    triggered: true,
    source: "codex",
  };
  appendJsonl(logPath, record);
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
  let threadId = "unknown";

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
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === "thread.started") {
              threadId = ev.thread_id ?? "unknown";
            }
          } catch {
            // skip
          }
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
    const actualThreadId = metrics.thread_id;
    const sessionId = actualThreadId !== "unknown" ? actualThreadId : threadId;

    const { thread_id: _, ...metricsWithoutThread } = metrics;

    logQuery(prompt, sessionId);
    logTelemetry(metricsWithoutThread, prompt, sessionId, cwd);

    for (const skillName of metrics.skills_triggered) {
      logSkillTrigger(skillName, prompt, sessionId);
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
