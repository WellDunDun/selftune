/**
 * Transcript parsing utilities shared by hooks and grading.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

import { CLAUDE_CODE_PROJECTS_DIR } from "../constants.js";
import type { SessionTelemetryRecord, TranscriptMetrics } from "../types.js";
import { isActionableQueryText } from "./query-filter.js";

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

  const toolCalls: Record<string, number> = {};
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  const skillsInvoked: string[] = [];
  let errors = 0;
  let assistantTurns = 0;
  let lastUserQuery = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let model: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Track timestamps for duration calculation
    const ts = entry.timestamp as string | undefined;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // Accumulate token usage from usage objects
    const usage = (entry.usage ?? (entry.message as Record<string, unknown>)?.usage) as
      | Record<string, unknown>
      | undefined;
    if (usage && typeof usage === "object") {
      if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
    }

    // Normalise: unwrap nested message if present
    const msg = (entry.message as Record<string, unknown>) ?? entry;
    const role = (msg.role as string) ?? (entry.role as string) ?? "";
    const content = msg.content ?? entry.content ?? "";

    // Extract model from first entry that has it
    if (!model) {
      const msgModel = msg.model;
      const entryModel = entry.model;
      if (typeof msgModel === "string" && msgModel.trim()) {
        model = msgModel;
      } else if (typeof entryModel === "string" && entryModel.trim()) {
        model = entryModel;
      }
    }

    // Track last user query
    if (role === "user") {
      const text = extractActionableUserText(content);
      if (text) lastUserQuery = text;
    }

    // Count assistant turns and parse tool use
    if (role === "assistant") {
      assistantTurns++;
      const contentBlocks = Array.isArray(content) ? content : [];
      for (const block of contentBlocks) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          const toolName = (b.name as string) ?? "Unknown";
          toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
          const inp = (b.input as Record<string, unknown>) ?? {};

          // Track SKILL.md reads (may be browsing — kept for backwards compat)
          const filePath = (inp.file_path as string) ?? "";
          if (basename(filePath).toUpperCase() === "SKILL.MD") {
            const skillName = basename(dirname(filePath));
            if (!skillsTriggered.includes(skillName)) {
              skillsTriggered.push(skillName);
            }
          }

          // Track actual Skill tool invocations (high-confidence signal)
          if (toolName === "Skill") {
            const skillArg = (inp.skill as string) ?? (inp.name as string) ?? "";
            if (skillArg && !skillsInvoked.includes(skillArg)) {
              skillsInvoked.push(skillArg);
            }
          }

          // Track bash commands
          if (toolName === "Bash") {
            const cmd = ((inp.command as string) ?? "").trim();
            if (cmd) bashCommands.push(cmd);
          }
        }
      }
    }

    // Count tool errors from result entries
    const entryType = entry.type as string;
    if (entryType === "tool_result" && entry.is_error) {
      errors++;
    }
    // Also check inside user content (tool_result blocks)
    if (role === "user" && Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_result" &&
          (block as Record<string, unknown>).is_error
        ) {
          errors++;
        }
      }
    }
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

  return {
    tool_calls: toolCalls,
    total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    bash_commands: bashCommands,
    skills_triggered: skillsTriggered,
    skills_invoked: skillsInvoked,
    assistant_turns: assistantTurns,
    errors_encountered: errors,
    transcript_chars: totalChars,
    last_user_query: lastUserQuery,
    ...(inputTokens > 0 ? { input_tokens: inputTokens } : {}),
    ...(outputTokens > 0 ? { output_tokens: outputTokens } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(model ? { model } : {}),
    ...(firstTimestamp ? { started_at: firstTimestamp } : {}),
    ...(lastTimestamp ? { ended_at: lastTimestamp } : {}),
  };
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

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = (entry.message as Record<string, unknown>) ?? entry;
    const role = (msg.role as string) ?? (entry.role as string) ?? "";
    if (role !== "user") continue;

    const text = extractActionableUserText(msg.content ?? entry.content ?? "");
    if (!text || text.length < 4) continue;

    const timestamp = (entry.timestamp as string) ?? (msg.timestamp as string) ?? "";
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
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      // Format 1: top-level role field
      if (entry.role === "user") {
        const text = extractActionableUserText(entry.content);
        if (text) return text;
      }

      // Format 2: nested message object
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg && typeof msg === "object" && msg.role === "user") {
        const text = extractActionableUserText(msg.content);
        if (text) return text;
      }
    }
  } catch {
    // silent
  }

  return null;
}

function extractTextParts(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is Record<string, unknown> =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text",
    )
    .map((part) => (part.text as string) ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function summarizeCodexFunctionArguments(argumentsText: unknown): string {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";

  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    return (
      (typeof parsed.cmd === "string" && parsed.cmd.trim()) ||
      (typeof parsed.command === "string" && parsed.command.trim()) ||
      (typeof parsed.file_path === "string" && parsed.file_path.trim()) ||
      (typeof parsed.path === "string" && parsed.path.trim()) ||
      (typeof parsed.query === "string" && parsed.query.trim()) ||
      argumentsText.trim()
    ).slice(0, 200);
  } catch {
    return argumentsText.trim().slice(0, 200);
  }
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

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = (entry.message as Record<string, unknown>) ?? entry;
    const role = (msg.role as string) ?? (entry.role as string) ?? "";
    const entryContent = msg.content ?? entry.content ?? "";
    const eventType = (entry.type as string) ?? "";

    if (role === "user") {
      if (typeof entryContent === "string") {
        readable.push(`[USER] ${entryContent.slice(0, 200)}`);
      } else if (Array.isArray(entryContent)) {
        const text = extractTextParts(entryContent).slice(0, 200);
        if (text) readable.push(`[USER] ${text}`);
      }
    } else if (role === "assistant") {
      if (Array.isArray(entryContent)) {
        for (const block of entryContent) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text") {
            readable.push(`[ASSISTANT] ${((b.text as string) ?? "").slice(0, 200)}`);
          } else if (b.type === "tool_use") {
            const name = (b.name as string) ?? "?";
            const inp = (b.input as Record<string, unknown>) ?? {};
            const detail =
              (inp.file_path as string) ??
              (inp.command as string) ??
              (inp.query as string) ??
              JSON.stringify(inp).slice(0, 100);
            readable.push(`[TOOL:${name}] ${detail}`);
          }
        }
      }
    } else if (eventType === "event_msg") {
      const payload = (entry.payload as Record<string, unknown>) ?? {};
      if (payload.type === "user_message") {
        const text = extractActionableUserText(payload.message)?.slice(0, 200) ?? "";
        if (text) readable.push(`[USER] ${text}`);
      }
    } else if (eventType === "turn.completed") {
      const text = extractActionableUserText(entry.user_message)?.slice(0, 200) ?? "";
      if (text) readable.push(`[USER] ${text}`);
    } else if (eventType === "response_item") {
      const payload = (entry.payload as Record<string, unknown>) ?? {};
      const itemType = (payload.type as string) ?? "";

      if (itemType === "function_call") {
        const name = (payload.name as string) ?? "function_call";
        const detail = summarizeCodexFunctionArguments(payload.arguments);
        if (detail) readable.push(`[TOOL:${name}] ${detail}`);
      } else if (itemType === "agent_reasoning") {
        const text = ((payload.text as string) ?? "").trim().slice(0, 200);
        if (text) readable.push(`[ASSISTANT] ${text}`);
      } else if (itemType === "message" && (payload.role as string) === "assistant") {
        const text = extractTextParts(payload.content).slice(0, 200);
        if (text) readable.push(`[ASSISTANT] ${text}`);
      }
    } else if (
      eventType === "item.completed" ||
      eventType === "item.started" ||
      eventType === "item.updated"
    ) {
      const item = (entry.item as Record<string, unknown>) ?? {};
      const itemType = (item.item_type as string) ?? (item.type as string) ?? "";

      if (itemType === "command_execution") {
        const command = ((item.command as string) ?? "").trim().slice(0, 200);
        if (command) readable.push(`[TOOL:command_execution] ${command}`);
      } else {
        const text = ((item.text as string) ?? "").trim().slice(0, 200);
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
export function extractTokenUsage(transcriptPath: string): { input: number; output: number } {
  if (!existsSync(transcriptPath)) return { input: 0, output: 0 };

  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.split("\n");
  let input = 0;
  let output = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = entry.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      if (typeof usage.input_tokens === "number") input += usage.input_tokens;
      if (typeof usage.output_tokens === "number") output += usage.output_tokens;
    }
  }

  return { input, output };
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

function extractUserText(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text",
      )
      .map((p) => (p.text as string) ?? "")
      .filter(Boolean);
    const combined = texts.join(" ").trim();
    if (combined) return combined;
  }
  return null;
}

function extractActionableUserText(content: unknown): string | null {
  const text = extractUserText(content);
  if (!text) return null;
  return isActionableQueryText(text) ? text : null;
}
