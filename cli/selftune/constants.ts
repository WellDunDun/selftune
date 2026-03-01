/**
 * Shared constants for selftune.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const SELFTUNE_CONFIG_DIR = join(homedir(), ".selftune");
export const SELFTUNE_CONFIG_PATH = join(SELFTUNE_CONFIG_DIR, "config.json");

export const LOG_DIR = join(homedir(), ".claude");

export const TELEMETRY_LOG = join(LOG_DIR, "session_telemetry_log.jsonl");
export const SKILL_LOG = join(LOG_DIR, "skill_usage_log.jsonl");
export const QUERY_LOG = join(LOG_DIR, "all_queries_log.jsonl");
export const EVOLUTION_AUDIT_LOG = join(LOG_DIR, "evolution_audit_log.jsonl");

/** Evolution memory directory — human-readable session context that survives resets. */
export const MEMORY_DIR = join(SELFTUNE_CONFIG_DIR, "memory");
export const CONTEXT_PATH = join(MEMORY_DIR, "context.md");
export const PLAN_PATH = join(MEMORY_DIR, "plan.md");
export const DECISIONS_PATH = join(MEMORY_DIR, "decisions.md");

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

/** Path for user-defined activation rule overrides. */
export const ACTIVATION_RULES_PATH = join(SELFTUNE_CONFIG_DIR, "activation-rules.json");

/** Per-session state file pattern (interpolate session_id). */
export const SESSION_STATE_DIR = SELFTUNE_CONFIG_DIR;

/** Build a session state file path from a session ID. */
export function sessionStatePath(sessionId: string): string {
  // Sanitize session ID to be filesystem-safe
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSION_STATE_DIR, `session-state-${safe}.json`);
}

/** Claude Code settings file path. */
export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
