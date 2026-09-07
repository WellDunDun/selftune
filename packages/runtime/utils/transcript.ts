/**
 * Transcript parsing utilities shared by hooks and grading.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

import * as Option from "effect/Option";

import { CLAUDE_CODE_PROJECTS_DIR } from "../constants.js";
import type {
  SessionTelemetryRecord,
  SessionType,
  TranscriptMetrics,
  TranscriptSkillInvocationEvent,
} from "../types.js";
import { isActionableQueryText } from "./query-filter.js";
import {
  decodeTranscriptArguments,
  decodeTranscriptLine,
  decodeTranscriptToolInput,
  type TranscriptContent,
} from "./transcript-contract.js";

/** Tools that produce durable output artifacts (not reads or exploration). */
const ARTIFACT_TOOLS = new Set(["Write", "Edit", "WebFetch", "WebSearch", "Skill", "Agent"]);

/** Matches any bash command containing a git invocation. */
const GIT_CMD_RE = /\bgit\b/;

/**
 * Parse a Claude Code transcript JSONL and extract process metrics.
 *
 * Handles two observed transcript variants:
 *   Variant A (newer): {"type": "user", "message": {"role": "user", "content": [...]}}
 *   Variant B (older): {"role": "user", "content": "..."}
 */
export function parseTranscript(transcriptPath: string): TranscriptMetrics {
  if (!existsSync(transcriptPath)) return emptyMetrics();

  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.split("\n");
  const totalChars = lines.reduce((sum, l) => sum + l.length, 0);

  const toolCounts = new Map<string, number>();
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  const skillsInvoked: string[] = [];
  const rawSkillEvents: Array<TranscriptSkillInvocationEvent & { line_index: number }> = [];
  const rawSkillReadEvents: Array<TranscriptSkillInvocationEvent & { line_index: number }> = [];
  let lastActionablePromptIndex = -1;
  let errors = 0;
  let assistantTurns = 0;
  let lastUserQuery = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningOutputTokens = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let model: string | undefined;

  // File change tracking (Win 2)
  const changedFiles = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let linesModified = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex] ?? "";
    const line = raw.trim();
    if (!line) continue;

    const decoded = decodeTranscriptLine(line);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;

    // Track timestamps for duration calculation
    const ts = entry.timestamp;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // Accumulate token usage from usage objects
    const usage = entry.usage ?? entry.message?.usage;
    if (usage) {
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      // Win 3: Token granularity — cached input tokens
      cachedInputTokens += usage.cache_read_input_tokens ?? 0;
      cachedInputTokens += usage.cache_creation_input_tokens ?? 0;
      // Win 3: Reasoning output tokens
      reasoningOutputTokens += usage.reasoning_output_tokens ?? 0;
    }

    // Normalise: unwrap nested message if present
    const msg = entry.message ?? entry;
    const role = msg.role ?? entry.role ?? "";
    const content = msg.content ?? entry.content ?? "";

    // Extract model from first entry that has it
    if (!model) {
      const msgModel = msg.model;
      const entryModel = entry.model;
      if (msgModel?.trim()) {
        model = msgModel;
      } else if (entryModel?.trim()) {
        model = entryModel;
      }
    }

    // Track last user query
    if (role === "user") {
      const text = extractActionableUserText(content);
      if (text) {
        lastUserQuery = text;
        if (text.length >= 4 && isActionableQueryText(text)) {
          lastActionablePromptIndex += 1;
        }
      }
    }

    // Count assistant turns and parse tool use
    if (role === "assistant") {
      assistantTurns++;
      const contentBlocks = Array.isArray(content) ? content : [];
      for (const b of contentBlocks) {
        if (b === null) continue;
        if (b.type === "tool_use") {
          const toolName = b.name ?? "Unknown";
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          const inp = b.input === undefined ? undefined : decodeTranscriptToolInput(b.input);

          // Track SKILL.md reads (may be browsing — kept for backwards compat)
          const filePath = inp?.file_path ?? "";
          if (basename(filePath).toUpperCase() === "SKILL.MD") {
            const skillName = basename(dirname(filePath));
            if (!skillsTriggered.includes(skillName)) {
              skillsTriggered.push(skillName);
            }
            const readEvent: TranscriptSkillInvocationEvent & { line_index: number } = {
              skill_name: skillName,
              skill_path: filePath,
              occurred_at: ts,
              tool_name: "Read",
              tool_call_id: b.id,
              triggered: false,
              source_event_index: lineIndex,
              line_index: lineIndex,
            };
            if (lastActionablePromptIndex >= 0) readEvent.prompt_index = lastActionablePromptIndex;
            rawSkillReadEvents.push(readEvent);
          }

          // Track actual Skill tool invocations (high-confidence signal)
          if (toolName === "Skill") {
            const skillArg = inp?.skill ?? inp?.name ?? "";
            if (skillArg && !skillsInvoked.includes(skillArg)) {
              skillsInvoked.push(skillArg);
            }
            if (skillArg) {
              const invocation: TranscriptSkillInvocationEvent & { line_index: number } = {
                skill_name: skillArg,
                occurred_at: ts,
                tool_name: "Skill",
                tool_call_id: b.id,
                triggered: true,
                source_event_index: lineIndex,
                line_index: lineIndex,
              };
              if (lastActionablePromptIndex >= 0)
                invocation.prompt_index = lastActionablePromptIndex;
              rawSkillEvents.push(invocation);
            }
          }

          // Track bash commands
          if (toolName === "Bash") {
            const cmd = (inp?.command ?? "").trim();
            if (cmd) bashCommands.push(cmd);
          }

          // Win 2: Track file changes from Write and Edit tools
          if (toolName === "Write" || toolName === "Edit") {
            const fp = inp?.file_path ?? "";
            if (fp) changedFiles.add(fp);
          }
          if (toolName === "Write" && inp?.content !== undefined) {
            linesAdded += inp.content.split("\n").length;
          }
          if (toolName === "Edit") {
            const oldStr = inp?.old_string;
            const newStr = inp?.new_string;
            if (oldStr !== undefined && newStr !== undefined) {
              const oldLines = oldStr.split("\n").length;
              const newLines = newStr.split("\n").length;
              linesModified += Math.min(oldLines, newLines);
              linesAdded += Math.max(0, newLines - oldLines);
              linesRemoved += Math.max(0, oldLines - newLines);
            }
          }
        }
      }
    }

    // Count tool errors from result entries
    const entryType = entry.type;
    if (entryType === "tool_result" && entry.is_error) {
      errors++;
    }
    // Also check inside user content (tool_result blocks)
    if (role === "user" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result" && block.is_error) {
          errors++;
        }
      }
    }
  }

  // Compute artifact count: output-producing tool calls
  const toolCalls = Object.fromEntries(toolCounts);
  let artifactCount = 0;
  for (const [tool, count] of Object.entries(toolCalls)) {
    if (ARTIFACT_TOOLS.has(tool)) artifactCount += count;
  }

  // Compute duration from first to last timestamp
  let durationMs: number | undefined;
  if (firstTimestamp && lastTimestamp && firstTimestamp !== lastTimestamp) {
    const start = new Date(firstTimestamp).getTime();
    const end = new Date(lastTimestamp).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      durationMs = end - start;
    }
  }

  // Win 3: Calculate cost from model and token counts
  const costUsd = calculateCost(model, inputTokens, outputTokens);

  // Infer session type from tool distribution
  const sessionType = inferSessionType(toolCalls, bashCommands);
  const consumedReadIndexes = new Set<number>();
  const pairedSkillEvents = rawSkillEvents.map((event) => {
    const matchingReadIndex = rawSkillReadEvents.findIndex(
      (readEvent, index) =>
        !consumedReadIndexes.has(index) &&
        readEvent.skill_name === event.skill_name &&
        readEvent.prompt_index === event.prompt_index &&
        readEvent.line_index >= event.line_index,
    );
    if (matchingReadIndex < 0) return event;

    consumedReadIndexes.add(matchingReadIndex);
    return {
      ...event,
      skill_path: rawSkillReadEvents[matchingReadIndex]?.skill_path,
    };
  });
  const skillInvocationEvents = [
    ...pairedSkillEvents,
    ...rawSkillReadEvents.filter((_, index) => !consumedReadIndexes.has(index)),
  ]
    .sort((a, b) => a.line_index - b.line_index)
    .map(({ line_index: _lineIndex, ...event }) => event);

  const metrics: TranscriptMetrics = {
    tool_calls: toolCalls,
    total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    bash_commands: bashCommands,
    skills_triggered: skillsTriggered,
    skills_invoked: skillsInvoked,
    skill_invocation_events: skillInvocationEvents,
    assistant_turns: assistantTurns,
    errors_encountered: errors,
    transcript_chars: totalChars,
    last_user_query: lastUserQuery,
    // Win 2: File change metrics
    files_changed: changedFiles.size,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    lines_modified: linesModified,
    artifact_count: artifactCount,
    session_type: sessionType,
  };
  if (inputTokens > 0) metrics.input_tokens = inputTokens;
  if (outputTokens > 0) metrics.output_tokens = outputTokens;
  if (cachedInputTokens > 0) metrics.cached_input_tokens = cachedInputTokens;
  if (reasoningOutputTokens > 0) metrics.reasoning_output_tokens = reasoningOutputTokens;
  if (costUsd !== undefined) metrics.cost_usd = costUsd;
  if (durationMs !== undefined) metrics.duration_ms = durationMs;
  if (model) metrics.model = model;
  if (firstTimestamp) metrics.started_at = firstTimestamp;
  if (lastTimestamp) metrics.ended_at = lastTimestamp;
  return metrics;
}

/**
 * Extract actionable user queries from a Claude transcript.
 */
export function extractActionableUserQueries(
  transcriptPath: string,
): Array<{ query: string; timestamp: string }> {
  if (!existsSync(transcriptPath)) return [];

  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const results: Array<{ query: string; timestamp: string }> = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const decoded = decodeTranscriptLine(line);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;

    const msg = entry.message ?? entry;
    const role = msg.role ?? entry.role ?? "";
    if (role !== "user") continue;

    const text = extractActionableUserText(msg.content ?? entry.content ?? "");
    if (!text || text.length < 4) continue;

    const timestamp = entry.timestamp ?? msg.timestamp ?? "";
    results.push({ query: text, timestamp });
  }

  return results;
}

/**
 * Recursively find Claude transcript JSONL files under a projects directory.
 */
export function findTranscriptFiles(projectsDir: string, since?: Date): string[] {
  if (!existsSync(projectsDir)) return [];

  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = `${dir}/${entry}`;
      try {
        const stats = statSync(entryPath);

        if (stats.isDirectory()) {
          walk(entryPath);
          continue;
        }

        if (!stats.isFile() || !entry.endsWith(".jsonl")) continue;
        if (since && stats.mtime < since) continue;

        files.push(entryPath);
      } catch {
        // Ignore unreadable files and keep scanning.
      }
    }
  };

  walk(projectsDir);
  return files.sort();
}

/**
 * Find a Claude transcript path by session ID.
 */
export function findTranscriptPathForSession(
  sessionId: string,
  projectsDir: string = CLAUDE_CODE_PROJECTS_DIR,
): string | null {
  const filename = `${sessionId}.jsonl`;
  for (const transcriptPath of findTranscriptFiles(projectsDir)) {
    if (basename(transcriptPath) === filename) return transcriptPath;
  }
  return null;
}

/**
 * Build a SessionTelemetryRecord directly from a transcript file.
 */
export function buildTelemetryFromTranscript(
  sessionId: string,
  transcriptPath: string,
  source = "claude_code_transcript_fallback",
): SessionTelemetryRecord | null {
  if (!existsSync(transcriptPath)) return null;

  const metrics = parseTranscript(transcriptPath);
  const userQueries = extractActionableUserQueries(transcriptPath);

  let timestamp = userQueries[0]?.timestamp ?? "";
  if (!timestamp) {
    try {
      timestamp = statSync(transcriptPath).mtime.toISOString();
    } catch {
      timestamp = new Date().toISOString();
    }
  }

  return {
    timestamp,
    session_id: sessionId,
    cwd: "",
    transcript_path: transcriptPath,
    tool_calls: metrics.tool_calls,
    total_tool_calls: metrics.total_tool_calls,
    bash_commands: metrics.bash_commands,
    skills_triggered: metrics.skills_triggered,
    skills_invoked: metrics.skills_invoked,
    assistant_turns: metrics.assistant_turns,
    errors_encountered: metrics.errors_encountered,
    transcript_chars: metrics.transcript_chars,
    last_user_query: metrics.last_user_query,
    source,
    input_tokens: metrics.input_tokens,
    output_tokens: metrics.output_tokens,
    cached_input_tokens: metrics.cached_input_tokens,
    reasoning_output_tokens: metrics.reasoning_output_tokens,
    cost_usd: metrics.cost_usd,
    files_changed: metrics.files_changed,
    lines_added: metrics.lines_added,
    lines_removed: metrics.lines_removed,
    lines_modified: metrics.lines_modified,
    artifact_count: metrics.artifact_count,
    session_type: metrics.session_type,
    agent_summary: generateSessionSummary(metrics),
  };
}

/**
 * Walk the transcript JSONL backwards to find the most recent user message.
 */
export function getLastUserMessage(transcriptPath: string): string | null {
  if (!existsSync(transcriptPath)) return null;

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const decoded = decodeTranscriptLine(lines[i]);
      if (Option.isNone(decoded)) continue;
      const entry = decoded.value;

      // Format 1: top-level role field
      if (entry.role === "user") {
        const text = extractActionableUserText(entry.content);
        if (text) return text;
      }

      // Format 2: nested message object
      const msg = entry.message;
      if (msg?.role === "user") {
        const text = extractActionableUserText(msg.content);
        if (text) return text;
      }
    }
  } catch {
    // silent
  }

  return null;
}

function extractTextParts(content: TranscriptContent | undefined): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function summarizeCodexFunctionArguments(argumentsText: string | undefined): string {
  if (!argumentsText?.trim()) return "";
  const decoded = decodeTranscriptArguments(argumentsText);
  if (Option.isNone(decoded)) return argumentsText.trim().slice(0, 200);
  const parsed = decoded.value;
  return (
    parsed.cmd?.trim() ||
    parsed.command?.trim() ||
    parsed.file_path?.trim() ||
    parsed.path?.trim() ||
    parsed.query?.trim() ||
    argumentsText.trim()
  ).slice(0, 200);
}

/**
 * Parse a transcript into a human-readable excerpt for the grader.
 */
export function readExcerpt(transcriptPath: string, maxChars = 8000): string {
  if (!existsSync(transcriptPath)) return "(transcript not found)";

  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  const readable: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const decoded = decodeTranscriptLine(line);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;

    const msg = entry.message ?? entry;
    const role = msg.role ?? entry.role ?? "";
    const entryContent = msg.content ?? entry.content ?? "";
    const eventType = entry.type ?? "";

    if (role === "user") {
      if (!Array.isArray(entryContent)) {
        readable.push(`[USER] ${entryContent.slice(0, 200)}`);
      } else if (Array.isArray(entryContent)) {
        const text = extractTextParts(entryContent).slice(0, 200);
        if (text) readable.push(`[USER] ${text}`);
      }
    } else if (role === "assistant") {
      if (Array.isArray(entryContent)) {
        for (const b of entryContent) {
          if (b === null) continue;
          if (b.type === "text") {
            readable.push(`[ASSISTANT] ${(b.text ?? "").slice(0, 200)}`);
          } else if (b.type === "tool_use") {
            const name = b.name ?? "?";
            const inp = b.input === undefined ? undefined : decodeTranscriptToolInput(b.input);
            const detail =
              inp?.file_path ??
              inp?.command ??
              inp?.query ??
              JSON.stringify(b.input ?? {}).slice(0, 100);
            readable.push(`[TOOL:${name}] ${detail}`);
          }
        }
      }
    } else if (eventType === "event_msg") {
      const payload = entry.payload;
      if (payload?.type === "user_message") {
        const text = extractActionableUserText(payload.message)?.slice(0, 200) ?? "";
        if (text) readable.push(`[USER] ${text}`);
      }
    } else if (eventType === "turn.completed") {
      const text = extractActionableUserText(entry.user_message)?.slice(0, 200) ?? "";
      if (text) readable.push(`[USER] ${text}`);
    } else if (eventType === "response_item") {
      const payload = entry.payload;
      if (!payload) continue;
      const itemType = payload.type ?? "";

      if (itemType === "function_call") {
        const name = payload.name ?? "function_call";
        const detail = summarizeCodexFunctionArguments(payload.arguments);
        if (detail) readable.push(`[TOOL:${name}] ${detail}`);
      } else if (itemType === "agent_reasoning") {
        const text = (payload.text ?? "").trim().slice(0, 200);
        if (text) readable.push(`[ASSISTANT] ${text}`);
      } else if (itemType === "message" && payload.role === "assistant") {
        const text = extractTextParts(payload.content).slice(0, 200);
        if (text) readable.push(`[ASSISTANT] ${text}`);
      }
    } else if (
      eventType === "item.completed" ||
      eventType === "item.started" ||
      eventType === "item.updated"
    ) {
      const item = entry.item;
      if (!item) continue;
      const itemType = item.item_type ?? item.type ?? "";

      if (itemType === "command_execution") {
        const command = (item.command ?? "").trim().slice(0, 200);
        if (command) readable.push(`[TOOL:command_execution] ${command}`);
      } else {
        const text = (item.text ?? "").trim().slice(0, 200);
        if (text) readable.push(`[ASSISTANT] ${text}`);
      }
    }
  }

  const full = readable.join("\n");
  if (full.length <= maxChars) return full;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${full.slice(0, head)}\n\n... [truncated] ...\n\n${full.slice(-tail)}`;
}

/**
 * Extract token usage from a transcript JSONL by summing usage fields.
 *
 * Scans for entries with a `usage` object containing `input_tokens` and
 * `output_tokens` (the format Claude Code transcripts use).
 */
export function extractTokenUsage(transcriptPath: string) {
  if (!existsSync(transcriptPath)) return { input: 0, output: 0 };

  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.split("\n");
  let input = 0;
  let output = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const decoded = decodeTranscriptLine(line);
    if (Option.isNone(decoded)) continue;
    const usage = decoded.value.usage;
    input += usage?.input_tokens ?? 0;
    output += usage?.output_tokens ?? 0;
  }

  return { input, output };
}

// ---------------------------------------------------------------------------
// Win 3: Model cost lookup (USD per million tokens)
// ---------------------------------------------------------------------------

const MODEL_COSTS = new Map([
  ["claude-sonnet-4-20250514", { input: 3.0, output: 15.0 }],
  ["claude-opus-4-20250514", { input: 15.0, output: 75.0 }],
  ["claude-haiku-3-5-20241022", { input: 0.8, output: 4.0 }],
  ["claude-3-5-sonnet-20241022", { input: 3.0, output: 15.0 }],
  ["claude-3-5-haiku-20241022", { input: 0.8, output: 4.0 }],
  ["claude-3-opus-20240229", { input: 15.0, output: 75.0 }],
  ["claude-3-sonnet-20240229", { input: 3.0, output: 15.0 }],
  ["claude-3-haiku-20240307", { input: 0.25, output: 1.25 }],
]);

/**
 * Calculate estimated cost in USD from model name and token counts.
 * Returns undefined if the model is unknown or not provided.
 */
export function calculateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (!model) return undefined;
  const costs =
    MODEL_COSTS.get(model) ??
    [...MODEL_COSTS].find(([k]) => model.startsWith(k.split("-").slice(0, -1).join("-")))?.[1];
  if (!costs) return undefined;
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

/**
 * Infer session type from tool call distribution.
 *
 * - "dev": majority of output tools are Write/Edit/Bash with git commands
 * - "research": majority are WebFetch/WebSearch/Read
 * - "content": majority are Write/Edit but no git commands
 * - "mixed": no clear majority
 */
export function inferSessionType(
  toolCalls: Record<string, number>,
  bashCommands: string[],
): "dev" | "research" | "content" | "mixed" {
  const total = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  if (total === 0) return "mixed";

  const writeEdit = (toolCalls.Write ?? 0) + (toolCalls.Edit ?? 0);
  const research = (toolCalls.WebFetch ?? 0) + (toolCalls.WebSearch ?? 0);
  const bash = toolCalls.Bash ?? 0;
  const read = toolCalls.Read ?? 0;
  const hasGit = bashCommands.some((cmd) => GIT_CMD_RE.test(cmd));

  // Dev: file mutations + git commands OR bash-heavy with git
  if (hasGit && (writeEdit + bash) / total > 0.3) return "dev";

  // Research: web tools + read-heavy, low file mutations
  if (research > 0 && research / total > 0.2 && writeEdit / total < 0.15) return "research";
  if (read / total > 0.5 && writeEdit / total < 0.1) return "research";

  // Content: file mutations but no git
  if (writeEdit / total > 0.2 && !hasGit) return "content";

  return "mixed";
}

/**
 * Generate a short heuristic session summary from transcript metrics.
 * No LLM call — pure template-based approach. Kept under 120 chars.
 */
export function generateSessionSummary(metrics: TranscriptMetrics): string {
  const MAX_LEN = 120;
  const sessionType: SessionType = metrics.session_type ?? "mixed";
  const lastQuery = truncateQuery(metrics.last_user_query, 60);

  if (metrics.total_tool_calls === 0 && !lastQuery) {
    return "Empty session — no tool calls or queries";
  }

  const topTools = getTopTools(metrics.tool_calls, 2);

  let summary: string;
  switch (sessionType) {
    case "dev": {
      const filesChanged = metrics.files_changed ?? 0;
      const toolStr = topTools.length > 0 ? ` via ${topTools.join(", ")}` : "";
      const queryStr = lastQuery ? ` — ${lastQuery}` : "";
      summary = `${filesChanged} files changed${toolStr}${queryStr}`;
      break;
    }
    case "research": {
      const searches = (metrics.tool_calls.WebSearch ?? 0) + (metrics.tool_calls.WebFetch ?? 0);
      const reads = metrics.tool_calls.Read ?? 0;
      const queryStr = lastQuery ? ` — ${lastQuery}` : "";
      summary = `${searches} searches + ${reads} reads${queryStr}`;
      break;
    }
    case "content": {
      const filesChanged = metrics.files_changed ?? 0;
      const queryStr = lastQuery ? ` — ${lastQuery}` : "";
      summary = `${filesChanged} files created/edited${queryStr}`;
      break;
    }
    default: {
      const toolCount = Object.keys(metrics.tool_calls).length;
      const queryStr = lastQuery ? ` — ${lastQuery}` : "";
      summary = `${metrics.total_tool_calls} tool calls across ${toolCount} tools${queryStr}`;
      break;
    }
  }

  if (summary.length > MAX_LEN) {
    return `${summary.slice(0, MAX_LEN - 3)}...`;
  }
  return summary;
}

/** Get the top N tools by call count. */
function getTopTools(toolCalls: Record<string, number>, n: number): string[] {
  return Object.entries(toolCalls)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
}

/** Truncate a query string to maxLen, adding ellipsis if needed. */
function truncateQuery(query: string, maxLen: number): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 3)}...`;
}

function emptyMetrics(): TranscriptMetrics {
  return {
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    skills_invoked: [],
    assistant_turns: 0,
    errors_encountered: 0,
    transcript_chars: 0,
    last_user_query: "",
  };
}

function extractUserText(content: TranscriptContent | undefined): string | null {
  if (content === undefined) return null;
  const text = Array.isArray(content) ? extractTextParts(content) : content.trim();
  return text || null;
}

function extractActionableUserText(content: TranscriptContent | undefined): string | null {
  const text = extractUserText(content);
  if (!text) return null;
  return isActionableQueryText(text) ? text : null;
}
