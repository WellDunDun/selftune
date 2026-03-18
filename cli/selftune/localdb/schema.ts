/**
 * SQLite schema definitions for the selftune local materialized view store.
 *
 * Tables mirror the canonical telemetry contract + local JSONL log shapes,
 * providing indexed access for dashboard and report queries.
 */

// -- Canonical telemetry tables -----------------------------------------------

export const CREATE_SESSIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  started_at        TEXT,
  ended_at          TEXT,
  platform          TEXT,
  model             TEXT,
  completion_status TEXT,
  source_session_kind TEXT,
  agent_cli         TEXT,
  workspace_path    TEXT,
  repo_remote       TEXT,
  branch            TEXT,
  schema_version    TEXT,
  normalized_at     TEXT
)`;

export const CREATE_PROMPTS = `
CREATE TABLE IF NOT EXISTS prompts (
  prompt_id     TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  occurred_at   TEXT,
  prompt_kind   TEXT,
  is_actionable INTEGER,
  prompt_index  INTEGER,
  prompt_text   TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
)`;

export const CREATE_SKILL_INVOCATIONS = `
CREATE TABLE IF NOT EXISTS skill_invocations (
  skill_invocation_id TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  occurred_at         TEXT,
  skill_name          TEXT NOT NULL,
  invocation_mode     TEXT,
  triggered           INTEGER,
  confidence          REAL,
  tool_name           TEXT,
  matched_prompt_id   TEXT,
  agent_type          TEXT,
  query               TEXT,
  skill_path          TEXT,
  skill_scope         TEXT,
  source              TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
)`;

export const CREATE_EXECUTION_FACTS = `
CREATE TABLE IF NOT EXISTS execution_facts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  occurred_at         TEXT,
  prompt_id           TEXT,
  tool_calls_json     TEXT,
  total_tool_calls    INTEGER,
  assistant_turns     INTEGER,
  errors_encountered  INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  duration_ms         INTEGER,
  completion_status   TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
)`;

// -- Evolution tables ---------------------------------------------------------

export const CREATE_EVOLUTION_EVIDENCE = `
CREATE TABLE IF NOT EXISTS evolution_evidence (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,
  proposal_id     TEXT NOT NULL,
  skill_name      TEXT NOT NULL,
  skill_path      TEXT,
  target          TEXT,
  stage           TEXT,
  rationale       TEXT,
  confidence      REAL,
  details         TEXT,
  original_text   TEXT,
  proposed_text   TEXT,
  eval_set_json   TEXT,
  validation_json TEXT
)`;

export const CREATE_EVOLUTION_AUDIT = `
CREATE TABLE IF NOT EXISTS evolution_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,
  proposal_id     TEXT NOT NULL,
  skill_name      TEXT,
  action          TEXT NOT NULL,
  details         TEXT,
  eval_snapshot_json TEXT
)`;

// -- Local telemetry tables (from JSONL logs) ---------------------------------

export const CREATE_SESSION_TELEMETRY = `
CREATE TABLE IF NOT EXISTS session_telemetry (
  session_id          TEXT PRIMARY KEY,
  timestamp           TEXT NOT NULL,
  cwd                 TEXT,
  transcript_path     TEXT,
  tool_calls_json     TEXT,
  total_tool_calls    INTEGER,
  bash_commands_json  TEXT,
  skills_triggered_json TEXT,
  skills_invoked_json TEXT,
  assistant_turns     INTEGER,
  errors_encountered  INTEGER,
  transcript_chars    INTEGER,
  last_user_query     TEXT,
  source              TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER
)`;

export const CREATE_SKILL_USAGE = `
CREATE TABLE IF NOT EXISTS skill_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  skill_name  TEXT NOT NULL,
  skill_path  TEXT,
  skill_scope TEXT,
  query       TEXT,
  triggered   INTEGER,
  source      TEXT
)`;

// -- Orchestrate run reports --------------------------------------------------

export const CREATE_ORCHESTRATE_RUNS = `
CREATE TABLE IF NOT EXISTS orchestrate_runs (
  run_id          TEXT PRIMARY KEY,
  timestamp       TEXT NOT NULL,
  elapsed_ms      INTEGER NOT NULL,
  dry_run         INTEGER NOT NULL,
  approval_mode   TEXT NOT NULL,
  total_skills    INTEGER NOT NULL,
  evaluated       INTEGER NOT NULL,
  evolved         INTEGER NOT NULL,
  deployed        INTEGER NOT NULL,
  watched         INTEGER NOT NULL,
  skipped         INTEGER NOT NULL,
  skill_actions_json TEXT NOT NULL
)`;

// -- Query log table (from all_queries_log.jsonl) ----------------------------

export const CREATE_QUERIES = `
CREATE TABLE IF NOT EXISTS queries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  query       TEXT NOT NULL,
  source      TEXT
)`;

// -- Improvement signal table (from signal_log.jsonl) ------------------------

export const CREATE_IMPROVEMENT_SIGNALS = `
CREATE TABLE IF NOT EXISTS improvement_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  query           TEXT NOT NULL,
  signal_type     TEXT NOT NULL,
  mentioned_skill TEXT,
  consumed        INTEGER NOT NULL DEFAULT 0,
  consumed_at     TEXT,
  consumed_by_run TEXT
)`;

// -- Metadata table -----------------------------------------------------------

export const CREATE_META = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`;

// -- Indexes ------------------------------------------------------------------

export const CREATE_INDEXES = [
  // -- Lookup indexes ---------------------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_prompts_occurred ON prompts(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_session ON skill_invocations(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_name ON skill_invocations(skill_name)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_ts ON skill_invocations(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_exec_facts_session ON execution_facts(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evo_evidence_proposal ON evolution_evidence(proposal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evo_evidence_skill ON evolution_evidence(skill_name)`,
  `CREATE INDEX IF NOT EXISTS idx_evo_evidence_ts ON evolution_evidence(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_evo_audit_proposal ON evolution_audit(proposal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evo_audit_ts ON evolution_audit(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_evo_audit_action ON evolution_audit(action)`,
  `CREATE INDEX IF NOT EXISTS idx_session_tel_ts ON session_telemetry(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_usage_session ON skill_usage(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_usage_name ON skill_usage(skill_name)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_usage_ts ON skill_usage(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_usage_query_triggered ON skill_usage(query, triggered)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_usage_scope ON skill_usage(skill_name, skill_scope, timestamp)`,
  // -- Dedup UNIQUE indexes (used by INSERT OR IGNORE in materializer) --------
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_usage_dedup ON skill_usage(session_id, skill_name, query, timestamp, triggered)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_evo_audit_dedup ON evolution_audit(proposal_id, action, timestamp)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_evo_evidence_dedup ON evolution_evidence(proposal_id, stage, timestamp)`,
  // -- Orchestrate run indexes -----------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_orchestrate_runs_ts ON orchestrate_runs(timestamp)`,
  // -- Query log indexes ------------------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_queries_session ON queries(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_queries_ts ON queries(timestamp)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_queries_dedup ON queries(session_id, query, timestamp)`,
  // -- Improvement signal indexes ---------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_signals_session ON improvement_signals(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_consumed ON improvement_signals(consumed)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_ts ON improvement_signals(timestamp)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup ON improvement_signals(session_id, query, signal_type, timestamp)`,
];

/**
 * Schema migrations — ALTER TABLE statements for columns added after initial release.
 * Each is safe to re-run: SQLite throws "duplicate column" which openDb() catches.
 */
export const MIGRATIONS = [
  // skill_invocations consolidation (skill_usage columns merged in)
  `ALTER TABLE skill_invocations ADD COLUMN query TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN skill_path TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN skill_scope TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN source TEXT`,
];

/** Indexes that depend on migration columns — must run AFTER MIGRATIONS. */
export const POST_MIGRATION_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_query_triggered ON skill_invocations(query, triggered)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_scope ON skill_invocations(skill_name, skill_scope, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_dedup ON skill_invocations(session_id, skill_name, query, occurred_at, triggered)`,
];

/** All DDL statements in creation order. */
export const ALL_DDL = [
  CREATE_SESSIONS,
  CREATE_PROMPTS,
  CREATE_SKILL_INVOCATIONS,
  CREATE_EXECUTION_FACTS,
  CREATE_EVOLUTION_EVIDENCE,
  CREATE_EVOLUTION_AUDIT,
  CREATE_SESSION_TELEMETRY,
  CREATE_SKILL_USAGE,
  CREATE_ORCHESTRATE_RUNS,
  CREATE_QUERIES,
  CREATE_IMPROVEMENT_SIGNALS,
  CREATE_META,
  ...CREATE_INDEXES,
];
