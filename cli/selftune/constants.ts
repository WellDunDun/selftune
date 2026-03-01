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

/** Path to Claude Code projects directory containing session transcripts. */
export const CLAUDE_CODE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Marker file tracking which Claude Code sessions have been ingested. */
export const CLAUDE_CODE_MARKER = join(homedir(), ".claude", "claude_code_ingested_sessions.json");

/** Default output directory for contribution bundles. */
export const CONTRIBUTIONS_DIR = join(SELFTUNE_CONFIG_DIR, "contributions");

// ---------------------------------------------------------------------------
// Sanitization constants (for contribute command)
// ---------------------------------------------------------------------------

/** Regex patterns for detecting secrets that must be redacted. */
export const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI / Anthropic API keys
  /ghp_[a-zA-Z0-9]{36,}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g, // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g, // GitHub fine-grained PATs
  /AKIA[A-Z0-9]{16}/g, // AWS access key IDs
  /xoxb-[a-zA-Z0-9-]+/g, // Slack bot tokens
  /xoxp-[a-zA-Z0-9-]+/g, // Slack user tokens
  /xoxs-[a-zA-Z0-9-]+/g, // Slack session tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWTs
  /npm_[a-zA-Z0-9]{36}/g, // npm tokens
  /pypi-[a-zA-Z0-9]{36,}/g, // PyPI tokens
] as const;

/** Regex for file paths (Unix and Windows). */
export const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}|[A-Z]:\\[\w\\.-]+/g;

/** Regex for email addresses. */
export const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

/** Regex for IP addresses (v4). */
export const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

/** Regex for camelCase/PascalCase identifiers longer than 8 chars (aggressive mode). */
export const IDENTIFIER_PATTERN = /\b[a-z][a-zA-Z0-9]{8,}\b|\b[A-Z][a-zA-Z0-9]{8,}\b/g;

/** Regex for import/require/from module paths (aggressive mode). */
export const MODULE_PATTERN = /(?:import|require|from)\s+["']([^"']+)["']/g;

/** Max query length for aggressive sanitization. */
export const AGGRESSIVE_MAX_QUERY_LENGTH = 200;
