/**
 * Evolution evidence trail: append and read proposal/eval artifacts that power
 * explainable dashboard drill-downs.
 */

import { EVOLUTION_EVIDENCE_LOG } from "../constants.js";
import type { EvolutionEvidenceEntry } from "../types.js";
import { openDb } from "../localdb/db.js";
import { writeEvolutionEvidenceToDb } from "../localdb/direct-write.js";
import { queryEvolutionEvidence } from "../localdb/queries.js";
import { appendJsonl, readJsonl } from "../utils/jsonl.js";

/** Append a structured evidence artifact to the evolution evidence log. */
export function appendEvidenceEntry(
  entry: EvolutionEvidenceEntry,
  logPath?: string,
): void {
  // JSONL backup when a custom path is provided (test isolation)
  if (logPath && logPath !== EVOLUTION_EVIDENCE_LOG) {
    appendJsonl(logPath, entry);
  }
  // SQLite primary
  writeEvolutionEvidenceToDb(entry);
}

/**
 * Read all evidence entries, optionally filtered by exact skill name.
 *
 * When logPath differs from the default, reads from JSONL for backward
 * compatibility (tests pass custom temp paths). Otherwise reads from SQLite.
 *
 * @param skillName - Optional skill name to filter by
 * @param logPath - JSONL path; when non-default, reads from JSONL instead of SQLite
 */
export function readEvidenceTrail(
  skillName?: string,
  logPath?: string,
): EvolutionEvidenceEntry[] {
  // Non-default path → read from JSONL (test isolation / custom paths)
  if (logPath && logPath !== EVOLUTION_EVIDENCE_LOG) {
    const entries = readJsonl<EvolutionEvidenceEntry>(logPath);
    if (!skillName) return entries;
    return entries.filter((e) => e.skill_name === skillName);
  }

  // Default path → read from SQLite (production)
  const db = openDb();
  try {
    return queryEvolutionEvidence(db, skillName) as EvolutionEvidenceEntry[];
  } finally {
    db.close();
  }
}
