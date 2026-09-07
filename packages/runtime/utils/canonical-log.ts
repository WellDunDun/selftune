import { decodeCanonicalLogLine } from "./log-contracts.js";
import { existsSync } from "node:fs";

import {
  type CanonicalPlatform,
  type CanonicalRecordEvidence,
  type CanonicalRecordKind,
} from "@selftune/telemetry-contract";

import { CANONICAL_LOG } from "../constants.js";
import { readJsonl } from "./jsonl.js";

export interface CanonicalRecordFilter {
  platform?: CanonicalPlatform;
  record_kind?: CanonicalRecordKind;
}

export function readCanonicalRecords(logPath: string = CANONICAL_LOG): CanonicalRecordEvidence[] {
  if (!existsSync(logPath)) return [];
  return readJsonl(logPath, decodeCanonicalLogLine);
}

export function filterCanonicalRecords(
  records: CanonicalRecordEvidence[],
  filter: CanonicalRecordFilter,
): CanonicalRecordEvidence[] {
  return records.filter((record) => {
    if (filter.platform && record.platform !== filter.platform) return false;
    if (filter.record_kind && record.record_kind !== filter.record_kind) return false;
    return true;
  });
}

export function serializeCanonicalRecords(
  records: CanonicalRecordEvidence[],
  pretty = false,
): string {
  if (pretty) return `${JSON.stringify(records, null, 2)}\n`;
  return (
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "")
  );
}
