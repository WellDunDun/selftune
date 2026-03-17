/**
 * Export SQLite data to JSONL format.
 * Replaces the removed JSONL write path -- use this when you need
 * JSONL files for debugging, the contribute workflow, or external tools.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./localdb/db.js";
import {
  getOrchestrateRuns,
  queryEvolutionAudit,
  queryEvolutionEvidence,
  queryImprovementSignals,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "./localdb/queries.js";

export interface ExportOptions {
  outputDir?: string;
  since?: string;
  tables?: string[];
}

export function exportToJsonl(options: ExportOptions = {}): { files: string[]; records: number } {
  const db = openDb();
  try {
    const outDir = options.outputDir ?? process.cwd();
    const files: string[] = [];
    let totalRecords = 0;

    const tables: Record<string, { query: () => unknown[]; filename: string }> = {
      telemetry: { query: () => querySessionTelemetry(db), filename: "session_telemetry_log.jsonl" },
      skills: { query: () => querySkillUsageRecords(db), filename: "skill_usage_log.jsonl" },
      queries: { query: () => queryQueryLog(db), filename: "all_queries_log.jsonl" },
      audit: { query: () => queryEvolutionAudit(db), filename: "evolution_audit_log.jsonl" },
      evidence: { query: () => queryEvolutionEvidence(db), filename: "evolution_evidence_log.jsonl" },
      signals: { query: () => queryImprovementSignals(db), filename: "signal_log.jsonl" },
      orchestrate: { query: () => getOrchestrateRuns(db, 10000), filename: "orchestrate_run_log.jsonl" },
    };

    const selectedTables = options.tables ?? Object.keys(tables);

    for (const tableName of selectedTables) {
      const table = tables[tableName];
      if (!table) {
        console.warn(`Unknown table: ${tableName} (available: ${Object.keys(tables).join(", ")})`);
        continue;
      }

      let records = table.query();

      // Filter by timestamp if --since provided
      if (options.since) {
        const sinceDate = new Date(options.since);
        if (Number.isNaN(sinceDate.getTime())) {
          console.warn(`Invalid --since date: ${options.since}, skipping filter`);
        } else {
          const sinceMs = sinceDate.getTime();
          const sinceIso = sinceDate.toISOString();
          records = records.filter((r) => {
            const rec = r as Record<string, unknown>;
            // Try common timestamp fields
            const ts = rec.timestamp ?? rec.ts ?? rec.created_at ?? rec.started_at;
            if (typeof ts === "number") return ts >= sinceMs;
            if (typeof ts === "string") return ts >= sinceIso;
            return true; // Keep records without a timestamp field
          });
        }
      }

      const filePath = join(outDir, table.filename);
      const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
      writeFileSync(filePath, content, "utf-8");
      files.push(filePath);
      totalRecords += records.length;
    }

    return { files, records: totalRecords };
  } finally {
    db.close();
  }
}
