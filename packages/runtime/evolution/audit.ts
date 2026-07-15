/**
 * Evolution audit trail: append, read, and query audit entries.
 *
 * Uses SQLite as the primary store via getDb(). Tests inject an in-memory
 * database via _setTestDb() for isolation.
 */

import { getDb } from "../localdb/db.js";
import { writeEvolutionAuditToDb } from "../localdb/direct-write.js";
import { queryEvolutionAudit } from "../localdb/queries.js";
import type { EvolutionAuditEntry } from "../types.js";

/** Append an audit entry to the evolution audit log (SQLite). */
export function appendAuditEntry(entry: EvolutionAuditEntry, _logPath?: string): void {
  writeEvolutionAuditToDb(entry);
}

/**
 * Read all audit entries, optionally filtered by skill name.
 *
 * @param skillName - Optional skill name to filter by
 */
export function readAuditTrail(skillName?: string, _logPath?: string): EvolutionAuditEntry[] {
  const db = getDb();
  const entries = queryEvolutionAudit(db, skillName) as EvolutionAuditEntry[];
  if (!skillName) return entries;
  // queryEvolutionAudit filters by skill_name field; also filter by details
  // for backward compatibility (some entries may have skill name in details only)
  const needle = skillName.toLowerCase();
  return entries.length > 0
    ? entries
    : (queryEvolutionAudit(db) as EvolutionAuditEntry[]).filter((e) =>
        (e.details ?? "").toLowerCase().includes(needle),
      );
}

/**
 * Get the most recent "deployed" audit entry for a skill.
 * Returns null if no deployed entries exist for the given skill.
 */
export function getLastDeployedProposal(
  skillName: string,
  _logPath?: string,
): EvolutionAuditEntry | null {
  const entries = readAuditTrail(skillName);
  const deployed = entries.filter((e) => e.action === "deployed");
  // Results are DESC-ordered from SQLite, so first match is most recent
  return deployed.length > 0 ? deployed[0] : null;
}
