/**
 * Export SQLite data to JSONL format.
 * Use this only when you explicitly need portable/debuggable JSONL snapshots
 * for recovery, the contribute workflow, or external tools.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXPORT_TABLE_NAMES, type ExportInput, type ExportTableName } from "./export-contract.js";
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
  readonly outputDir?: string;
  readonly since?: string;
  readonly tables?: ReadonlyArray<string>;
}

export interface ExportResult {
  readonly files: ReadonlyArray<string>;
  readonly records: number;
}

export interface ExportDependencies {
  readonly exportData: (options: ExportOptions) => ExportResult;
  readonly getCurrentDirectory: () => string;
  readonly print: (message: string) => void;
}

const EXPORT_TABLE_NAME_SET: ReadonlySet<string> = new Set(EXPORT_TABLE_NAMES);

export type { ExportInput, ExportTableName };
export { EXPORT_TABLE_NAMES };

export function exportToJsonl(options: ExportOptions = {}): ExportResult {
  const outDir = options.outputDir ?? process.cwd();
  const selectedTables = options.tables ?? EXPORT_TABLE_NAMES;

  for (const tableName of selectedTables) {
    if (!EXPORT_TABLE_NAME_SET.has(tableName)) {
      throw new Error(
        `Unknown export table: ${tableName}. Run 'selftune export --help' for available tables: ${EXPORT_TABLE_NAMES.join(", ")}`,
      );
    }
  }

  const db = getDb();
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

  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  let totalRecords = 0;

  for (const tableName of selectedTables) {
    const table = tables[tableName];
    if (!table) {
      throw new Error(`Export table configuration missing: ${tableName}`);
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

const LIVE_EXPORT_DEPENDENCIES: ExportDependencies = {
  exportData: exportToJsonl,
  getCurrentDirectory: () => process.cwd(),
  print: (message) => console.log(message),
};

export function runExportProgram(
  input: ExportInput,
  dependencies: ExportDependencies = LIVE_EXPORT_DEPENDENCIES,
): ExportResult {
  const outputDir = input.outputDir ?? dependencies.getCurrentDirectory();
  const result = dependencies.exportData({
    outputDir,
    since: input.since,
    tables: input.tables.length > 0 ? input.tables : undefined,
  });

  dependencies.print(
    `Exported ${result.records} records to ${result.files.length} files in ${outputDir}`,
  );
  for (const file of result.files) {
    dependencies.print(`  ${file}`);
  }
  return result;
}
