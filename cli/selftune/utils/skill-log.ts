import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REPAIRED_SKILL_LOG, REPAIRED_SKILL_SESSIONS_MARKER, SKILL_LOG } from "../constants.js";
import type { SkillUsageRecord } from "../types.js";
import { loadMarker, readJsonl, saveMarker } from "./jsonl.js";
import { filterActionableSkillUsageRecords } from "./query-filter.js";

function dedupeSkillUsageRecords(records: SkillUsageRecord[]): SkillUsageRecord[] {
  const deduped = new Map<string, SkillUsageRecord>();

  for (const record of records) {
    const key = [
      record.session_id,
      record.skill_name,
      record.query.trim(),
      record.timestamp,
      record.triggered ? "1" : "0",
    ].join("\u0000");
    if (!deduped.has(key)) {
      deduped.set(key, record);
    }
  }

  return [...deduped.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function readEffectiveSkillUsageRecords(
  rawSkillLogPath: string = SKILL_LOG,
  repairedSkillLogPath: string = REPAIRED_SKILL_LOG,
  repairedSessionsPath: string = REPAIRED_SKILL_SESSIONS_MARKER,
): SkillUsageRecord[] {
  const repairedRecords = filterActionableSkillUsageRecords(
    readJsonl<SkillUsageRecord>(repairedSkillLogPath),
  );
  if (!existsSync(repairedSkillLogPath)) {
    return dedupeSkillUsageRecords(
      filterActionableSkillUsageRecords(readJsonl<SkillUsageRecord>(rawSkillLogPath)),
    );
  }

  const repairedSessionIds = loadMarker(repairedSessionsPath);
  const rawRecords = filterActionableSkillUsageRecords(
    readJsonl<SkillUsageRecord>(rawSkillLogPath),
  );

  if (repairedSessionIds.size === 0) {
    return dedupeSkillUsageRecords([...repairedRecords, ...rawRecords]);
  }

  // Build a set of dedup keys from the repaired log so we only exclude
  // raw records that have a repaired counterpart — not all records from
  // repaired sessions (which would drop entries written after repair).
  const repairedKeys = new Set<string>();
  for (const r of repairedRecords) {
    repairedKeys.add(
      [r.session_id, r.skill_name, r.query.trim(), r.timestamp, r.triggered ? "1" : "0"].join(
        "\u0000",
      ),
    );
  }

  const unrepairedRawRecords = rawRecords.filter((record) => {
    // Keep records from sessions that were never repaired
    if (!repairedSessionIds.has(record.session_id)) return true;
    // For repaired sessions, only exclude if an exact duplicate exists in the repaired log
    const key = [
      record.session_id,
      record.skill_name,
      record.query.trim(),
      record.timestamp,
      record.triggered ? "1" : "0",
    ].join("\u0000");
    return !repairedKeys.has(key);
  });

  return dedupeSkillUsageRecords([...repairedRecords, ...unrepairedRawRecords]);
}

export function writeRepairedSkillUsageRecords(
  records: SkillUsageRecord[],
  repairedSessionIds: Set<string>,
  repairedSkillLogPath: string = REPAIRED_SKILL_LOG,
  repairedSessionsPath: string = REPAIRED_SKILL_SESSIONS_MARKER,
): void {
  const dir = dirname(repairedSkillLogPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const normalized = dedupeSkillUsageRecords(filterActionableSkillUsageRecords(records));
  const content = normalized.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(repairedSkillLogPath, content ? `${content}\n` : "", "utf-8");
  saveMarker(repairedSessionsPath, repairedSessionIds);
}
