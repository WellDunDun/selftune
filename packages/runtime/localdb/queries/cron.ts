import type { Database } from "bun:sqlite";
import type { cron_runs } from "../drizzle-schema.js";

export type CronRun = typeof cron_runs.$inferSelect;

export function getRecentCronRuns(db: Database, limit = 50): CronRun[] {
  return db
    .query<CronRun, [number]>(
      `SELECT id, job_name, started_at, elapsed_ms, status, metrics_json, error
       FROM cron_runs
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

export function getCronRunsByJob(db: Database, jobName: string, limit = 50): CronRun[] {
  return db
    .query<CronRun, [string, number]>(
      `SELECT id, job_name, started_at, elapsed_ms, status, metrics_json, error
       FROM cron_runs
       WHERE job_name = ?
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(jobName, limit);
}
