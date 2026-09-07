export function getCreatorContributionStagingCounts(db: Database): Array<{
  skill_name: string;
  pending_count: number;
}> {
  return db
    .query<{ skill_name: string; pending_count: number }, []>(
      `SELECT skill_name, COUNT(*) AS pending_count
       FROM creator_contribution_staging
       WHERE status = 'pending'
       GROUP BY skill_name
       ORDER BY skill_name`,
    )
    .all();
}

export interface CreatorContributionRelayStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

export interface CreatorContributionStagingRow {
  id: number;
  dedupe_key: string;
  skill_name: string;
  creator_id: string;
  payload_json: string;
  status: string;
  staged_at: string;
  updated_at: string;
  last_error: string | null;
}

export function getCreatorContributionRelayStats(db: Database): CreatorContributionRelayStats {
  const row = db
    .query<CreatorContributionRelayStats, []>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END), 0) AS sending,
         COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM creator_contribution_staging`,
    )
    .get();
  return row ?? { pending: 0, sending: 0, sent: 0, failed: 0 };
}

export function getPendingCreatorContributionRows(
  db: Database,
  limit = 50,
): CreatorContributionStagingRow[] {
  return db
    .query<CreatorContributionStagingRow, [number]>(
      `SELECT id, dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at, last_error
       FROM creator_contribution_staging
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(limit);
}
import type { Database } from "bun:sqlite";
