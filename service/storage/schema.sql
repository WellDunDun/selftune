-- Selftune badge service schema

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  schema_version TEXT NOT NULL DEFAULT '1.1'
);

CREATE INDEX IF NOT EXISTS idx_submissions_skill ON submissions(skill_name);
CREATE INDEX IF NOT EXISTS idx_submissions_ip_hash ON submissions(ip_hash, accepted_at);

CREATE TABLE IF NOT EXISTS skill_aggregations (
  skill_name TEXT PRIMARY KEY,
  weighted_pass_rate REAL NOT NULL DEFAULT 0,
  trend TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'NO DATA',
  contributor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT ''
);
