/**
 * Evolution audit trail: append, read, and query audit entries.
 */

import { EVOLUTION_AUDIT_LOG } from "../constants.js";
import type { EvolutionAuditEntry } from "../types.js";
import { getDb } from "../localdb/db.js";
import { writeEvolutionAuditToDb } from "../localdb/direct-write.js";
import { queryEvolutionAudit } from "../localdb/queries.js";
import { appendJsonl, readJsonl } from "../utils/jsonl.js";

/** Append an audit entry to the evolution audit log. */
export function appendAuditEntry(
  entry: EvolutionAuditEntry,
  logPath: string = EVOLUTION_AUDIT_LOG,
): void {
  // JSONL backup (append-only)
  appendJsonl(logPath, entry);
  // SQLite primary (fail-open)
  try {
    writeEvolutionAuditToDb(entry);
  } catch {
    /* fail-open */
  }
}

/**
 * Read all audit entries, optionally filtered by skill name.
 *
 * When logPath differs from the default, reads from JSONL for backward
 * compatibility (tests pass custom temp paths). Otherwise reads from SQLite.
 *
 * @param skillName - Optional skill name to filter by
 * @param logPath - JSONL path; when non-default, reads from JSONL instead of SQLite
 */
export function readAuditTrail(
  skillName?: string,
  logPath: string = EVOLUTION_AUDIT_LOG,
): EvolutionAuditEntry[] {
  // Non-default path → read from JSONL (test isolation / custom paths)
  if (logPath !== EVOLUTION_AUDIT_LOG) {
    const entries = readJsonl<EvolutionAuditEntry>(logPath);
    if (!skillName) return entries;
    const needle = skillName.toLowerCase();
    return entries.filter((e) =>
      (e.skill_name ?? "").toLowerCase() === needle ||
      (e.details ?? "").toLowerCase().includes(needle),
    );
  }

  // Default path → read from SQLite (production)
  const db = getDb();
  const entries = queryEvolutionAudit(db, skillName) as EvolutionAuditEntry[];
  if (!skillName) return entries;
  // queryEvolutionAudit filters by skill_name field; also filter by details
  // for backward compatibility (some entries may have skill name in details only)
  const needle = skillName.toLowerCase();
  return entries.length > 0
    ? entries
    : (queryEvolutionAudit(db) as EvolutionAuditEntry[]).filter(
        (e) => (e.details ?? "").toLowerCase().includes(needle),
      );
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
