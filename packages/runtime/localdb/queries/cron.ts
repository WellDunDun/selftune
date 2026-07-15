import type { Database } from "bun:sqlite";

export interface CronRun {
  id: number;
  job_name: string;
  started_at: string;
  elapsed_ms: number;
  status: string;
  metrics_json: string | null;
  error: string | null;
}

export function getRecentCronRuns(db: Database, limit = 50): CronRun[] {
  return db
    .query(
      `SELECT id, job_name, started_at, elapsed_ms, status, metrics_json, error
       FROM cron_runs
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit) as CronRun[];
}

export function getCronRunsByJob(db: Database, jobName: string, limit = 50): CronRun[] {
  return db
    .query(
      `SELECT id, job_name, started_at, elapsed_ms, status, metrics_json, error
       FROM cron_runs
       WHERE job_name = ?
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(jobName, limit) as CronRun[];
}
