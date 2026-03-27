/**
 * Evolution rollback mechanism (TASK-15).
 *
 * Restores a skill's SKILL.md to its pre-evolution state by:
 * 1. Checking for a .bak backup file at the skill path
 * 2. Falling back to the audit trail's "created" entry for original_description
 * 3. Recording a "rolled_back" entry in the audit trail
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { updateContextAfterRollback } from "../memory/writer.js";
import type { EvolutionAuditEntry } from "../types.js";
import { replaceDescription } from "../utils/frontmatter.js";
import { appendAuditEntry, getLastDeployedProposal, readAuditTrail } from "./audit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  skillName: string;
  skillPath: string;
  proposalId?: string; // rollback specific proposal, or last deployed
  logPath?: string; // deprecated — ignored, kept for backward compat
}

export interface RollbackResult {
  rolledBack: boolean;
  restoredDescription: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_DESC_PREFIX = "original_description:";

/**
 * Find the most recent .bak file for the given skillPath.
 * Matches both legacy `SKILL.md.bak` and timestamped `SKILL.md.<timestamp>.bak`.
 * Returns the path to the most recent backup, or null if none found.
 */
function findLatestBackup(skillPath: string): string | null {
  const dir = dirname(skillPath);
  const base = basename(skillPath);

  if (!existsSync(dir)) return null;

  const entries = readdirSync(dir);
  // Match <base>.bak or <base>.<anything>.bak
  const plainBak = `${base}.bak`;
  const backupFiles = entries
    .filter((f) => f === plainBak || (f.startsWith(`${base}.`) && f.endsWith(".bak")))
    .sort((a, b) => {
      // Extract timestamp: plain "<base>.bak" gets "" (oldest), "<base>.<ts>.bak" gets "<ts>"
      const tsA = a === plainBak ? "" : a.slice(base.length + 1, -4);
      const tsB = b === plainBak ? "" : b.slice(base.length + 1, -4);
      // Descending so newest timestamp first
      return tsB.localeCompare(tsA);
    });

  if (backupFiles.length === 0) return null;
  return join(dir, backupFiles[0]);
}

/**
 * Find the "created" audit entry for a given proposal ID and extract
 * the original_description from its details field.
 */
function findOriginalFromAudit(proposalId: string): string | null {
  const entries = readAuditTrail();
  const createdEntry = entries.find((e) => e.proposal_id === proposalId && e.action === "created");
  if (!createdEntry) return null;

  const { details } = createdEntry;
  if (details.startsWith(ORIGINAL_DESC_PREFIX)) {
    return details.slice(ORIGINAL_DESC_PREFIX.length);
  }
  // Accept a plain non-empty string as the original description
  if (details.length > 0) {
    return details;
  }
  return null;
}

/**
 * Find the deployed audit entry for a specific proposal ID.
 */
function findDeployedEntry(proposalId: string, skillName: string): EvolutionAuditEntry | null {
  const entries = readAuditTrail(skillName);
  return entries.find((e) => e.proposal_id === proposalId && e.action === "deployed") ?? null;
}

// ---------------------------------------------------------------------------
// Main rollback function
// ---------------------------------------------------------------------------

export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const { skillName, skillPath, proposalId } = options;

  const noRollback = (reason: string): RollbackResult => ({
    rolledBack: false,
    restoredDescription: "",
    reason,
  });

  // Guard: SKILL.md must exist
  if (!existsSync(skillPath)) {
    return noRollback(`SKILL.md not found at ${skillPath}`);
  }

  // Determine which proposal to roll back
  let targetProposalId: string;
  const explicitProposal = Boolean(proposalId);

  if (proposalId) {
    // Verify the specific proposal exists in audit trail
    const entry = findDeployedEntry(proposalId, skillName);
    if (!entry) {
      return noRollback(`Proposal ${proposalId} not found as deployed entry in audit trail`);
    }
    targetProposalId = proposalId;
  } else {
    // Use the most recent deployed proposal
    const lastDeployed = getLastDeployedProposal(skillName);
    if (!lastDeployed) {
      return noRollback(`No deployed proposal found for skill "${skillName}"`);
    }
    targetProposalId = lastDeployed.proposal_id;
  }

  // Strategy 1: Restore from .bak file (only when rolling back the latest deploy,
  // i.e., when no explicit proposalId was supplied)
  const backupPath = !explicitProposal ? findLatestBackup(skillPath) : null;
  if (backupPath) {
    const originalContent = readFileSync(backupPath, "utf-8");
    writeFileSync(skillPath, originalContent, "utf-8");
    unlinkSync(backupPath);

    // Record rollback in audit trail
    const auditEntry: EvolutionAuditEntry = {
      timestamp: new Date().toISOString(),
      proposal_id: targetProposalId,
      action: "rolled_back",
      details: `Rolled back ${skillName} from backup file`,
    };
    appendAuditEntry(auditEntry);

    const backupResult: RollbackResult = {
      rolledBack: true,
      restoredDescription: originalContent,
      reason: "Restored from backup file",
    };

    try {
      updateContextAfterRollback(skillName, backupResult);
    } catch {
      // Memory writes should never fail the main operation
    }

    return backupResult;
  }

  // Strategy 2: Restore from audit trail's created entry (description only)
  const originalFromAudit = findOriginalFromAudit(targetProposalId);
  if (originalFromAudit) {
    // Replace only the description section in SKILL.md, preserving structure
    const currentContent = readFileSync(skillPath, "utf-8");
    const updatedContent = replaceDescription(currentContent, originalFromAudit);
    writeFileSync(skillPath, updatedContent, "utf-8");

    // Record rollback in audit trail
    const auditEntry: EvolutionAuditEntry = {
      timestamp: new Date().toISOString(),
      proposal_id: targetProposalId,
      action: "rolled_back",
      details: `Rolled back ${skillName} from audit trail`,
    };
    appendAuditEntry(auditEntry);

    const auditResult: RollbackResult = {
      rolledBack: true,
      restoredDescription: originalFromAudit,
      reason: "Restored from audit trail",
    };

    try {
      updateContextAfterRollback(skillName, auditResult);
    } catch {
      // Memory writes should never fail the main operation
    }

    return auditResult;
  }

  // No restoration source available
  return noRollback(
    `No restoration source found for proposal ${targetProposalId} (no .bak file and no original_description in audit trail)`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      "proposal-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune evolve rollback — Rollback a skill to its pre-evolution state

Usage:
  selftune evolve rollback --skill <name> --skill-path <path> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (required)
  --proposal-id       Specific proposal ID to rollback (optional, uses latest if omitted)
  --help              Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    console.error("[ERROR] --skill and --skill-path are required");
    process.exit(1);
  }

  const result = await rollback({
    skillName: values.skill,
    skillPath: values["skill-path"],
    proposalId: values["proposal-id"],
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.rolledBack ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
