import type { Database } from "bun:sqlite";

import type { CommitRecord, CommitSummary, ExecutionMetrics } from "../../dashboard-contract.js";

export function getExecutionMetrics(db: Database, sessionIds: string[]): ExecutionMetrics {
  const empty: ExecutionMetrics = {
    avg_files_changed: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    total_cost_usd: 0,
    avg_cost_usd: 0,
    cached_input_tokens_total: 0,
    reasoning_output_tokens_total: 0,
    artifact_count: 0,
    session_type_distribution: {},
  };
  if (sessionIds.length === 0) return empty;

  const placeholders = sessionIds.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT
         COALESCE(AVG(files_changed), 0) AS avg_files_changed,
         COALESCE(SUM(lines_added), 0) AS total_lines_added,
         COALESCE(SUM(lines_removed), 0) AS total_lines_removed,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         COALESCE(AVG(cost_usd), 0) AS avg_cost_usd,
         COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens_total,
         COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens_total,
         COALESCE(SUM(artifact_count), 0) AS artifact_count
       FROM execution_facts
       WHERE session_id IN (${placeholders})`,
    )
    .get(...sessionIds) as {
    avg_files_changed: number;
    total_lines_added: number;
    total_lines_removed: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    cached_input_tokens_total: number;
    reasoning_output_tokens_total: number;
    artifact_count: number;
  } | null;

  const typeRows = db
    .query(
      `SELECT session_type, COUNT(*) AS count
       FROM execution_facts
       WHERE session_id IN (${placeholders}) AND session_type IS NOT NULL
       GROUP BY session_type`,
    )
    .all(...sessionIds) as Array<{ session_type: string; count: number }>;

  const session_type_distribution: Record<string, number> = {};
  for (const rowEntry of typeRows) {
    session_type_distribution[rowEntry.session_type] = rowEntry.count;
  }

  return {
    avg_files_changed: row?.avg_files_changed ?? 0,
    total_lines_added: row?.total_lines_added ?? 0,
    total_lines_removed: row?.total_lines_removed ?? 0,
    total_cost_usd: row?.total_cost_usd ?? 0,
    avg_cost_usd: row?.avg_cost_usd ?? 0,
    cached_input_tokens_total: row?.cached_input_tokens_total ?? 0,
    reasoning_output_tokens_total: row?.reasoning_output_tokens_total ?? 0,
    artifact_count: row?.artifact_count ?? 0,
    session_type_distribution,
  };
}

export function getSessionCommits(db: Database, sessionId: string): CommitRecord[] {
  return db
    .query(
      `SELECT commit_sha, commit_title, branch, repo_remote, timestamp
       FROM commit_tracking
       WHERE session_id = ?
       ORDER BY timestamp DESC`,
    )
    .all(sessionId) as CommitRecord[];
}

export function getSkillCommitSummary(db: Database, skillName: string): CommitSummary {
  const empty: CommitSummary = {
    total_commits: 0,
    unique_branches: 0,
    recent_commits: [],
  };

  const statsRow = db
    .query(
      `WITH skill_sessions AS (
         SELECT DISTINCT session_id FROM skill_invocations WHERE skill_name = ?
       )
       SELECT
         COUNT(*) AS total_commits,
         COUNT(DISTINCT ct.branch) AS unique_branches
       FROM commit_tracking ct
       WHERE ct.session_id IN (SELECT session_id FROM skill_sessions)`,
    )
    .get(skillName) as { total_commits: number; unique_branches: number } | null;

  if (!statsRow || statsRow.total_commits === 0) return empty;

  const recentRows = db
    .query(
      `WITH skill_sessions AS (
         SELECT DISTINCT session_id FROM skill_invocations WHERE skill_name = ?
       )
       SELECT ct.commit_sha, ct.commit_title, ct.branch, ct.timestamp
       FROM commit_tracking ct
       WHERE ct.session_id IN (SELECT session_id FROM skill_sessions)
       ORDER BY ct.timestamp DESC
       LIMIT 20`,
    )
    .all(skillName) as Array<{
    commit_sha: string;
    commit_title: string | null;
    branch: string | null;
    timestamp: string;
  }>;

  return {
    total_commits: statsRow.total_commits,
    unique_branches: statsRow.unique_branches,
    recent_commits: recentRows.map((row) => ({
      sha: row.commit_sha,
      title: row.commit_title ?? "",
      branch: row.branch ?? "",
      timestamp: row.timestamp,
    })),
  };
}
