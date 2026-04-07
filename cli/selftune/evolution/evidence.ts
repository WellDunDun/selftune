/**
 * Evolution evidence trail: append and read proposal/eval artifacts that power
 * explainable dashboard drill-downs.
 *
 * Uses SQLite as the primary store via getDb(). Tests inject an in-memory
 * database via _setTestDb() for isolation.
 */

import { getDb } from "../localdb/db.js";
import { writeEvolutionEvidenceToDb } from "../localdb/direct-write.js";
import { queryEvolutionEvidence } from "../localdb/queries.js";
import type { EvolutionEvidenceEntry } from "../types.js";

/** Append a structured evidence artifact to the evolution evidence log (SQLite). */
export function appendEvidenceEntry(entry: EvolutionEvidenceEntry): void {
  writeEvolutionEvidenceToDb(entry);
}

/**
 * Read all evidence entries, optionally filtered by exact skill name.
 *
 * @param skillName - Optional skill name to filter by
 */
export function readEvidenceTrail(skillName?: string): EvolutionEvidenceEntry[] {
  const db = getDb();
  return queryEvolutionEvidence(db, skillName) as EvolutionEvidenceEntry[];
}

/** Build the stable evidence key used to connect audit entries to validation artifacts. */
export function buildValidationEvidenceRef(proposalId: string, stage: string): string {
  return `evolution_evidence:${proposalId}:${stage}`;
}
