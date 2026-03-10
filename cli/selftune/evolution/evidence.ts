/**
 * Evolution evidence trail: append and read proposal/eval artifacts that power
 * explainable dashboard drill-downs.
 */

import { EVOLUTION_EVIDENCE_LOG } from "../constants.js";
import type { EvolutionEvidenceEntry } from "../types.js";
import { appendJsonl, readJsonl } from "../utils/jsonl.js";

/** Append a structured evidence artifact to the evolution evidence log. */
export function appendEvidenceEntry(
  entry: EvolutionEvidenceEntry,
  logPath: string = EVOLUTION_EVIDENCE_LOG,
): void {
  appendJsonl(logPath, entry);
}

/** Read all evidence entries, optionally filtered by exact skill name. */
export function readEvidenceTrail(
  skillName?: string,
  logPath: string = EVOLUTION_EVIDENCE_LOG,
): EvolutionEvidenceEntry[] {
  const entries = readJsonl<EvolutionEvidenceEntry>(logPath);
  if (!skillName) return entries;
  return entries.filter((entry) => entry.skill_name === skillName);
}
