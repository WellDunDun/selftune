import type { Database } from "bun:sqlite";
import { getDb } from "@selftune/local-store";
import type { DashboardReportName } from "./report-contract.js";

interface ReportDependency {
  readonly table: string;
  /** An indexed append/update timestamp, when the report needs one. */
  readonly cursorColumn?: string;
}

const REPORT_DEPENDENCIES: Record<DashboardReportName, readonly ReportDependency[]> = {
  "portfolio-audit": [
    { table: "session_telemetry", cursorColumn: "timestamp" },
    { table: "skill_invocations", cursorColumn: "occurred_at" },
    { table: "prompts", cursorColumn: "occurred_at" },
    { table: "queries", cursorColumn: "timestamp" },
    { table: "skill_usage", cursorColumn: "timestamp" },
  ],
  "skill-intelligence": [
    { table: "sessions" },
    { table: "prompts", cursorColumn: "occurred_at" },
    { table: "skill_invocations", cursorColumn: "occurred_at" },
    { table: "session_telemetry", cursorColumn: "timestamp" },
    { table: "queries", cursorColumn: "timestamp" },
    { table: "skill_usage", cursorColumn: "timestamp" },
    { table: "skill_classification_overrides", cursorColumn: "updated_at" },
    { table: "skill_set_suggestion_reviews", cursorColumn: "reviewed_at" },
    { table: "skill_set_outcomes", cursorColumn: "measured_at" },
    // DuckDB facts are rebuildable, but this SQLite checkpoint records the
    // accepted source revision that changes their dashboard projection.
    { table: "analytical_import_checkpoints", cursorColumn: "imported_at" },
  ],
  insights: [
    { table: "session_telemetry", cursorColumn: "timestamp" },
    { table: "skill_invocations", cursorColumn: "occurred_at" },
    { table: "prompts", cursorColumn: "occurred_at" },
    { table: "queries", cursorColumn: "timestamp" },
    { table: "skill_usage", cursorColumn: "timestamp" },
  ],
  library: [
    { table: "skill_install_receipts" },
    { table: "skill_install_receipt_files" },
    { table: "skill_install_operations" },
  ],
};

function dependencyCursor(db: Database, dependency: ReportDependency): string {
  const rowid = db
    .query<{ max_rowid: number }, []>(
      `SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM ${dependency.table}`,
    )
    .get();
  if (!dependency.cursorColumn) return `${dependency.table}:${rowid?.max_rowid ?? 0}`;
  const timestamp = db
    .query<{ max_cursor: string }, []>(
      `SELECT COALESCE(MAX(${dependency.cursorColumn}), '') AS max_cursor FROM ${dependency.table}`,
    )
    .get();
  return `${dependency.table}:${rowid?.max_rowid ?? 0}:${timestamp?.max_cursor ?? ""}`;
}

export function dashboardReportDependencyVersion(
  report: DashboardReportName,
  database?: Database,
): string {
  const dependencies = REPORT_DEPENDENCIES[report];
  try {
    const db = database ?? getDb();
    return dependencies.map((dependency) => dependencyCursor(db, dependency)).join("|");
  } catch {
    // The cache TTL remains a safe fallback while a host is still bringing up SQLite.
    return `unavailable:${report}`;
  }
}
