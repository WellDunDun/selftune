/**
 * Evolution rollback mechanism (TASK-15).
 *
 * Restores a skill's SKILL.md to its pre-evolution state by:
 * 1. Checking for a .bak backup file at the skill path
 * 2. Falling back to the audit trail's "created" entry for original_description
 * 3. Recording a "rolled_back" entry in the audit trail
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { EvolutionAuditEntry } from "../types.js";
import { appendAuditEntry, getLastDeployedProposal, readAuditTrail } from "./audit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  skillName: string;
  skillPath: string;
  proposalId?: string; // rollback specific proposal, or last deployed
  logPath?: string; // optional override for audit log path (testing)
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
 * Find the "created" audit entry for a given proposal ID and extract
 * the original_description from its details field.
 */
function findOriginalFromAudit(proposalId: string, logPath?: string): string | null {
  const entries = readAuditTrail(undefined, logPath);
  const createdEntry = entries.find((e) => e.proposal_id === proposalId && e.action === "created");
  if (!createdEntry) return null;

  const { details } = createdEntry;
  if (details.startsWith(ORIGINAL_DESC_PREFIX)) {
    return details.slice(ORIGINAL_DESC_PREFIX.length);
  }
  return null;
}

/**
 * Find the deployed audit entry for a specific proposal ID.
 */
function findDeployedEntry(
  proposalId: string,
  skillName: string,
  logPath?: string,
): EvolutionAuditEntry | null {
  const entries = readAuditTrail(skillName, logPath);
  return entries.find((e) => e.proposal_id === proposalId && e.action === "deployed") ?? null;
}

// ---------------------------------------------------------------------------
// Main rollback function
// ---------------------------------------------------------------------------

export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const { skillName, skillPath, proposalId, logPath } = options;

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

  if (proposalId) {
    // Verify the specific proposal exists in audit trail
    const entry = findDeployedEntry(proposalId, skillName, logPath);
    if (!entry) {
      return noRollback(`Proposal ${proposalId} not found as deployed entry in audit trail`);
    }
    targetProposalId = proposalId;
  } else {
    // Use the most recent deployed proposal
    const lastDeployed = getLastDeployedProposal(skillName, logPath);
    if (!lastDeployed) {
      return noRollback(`No deployed proposal found for skill "${skillName}"`);
    }
    targetProposalId = lastDeployed.proposal_id;
  }

  // Strategy 1: Restore from .bak file
  const backupPath = `${skillPath}.bak`;
  if (existsSync(backupPath)) {
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
    appendAuditEntry(auditEntry, logPath);

    return {
      rolledBack: true,
      restoredDescription: originalContent,
      reason: "Restored from backup file",
    };
  }

  // Strategy 2: Restore from audit trail's created entry
  const originalFromAudit = findOriginalFromAudit(targetProposalId, logPath);
  if (originalFromAudit) {
    writeFileSync(skillPath, originalFromAudit, "utf-8");

    // Record rollback in audit trail
    const auditEntry: EvolutionAuditEntry = {
      timestamp: new Date().toISOString(),
      proposal_id: targetProposalId,
      action: "rolled_back",
      details: `Rolled back ${skillName} from audit trail`,
    };
    appendAuditEntry(auditEntry, logPath);

    return {
      rolledBack: true,
      restoredDescription: originalFromAudit,
      reason: "Restored from audit trail",
    };
  }

  // No restoration source available
  return noRollback(
    `No restoration source found for proposal ${targetProposalId} (no .bak file and no original_description in audit trail)`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
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
    console.log(`selftune rollback — Rollback a skill to its pre-evolution state

Usage:
  selftune rollback --skill <name> --skill-path <path> [options]

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

  rollback({
    skillName: values.skill,
    skillPath: values["skill-path"],
    proposalId: values["proposal-id"],
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.rolledBack ? 0 : 1);
    })
    .catch((err) => {
      console.error(`[FATAL] ${err}`);
      process.exit(1);
    });
}
