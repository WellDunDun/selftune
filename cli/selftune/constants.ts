/**
 * Shared constants for selftune.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_DIR = join(homedir(), ".claude");

export const TELEMETRY_LOG = join(LOG_DIR, "session_telemetry_log.jsonl");
export const SKILL_LOG = join(LOG_DIR, "skill_usage_log.jsonl");
export const QUERY_LOG = join(LOG_DIR, "all_queries_log.jsonl");
export const EVOLUTION_AUDIT_LOG = join(LOG_DIR, "evolution_audit_log.jsonl");

/** Tool names Claude Code uses. */
export const KNOWN_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoRead",
  "TodoWrite",
]);

/** Prefixes indicating automated/tool-injected content, not real user prompts. */
export const SKIP_PREFIXES = ["<tool_result", "<function_result", "[Automated", "[System"] as const;

/** Fallback negatives for padding eval sets when real negatives are sparse. */
export const GENERIC_NEGATIVES = [
  "What time is it?",
  "Tell me a joke",
  "Summarize this paragraph",
  "What is the capital of France?",
  "Help me debug this Python error",
  "Write a haiku about autumn",
  "Explain what recursion means",
  "How do I reverse a string in JavaScript?",
  "What is 42 times 17?",
  "Translate 'hello' to Spanish",
  "Can you review this code?",
  "What does this error mean?",
  "Help me write a commit message",
  "Explain this function to me",
  "How do I center a div in CSS?",
] as const;

/** Required fields per log type (for schema validation). */
export const REQUIRED_FIELDS: Record<string, Set<string>> = {
  session_telemetry: new Set(["timestamp", "session_id", "source"]),
  skill_usage: new Set(["timestamp", "session_id", "skill_name"]),
  all_queries: new Set(["timestamp", "session_id", "query"]),
  evolution_audit: new Set(["timestamp", "proposal_id", "action"]),
};

/** Agent CLI candidates in detection order. */
export const AGENT_CANDIDATES = ["claude", "codex", "opencode"] as const;

/** Anthropic API URL for direct grading. */
export const API_URL = "https://api.anthropic.com/v1/messages";

/** Default model for direct API grading. */
export const MODEL = "claude-sonnet-4-20250514";
