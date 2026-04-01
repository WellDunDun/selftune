/**
 * Export SQLite data to JSONL format.
 * Use this only when you explicitly need portable/debuggable JSONL snapshots
 * for recovery, the contribute workflow, or external tools.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "./localdb/db.js";
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
  const db = getDb();
  const outDir = options.outputDir ?? process.cwd();
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  let totalRecords = 0;

  const tables: Record<string, { query: () => unknown[]; filename: string }> = {
    telemetry: { query: () => querySessionTelemetry(db), filename: "session_telemetry_log.jsonl" },
    skills: { query: () => querySkillUsageRecords(db), filename: "skill_usage_log.jsonl" },
    queries: { query: () => queryQueryLog(db), filename: "all_queries_log.jsonl" },
    audit: { query: () => queryEvolutionAudit(db), filename: "evolution_audit_log.jsonl" },
    evidence: { query: () => queryEvolutionEvidence(db), filename: "evolution_evidence_log.jsonl" },
    signals: { query: () => queryImprovementSignals(db), filename: "signal_log.jsonl" },
    orchestrate: {
      query: () => getOrchestrateRuns(db),
      filename: "orchestrate_run_log.jsonl",
    },
  };

  const selectedTables = options.tables ?? Object.keys(tables);

  for (const tableName of selectedTables) {
    const table = tables[tableName];
    if (!table) {
      throw new Error(
        `Unknown export table: ${tableName}. Run 'selftune export --help' for available tables: ${Object.keys(tables).join(", ")}`,
      );
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
}
