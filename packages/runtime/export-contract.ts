export type ExportTableName =
  | "telemetry"
  | "skills"
  | "queries"
  | "audit"
  | "evidence"
  | "signals"
  | "orchestrate";

export interface ExportInput {
  readonly outputDir?: string;
  readonly since?: string;
  readonly tables: ReadonlyArray<ExportTableName>;
}

export const EXPORT_TABLE_NAMES: ReadonlyArray<ExportTableName> = [
  "telemetry",
  "skills",
  "queries",
  "audit",
  "evidence",
  "signals",
  "orchestrate",
];
