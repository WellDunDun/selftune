import { existsSync, writeFileSync } from "node:fs";
import {
  type CanonicalPlatform,
  type CanonicalRecord,
  type CanonicalRecordKind,
  isCanonicalRecord,
} from "../../../packages/telemetry-contract/index.js";
import { CANONICAL_LOG } from "../constants.js";
import { readJsonl } from "./jsonl.js";

export interface CanonicalRecordFilter {
  platform?: CanonicalPlatform;
  record_kind?: CanonicalRecordKind;
}

export function readCanonicalRecords(logPath: string = CANONICAL_LOG): CanonicalRecord[] {
  if (!existsSync(logPath)) return [];
  return readJsonl<CanonicalRecord>(logPath).filter(isCanonicalRecord);
}

export function filterCanonicalRecords(
  records: CanonicalRecord[],
  filter: CanonicalRecordFilter,
): CanonicalRecord[] {
  return records.filter((record) => {
    if (filter.platform && record.platform !== filter.platform) return false;
    if (filter.record_kind && record.record_kind !== filter.record_kind) return false;
    return true;
  });
}

export function serializeCanonicalRecords(records: CanonicalRecord[], pretty = false): string {
  if (pretty) return `${JSON.stringify(records, null, 2)}\n`;
  return (
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "")
  );
}

export function writeCanonicalExport(
  records: CanonicalRecord[],
  outPath: string,
  pretty = false,
): void {
  writeFileSync(outPath, serializeCanonicalRecords(records, pretty), "utf-8");
}
