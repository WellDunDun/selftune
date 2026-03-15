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
  CREATE_META,
  ...CREATE_INDEXES,
];
