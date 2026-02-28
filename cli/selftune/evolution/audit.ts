/**
 * Evolution audit trail: append, read, and query audit entries.
 */

import { EVOLUTION_AUDIT_LOG } from "../constants.js";
import type { EvolutionAuditEntry } from "../types.js";
import { appendJsonl, readJsonl } from "../utils/jsonl.js";

/** Append an audit entry to the evolution audit log. */
export function appendAuditEntry(
  entry: EvolutionAuditEntry,
  logPath: string = EVOLUTION_AUDIT_LOG,
): void {
  appendJsonl(logPath, entry);
}

/**
 * Read all audit entries, optionally filtered by skill name.
 *
 * When skillName is provided, returns only entries whose `details` field
 * contains the skill name (case-insensitive match).
 */
export function readAuditTrail(
  skillName?: string,
  logPath: string = EVOLUTION_AUDIT_LOG,
): EvolutionAuditEntry[] {
  const entries = readJsonl<EvolutionAuditEntry>(logPath);
  if (!skillName) return entries;
  const needle = skillName.toLowerCase();
  return entries.filter((e) => e.details.toLowerCase().includes(needle));
}

/**
 * Get the most recent "deployed" audit entry for a skill.
 * Returns null if no deployed entries exist for the given skill.
 */
export function getLastDeployedProposal(
  skillName: string,
  logPath: string = EVOLUTION_AUDIT_LOG,
): EvolutionAuditEntry | null {
  const entries = readAuditTrail(skillName, logPath);
  const deployed = entries.filter((e) => e.action === "deployed");
  return deployed.length > 0 ? deployed[deployed.length - 1] : null;
}
