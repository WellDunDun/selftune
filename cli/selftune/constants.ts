/**
 * Shared constants for selftune.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const resolvedHome = process.env.SELFTUNE_HOME;
const defaultHome = resolvedHome ?? homedir();
const claudeHomeDir =
  process.env.SELFTUNE_CLAUDE_DIR ??
  (resolvedHome ? join(defaultHome, ".claude") : join(homedir(), ".claude"));
const openclawHomeDir =
  process.env.SELFTUNE_OPENCLAW_DIR ??
  (resolvedHome ? join(defaultHome, ".openclaw") : join(homedir(), ".openclaw"));

export const SELFTUNE_CONFIG_DIR =
  (process.env.SELFTUNE_CONFIG_DIR || undefined) ??
  (resolvedHome ? join(defaultHome, ".selftune") : join(homedir(), ".selftune"));

export const SELFTUNE_CONFIG_PATH = join(SELFTUNE_CONFIG_DIR, "config.json");

export const LOG_DIR = (process.env.SELFTUNE_LOG_DIR || undefined) ?? claudeHomeDir;

/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const TELEMETRY_LOG = join(LOG_DIR, "session_telemetry_log.jsonl");
export const SKILL_LOG = join(LOG_DIR, "skill_usage_log.jsonl");
export const REPAIRED_SKILL_LOG = join(LOG_DIR, "skill_usage_repaired.jsonl");
/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const CANONICAL_LOG = join(LOG_DIR, "canonical_telemetry_log.jsonl");
export const REPAIRED_SKILL_SESSIONS_MARKER = join(LOG_DIR, "skill_usage_repaired_sessions.json");
/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const QUERY_LOG = join(LOG_DIR, "all_queries_log.jsonl");
/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const EVOLUTION_AUDIT_LOG = join(LOG_DIR, "evolution_audit_log.jsonl");
/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const EVOLUTION_EVIDENCE_LOG = join(LOG_DIR, "evolution_evidence_log.jsonl");
/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const ORCHESTRATE_RUN_LOG = join(LOG_DIR, "orchestrate_runs.jsonl");
/** @deprecated Phase 3: JSONL writes removed. Used only by materializer recovery and export. */
export const SIGNAL_LOG = join(LOG_DIR, "improvement_signals.jsonl");
export const ORCHESTRATE_LOCK = join(LOG_DIR, ".orchestrate.lock");

/** Allow tests to override the orchestrate lock without mutating the host lock file. */
export function getOrchestrateLockPath(): string {
  return process.env.SELFTUNE_ORCHESTRATE_LOCK_PATH || ORCHESTRATE_LOCK;
}

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
  evolution_evidence: new Set(["timestamp", "proposal_id", "skill_name", "stage"]),
};

/** Agent CLI candidates in detection order. */
export const AGENT_CANDIDATES = ["claude", "codex", "opencode", "openclaw"] as const;

/** Required Claude Code hook keys in settings.json. */
export const CLAUDE_CODE_HOOK_KEYS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

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

/** Build a canonical prompt state file path from a session ID. */
export function canonicalSessionStatePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSION_STATE_DIR, `canonical-session-state-${safe}.json`);
}

/** Claude Code settings file path. */
export const CLAUDE_SETTINGS_PATH =
  process.env.SELFTUNE_CLAUDE_SETTINGS_PATH ?? join(claudeHomeDir, "settings.json");

/** Path to Claude Code projects directory containing session transcripts. */
export const CLAUDE_CODE_PROJECTS_DIR =
  process.env.SELFTUNE_CLAUDE_PROJECTS_DIR ?? join(claudeHomeDir, "projects");

/** Marker file tracking which Claude Code sessions have been ingested. */
export const CLAUDE_CODE_MARKER =
  process.env.SELFTUNE_CLAUDE_MARKER_PATH ??
  join(claudeHomeDir, "claude_code_ingested_sessions.json");

/** Marker file tracking which Codex rollout files have been ingested. */
export const CODEX_INGEST_MARKER =
  process.env.SELFTUNE_CODEX_MARKER_PATH ?? join(claudeHomeDir, "codex_ingested_rollouts.json");

/** Marker file tracking which OpenCode sessions have been ingested. */
export const OPENCODE_INGEST_MARKER =
  process.env.SELFTUNE_OPENCODE_MARKER_PATH ??
  join(claudeHomeDir, "opencode_ingested_sessions.json");

/** OpenClaw agents directory containing session data. */
export const OPENCLAW_AGENTS_DIR =
  process.env.SELFTUNE_OPENCLAW_AGENTS_DIR ?? join(openclawHomeDir, "agents");

/** Marker file tracking which OpenClaw sessions have been ingested. */
export const OPENCLAW_INGEST_MARKER = join(SELFTUNE_CONFIG_DIR, "openclaw-ingest-marker.json");

/** Default output directory for contribution bundles. */
export const CONTRIBUTIONS_DIR = join(SELFTUNE_CONFIG_DIR, "contributions");
/** Creator-directed contribution preferences (per-skill opt-in state). */
export const CONTRIBUTION_PREFERENCES_PATH = join(
  SELFTUNE_CONFIG_DIR,
  "contribution-preferences.json",
);
/** Creator overview watchlist preference. */
export const WATCHED_SKILLS_PATH = join(SELFTUNE_CONFIG_DIR, "watched-skills.json");
/** Creator-directed relay endpoint for staged contribution signals. */
export const CONTRIBUTION_RELAY_ENDPOINT =
  process.env.SELFTUNE_CONTRIBUTION_RELAY_ENDPOINT ?? "https://api.selftune.dev/api/v1/signals";

// ---------------------------------------------------------------------------
// Sanitization constants (for contribute command)
// ---------------------------------------------------------------------------

/** Regex patterns for detecting secrets that must be redacted. */
export const SECRET_PATTERNS = [
  // -- API keys & tokens (platform-specific prefixes) --
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI API keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g, // Anthropic API keys
  /ghp_[a-zA-Z0-9]{36,}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g, // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g, // GitHub fine-grained PATs
  /npm_[a-zA-Z0-9]{36}/g, // npm tokens
  /pypi-[a-zA-Z0-9]{36,}/g, // PyPI tokens

  // -- AWS --
  /AKIA[A-Z0-9]{16}/g, // AWS access key IDs (permanent)
  /ASIA[A-Z0-9]{16}/g, // AWS temporary credentials (STS)

  // -- GCP --
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key

  // -- Stripe --
  /(sk|pk|rk)_(test|live)_[a-zA-Z0-9]{24,}/g, // Stripe secret/publishable/restricted keys

  // -- Twilio --
  /SK[a-f0-9]{32}/g, // Twilio API key

  // -- SendGrid --
  /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, // SendGrid API key

  // -- Mailgun --
  /key-[a-zA-Z0-9]{32}/g, // Mailgun API key

  // -- Slack --
  /xoxb-[a-zA-Z0-9-]+/g, // Slack bot tokens
  /xoxp-[a-zA-Z0-9-]+/g, // Slack user tokens
  /xoxs-[a-zA-Z0-9-]+/g, // Slack session tokens

  // -- JWTs --
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JSON Web Tokens

  // -- Private keys (PEM block headers) --
  /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g, // PEM private key blocks (full multiline)

  // -- Database connection URIs --
  /(mongodb(\+srv)?|postgres(ql)?|mysql|mariadb|redis|rediss|amqp|amqps):\/\/[^\s"')]+/g, // DB URIs with credentials

  // -- Azure --
  /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/g, // Azure storage connection string

  // -- Webhook URLs --
  /https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[a-zA-Z0-9_-]+/g, // Discord webhook
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/g, // Slack webhook

  // -- SSH keys --
  /ssh-(rsa|ed25519|ecdsa|dsa)\s+[A-Za-z0-9+/]{40,}[=]{0,3}/g, // SSH public key material

  // -- Generic high-confidence patterns --
  /Bearer\s+[a-zA-Z0-9_-]{20,}/g, // Bearer tokens in auth headers
  /https?:\/\/[^:]+:[^@]+@[^\s"']+/g, // Basic auth embedded in URLs
  /(?<![a-fA-F0-9])[a-fA-F0-9]{64,}(?![a-fA-F0-9])/g, // Long hex strings (64+ chars, likely secrets)
] as const;

/** Regex for file paths (Unix and Windows). */
export const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}|[A-Z]:\\[\w\\.-]+/g;

/** Regex for email addresses. */
export const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

/** Regex for IP addresses (v4). */
export const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// ---------------------------------------------------------------------------
// PII patterns — high-confidence, low-false-positive personally identifiable info
// ---------------------------------------------------------------------------

export const PII_PATTERNS = [
  // -- Phone numbers --
  /\+\d{1,3}\s?\d{1,4}\s?\d{1,4}\s?\d{1,9}/g, // E.164 intl: +1 555 123 4567, +44 20 7946 0958
  /\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, // US/CA phone: (555) 123-4567, 555-123-4567, 555.123.4567

  // -- Credit card numbers (major networks, with optional separators) --
  /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Visa (starts with 4)
  /\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Mastercard (51-55)
  /\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b/g, // Amex (34/37)
  /\b6(?:011|5\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Discover (6011/65)

  // -- SSN / national IDs --
  /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN: 123-45-6789

  // -- IPv6 --
  /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, // Full IPv6
  /\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?(?!\w)/g, // Abbreviated IPv6 (with ::)
  /::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/g, // Abbreviated IPv6 (leading ::1, ::ffff:...)

  // -- Date of birth patterns (in structured contexts) --
  /\b(?:dob|date\.of\.birth|birthday|born)\s*[:=]\s*\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/gi, // DOB in key-value context
] as const;

/** Regex for camelCase/PascalCase identifiers longer than 8 chars (aggressive mode). */
export const IDENTIFIER_PATTERN = /\b[a-z][a-zA-Z0-9]{8,}\b|\b[A-Z][a-zA-Z0-9]{8,}\b/g;

/** Regex for import/require/from module paths (aggressive mode). */
export const MODULE_PATTERN = /(?:import|require|from)\s+["']([^"']+)["']/g;

/** Max query length for aggressive sanitization. */
export const AGGRESSIVE_MAX_QUERY_LENGTH = 200;
