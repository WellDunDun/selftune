/**
 * Transcript parsing utilities shared by hooks and grading.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { TranscriptMetrics } from "../types.js";

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

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Normalise: unwrap nested message if present
    const msg = (entry.message as Record<string, unknown>) ?? entry;
    const role = (msg.role as string) ?? (entry.role as string) ?? "";
    const content = msg.content ?? entry.content ?? "";

    // Track last user query
    if (role === "user") {
      if (typeof content === "string" && content.trim()) {
        lastUserQuery = content.trim();
      } else if (Array.isArray(content)) {
        const texts = content
          .filter(
            (p): p is Record<string, unknown> =>
              typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text",
          )
          .map((p) => (p.text as string) ?? "")
          .filter(Boolean);
        const text = texts.join(" ").trim();
        if (text) lastUserQuery = text;
      }
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
          if (toolName === "Skill" || toolName.includes("Skill")) {
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
        const text = extractUserText(entry.content);
        if (text) return text;
      }

      // Format 2: nested message object
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg && typeof msg === "object" && msg.role === "user") {
        const text = extractUserText(msg.content);
        if (text) return text;
      }
    }
  } catch {
    // silent
  }

  return null;
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

    if (role === "user") {
      if (typeof entryContent === "string") {
        readable.push(`[USER] ${entryContent.slice(0, 200)}`);
      } else if (Array.isArray(entryContent)) {
        const texts = entryContent
          .filter(
            (p): p is Record<string, unknown> =>
              typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text",
          )
          .map((p) => (p.text as string) ?? "")
          .filter(Boolean);
        const text = texts.join(" ").trim().slice(0, 200);
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
