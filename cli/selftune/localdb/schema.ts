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
  normalized_at     TEXT,
  normalizer_version TEXT,
  capture_mode       TEXT,
  raw_source_ref     TEXT
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
  schema_version     TEXT,
  platform           TEXT,
  normalized_at      TEXT,
  normalizer_version TEXT,
  capture_mode       TEXT,
  raw_source_ref     TEXT,
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
  schema_version      TEXT,
  platform            TEXT,
  normalized_at       TEXT,
  normalizer_version  TEXT,
  capture_mode        TEXT,
  raw_source_ref      TEXT,
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
  schema_version      TEXT,
  platform            TEXT,
  normalized_at       TEXT,
  normalizer_version  TEXT,
  capture_mode        TEXT,
  raw_source_ref      TEXT,
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

// -- Grading results table (from grade-session output) -----------------------

export const CREATE_GRADING_RESULTS = `
CREATE TABLE IF NOT EXISTS grading_results (
  grading_id              TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL,
  skill_name              TEXT NOT NULL,
  transcript_path         TEXT,
  graded_at               TEXT NOT NULL,
  pass_rate               REAL,
  mean_score              REAL,
  score_std_dev           REAL,
  passed_count            INTEGER,
  failed_count            INTEGER,
  total_count             INTEGER,
  expectations_json       TEXT,
  claims_json             TEXT,
  eval_feedback_json      TEXT,
  failure_feedback_json   TEXT,
  execution_metrics_json  TEXT
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

// -- Alpha upload queue -------------------------------------------------------

export const CREATE_UPLOAD_QUEUE = `
CREATE TABLE IF NOT EXISTS upload_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_type  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_error    TEXT
)`;

// -- Canonical upload staging -------------------------------------------------

export const CREATE_CANONICAL_UPLOAD_STAGING = `
CREATE TABLE IF NOT EXISTS canonical_upload_staging (
  local_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  record_kind   TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  record_json   TEXT NOT NULL,
  session_id    TEXT,
  prompt_id     TEXT,
  normalized_at TEXT,
  staged_at     TEXT NOT NULL
)`;

export const CREATE_UPLOAD_WATERMARKS = `
CREATE TABLE IF NOT EXISTS upload_watermarks (
  payload_type     TEXT PRIMARY KEY,
  last_uploaded_id INTEGER NOT NULL,
  updated_at       TEXT NOT NULL
)`;

// -- Commit tracking table ----------------------------------------------------

export const CREATE_COMMIT_TRACKING = `
CREATE TABLE IF NOT EXISTS commit_tracking (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  commit_title  TEXT,
  branch        TEXT,
  repo_remote   TEXT,
  timestamp     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  // -- Grading results indexes -------------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_grading_session ON grading_results(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_grading_skill ON grading_results(skill_name)`,
  `CREATE INDEX IF NOT EXISTS idx_grading_ts ON grading_results(graded_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_grading_dedup ON grading_results(session_id, skill_name, graded_at)`,
  // -- Improvement signal indexes ---------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_signals_session ON improvement_signals(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_consumed ON improvement_signals(consumed)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_ts ON improvement_signals(timestamp)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup ON improvement_signals(session_id, query, signal_type, timestamp)`,
  // -- Alpha upload queue indexes ---------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_upload_queue_status ON upload_queue(status)`,
  `CREATE INDEX IF NOT EXISTS idx_upload_queue_type_status ON upload_queue(payload_type, status)`,
  // -- Canonical upload staging indexes ---------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_staging_kind ON canonical_upload_staging(record_kind)`,
  `CREATE INDEX IF NOT EXISTS idx_staging_session ON canonical_upload_staging(session_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_dedup ON canonical_upload_staging(record_kind, record_id)`,
  // -- Commit tracking indexes ------------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_commit_sha ON commit_tracking(commit_sha)`,
  `CREATE INDEX IF NOT EXISTS idx_commit_session ON commit_tracking(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_commit_ts ON commit_tracking(timestamp)`,
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
  // Track how many iteration loops each evolution run used
  `ALTER TABLE evolution_audit ADD COLUMN iterations_used INTEGER`,
  // Canonical contract fields for upload staging (sessions already has schema_version, platform, normalized_at)
  `ALTER TABLE sessions ADD COLUMN normalizer_version TEXT`,
  `ALTER TABLE sessions ADD COLUMN capture_mode TEXT`,
  `ALTER TABLE sessions ADD COLUMN raw_source_ref TEXT`,
  `ALTER TABLE prompts ADD COLUMN schema_version TEXT`,
  `ALTER TABLE prompts ADD COLUMN platform TEXT`,
  `ALTER TABLE prompts ADD COLUMN normalized_at TEXT`,
  `ALTER TABLE prompts ADD COLUMN normalizer_version TEXT`,
  `ALTER TABLE prompts ADD COLUMN capture_mode TEXT`,
  `ALTER TABLE prompts ADD COLUMN raw_source_ref TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN schema_version TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN platform TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN normalized_at TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN normalizer_version TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN capture_mode TEXT`,
  `ALTER TABLE skill_invocations ADD COLUMN raw_source_ref TEXT`,
  `ALTER TABLE execution_facts ADD COLUMN schema_version TEXT`,
  `ALTER TABLE execution_facts ADD COLUMN platform TEXT`,
  `ALTER TABLE execution_facts ADD COLUMN normalized_at TEXT`,
  `ALTER TABLE execution_facts ADD COLUMN normalizer_version TEXT`,
  `ALTER TABLE execution_facts ADD COLUMN capture_mode TEXT`,
  `ALTER TABLE execution_facts ADD COLUMN raw_source_ref TEXT`,
  // -- Win 2+3: File change metrics + token granularity + cost (execution_facts) --
  `ALTER TABLE execution_facts ADD COLUMN files_changed INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN lines_added INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN lines_removed INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN lines_modified INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN cached_input_tokens INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN reasoning_output_tokens INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN cost_usd REAL`,
  // -- Win 2+3: File change metrics + token granularity + cost (session_telemetry) --
  `ALTER TABLE session_telemetry ADD COLUMN files_changed INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN lines_added INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN lines_removed INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN lines_modified INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN cached_input_tokens INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN reasoning_output_tokens INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN cost_usd REAL`,
  // -- Generalized metrics: artifact count + session type --
  `ALTER TABLE execution_facts ADD COLUMN artifact_count INTEGER`,
  `ALTER TABLE execution_facts ADD COLUMN session_type TEXT`,
  `ALTER TABLE session_telemetry ADD COLUMN artifact_count INTEGER`,
  `ALTER TABLE session_telemetry ADD COLUMN session_type TEXT`,
  // -- Session summary (heuristic, no LLM) --
  `ALTER TABLE session_telemetry ADD COLUMN agent_summary TEXT`,
  // -- SHA256 content hashing for upload dedup --
  `ALTER TABLE canonical_upload_staging ADD COLUMN content_sha256 TEXT`,
];

/** Indexes that depend on migration columns — must run AFTER MIGRATIONS. */
export const POST_MIGRATION_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_query_triggered ON skill_invocations(query, triggered)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_scope ON skill_invocations(skill_name, skill_scope, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_inv_dedup ON skill_invocations(session_id, skill_name, query, occurred_at, triggered)`,
  `CREATE INDEX IF NOT EXISTS idx_staging_sha256 ON canonical_upload_staging(content_sha256)`,
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
  CREATE_GRADING_RESULTS,
  CREATE_IMPROVEMENT_SIGNALS,
  CREATE_UPLOAD_QUEUE,
  CREATE_UPLOAD_WATERMARKS,
  CREATE_CANONICAL_UPLOAD_STAGING,
  CREATE_COMMIT_TRACKING,
  CREATE_META,
  ...CREATE_INDEXES,
];
