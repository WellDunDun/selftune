/**
 * SQLite storage layer for the selftune badge service.
 *
 * Uses bun:sqlite for zero-dependency SQLite access.
 * All operations are append-only per the Golden Principle.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AggregatedSkillData,
  ServiceAuditEntry,
  SkillAggregationRecord,
  SubmissionRecord,
} from "../types.js";
import { runMigrations } from "./migrations.js";

export class Store {
  private db: Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    runMigrations(this.db);
  }

  // ---------------------------------------------------------------------------
  // Submissions
  // ---------------------------------------------------------------------------

  insertSubmission(
    skillName: string,
    contributorId: string,
    bundleJson: string,
    ipHash: string,
    schemaVersion: string = "1.1",
  ): number {
    const stmt = this.db.prepare(
      "INSERT INTO submissions (skill_name, contributor_id, bundle_json, ip_hash, schema_version) VALUES (?, ?, ?, ?, ?)",
    );
    const result = stmt.run(skillName, contributorId, bundleJson, ipHash, schemaVersion);
    return Number(result.lastInsertRowid);
  }

  getSubmissionsBySkill(skillName: string): SubmissionRecord[] {
    return this.db
      .query(
        "SELECT id, skill_name, contributor_id, bundle_json, ip_hash, accepted_at FROM submissions WHERE skill_name = ? ORDER BY accepted_at ASC",
      )
      .all(skillName) as SubmissionRecord[];
  }

  countRecentSubmissions(ipHash: string, windowHours: number = 1): number {
    const result = this.db
      .query(
        "SELECT COUNT(*) as count FROM submissions WHERE ip_hash = ? AND accepted_at > datetime('now', ?)",
      )
      .get(ipHash, `-${windowHours} hours`) as { count: number };
    return result.count;
  }

  getAllSkillNames(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT skill_name FROM submissions ORDER BY skill_name")
      .all() as Array<{ skill_name: string }>;
    return rows.map((r) => r.skill_name);
  }

  // ---------------------------------------------------------------------------
  // Aggregations
  // ---------------------------------------------------------------------------

  upsertAggregation(data: AggregatedSkillData): void {
    this.db
      .prepare(
        `INSERT INTO skill_aggregations (skill_name, weighted_pass_rate, trend, status, contributor_count, session_count, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_name) DO UPDATE SET
         weighted_pass_rate = excluded.weighted_pass_rate,
         trend = excluded.trend,
         status = excluded.status,
         contributor_count = excluded.contributor_count,
         session_count = excluded.session_count,
         last_updated = excluded.last_updated`,
      )
      .run(
        data.skill_name,
        data.weighted_pass_rate,
        data.trend,
        data.status,
        data.contributor_count,
        data.session_count,
        data.last_updated,
      );
  }

  getAggregation(skillName: string): AggregatedSkillData | null {
    const row = this.db
      .query("SELECT * FROM skill_aggregations WHERE skill_name = ?")
      .get(skillName) as SkillAggregationRecord | null;

    if (!row) return null;

    return {
      skill_name: row.skill_name,
      weighted_pass_rate: row.weighted_pass_rate,
      trend: row.trend as AggregatedSkillData["trend"],
      status: row.status as AggregatedSkillData["status"],
      contributor_count: row.contributor_count,
      session_count: row.session_count,
      last_updated: row.last_updated,
    };
  }

  // ---------------------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------------------

  logAudit(action: string, details: string): void {
    this.db.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)").run(action, details);
  }

  getAuditLog(limit: number = 100): ServiceAuditEntry[] {
    return this.db
      .query("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as ServiceAuditEntry[];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
