-- Alpha telemetry D1 schema
-- Mirrors the design in docs/design-docs/alpha-remote-data-contract.md

-- User registry
CREATE TABLE IF NOT EXISTS alpha_users (
  user_id          TEXT PRIMARY KEY,
  first_seen_at    TEXT NOT NULL,
  last_upload_at   TEXT
);

-- Session summaries
CREATE TABLE IF NOT EXISTS alpha_sessions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  platform              TEXT,
  model                 TEXT,
  workspace_hash        TEXT,
  started_at            TEXT,
  ended_at              TEXT,
  total_tool_calls      INTEGER,
  assistant_turns       INTEGER,
  errors_encountered    INTEGER,
  skills_triggered_json TEXT,
  completion_status     TEXT,
  uploaded_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES alpha_users(user_id)
);

-- Skill invocations
CREATE TABLE IF NOT EXISTS alpha_invocations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  skill_name       TEXT NOT NULL,
  invocation_mode  TEXT,
  triggered        INTEGER NOT NULL,
  confidence       REAL,
  query_text       TEXT,
  skill_scope      TEXT,
  source           TEXT,
  uploaded_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES alpha_users(user_id)
);

-- Evolution outcomes
CREATE TABLE IF NOT EXISTS alpha_evolution_outcomes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT NOT NULL,
  proposal_id      TEXT NOT NULL,
  skill_name       TEXT NOT NULL,
  action           TEXT NOT NULL,
  before_pass_rate REAL,
  after_pass_rate  REAL,
  net_change       REAL,
  deployed         INTEGER,
  rolled_back      INTEGER,
  timestamp        TEXT NOT NULL,
  uploaded_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES alpha_users(user_id)
);

-- Indexes: user_id on all tables
CREATE INDEX IF NOT EXISTS idx_alpha_sessions_user ON alpha_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_sessions_session ON alpha_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_alpha_invocations_user ON alpha_invocations(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_invocations_session ON alpha_invocations(session_id);
CREATE INDEX IF NOT EXISTS idx_alpha_invocations_skill ON alpha_invocations(skill_name);
CREATE INDEX IF NOT EXISTS idx_alpha_evo_user ON alpha_evolution_outcomes(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_evo_skill ON alpha_evolution_outcomes(skill_name);
CREATE INDEX IF NOT EXISTS idx_alpha_evo_proposal ON alpha_evolution_outcomes(proposal_id);
