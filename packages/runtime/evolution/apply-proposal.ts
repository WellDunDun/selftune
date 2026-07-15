/**
 * apply-proposal.ts
 *
 * Fetches an approved contributor proposal from the cloud API, applies the
 * proposed update to the local SKILL.md, and marks the proposal as applied.
 *
 * Usage:
 *   selftune evolve apply-proposal --id <proposal-id> --skill-path <path>
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { readAlphaIdentity } from "../alpha-identity.js";
import { SELFTUNE_CONFIG_PATH } from "../constants.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { replaceDescription } from "../utils/frontmatter.js";
import { getSelftuneVersion } from "../utils/selftune-meta.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProposalRecord {
  id: string;
  skill_id: string;
  skill_name: string;
  proposal_type: string;
  current_value: string;
  proposed_value: string;
  reason: string | null;
  pass_rate_before: number | null;
  projected_pass_rate: number | null;
  status: "pending" | "approved" | "rejected" | "applied";
  proposed_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  applied_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Cloud API helpers (follows registry/client.ts pattern)
// ---------------------------------------------------------------------------

function getCloudConfig(): { apiUrl: string; apiKey: string } | null {
  try {
    const identity = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
    if (!identity?.api_key) return null;
    const apiUrl = identity.cloud_api_url || "https://api.selftune.dev";
    return { apiUrl, apiKey: identity.api_key };
  } catch {
    return null;
  }
}

async function fetchProposal(
  proposalId: string,
  config: { apiUrl: string; apiKey: string },
): Promise<ProposalRecord> {
  const url = `${config.apiUrl}/api/v1/proposals/${encodeURIComponent(proposalId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": `selftune/${getSelftuneVersion()}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    if (response.status === 404) {
      throw new CLIError(
        `Proposal ${proposalId} not found.`,
        "NOT_FOUND",
        "Check the proposal ID and try again.",
      );
    }
    throw new CLIError(
      `Failed to fetch proposal: HTTP ${response.status}: ${text.slice(0, 200)}`,
      "API_ERROR",
      "Check your credentials and network connection.",
    );
  }

  const body = (await response.json()) as { proposal: ProposalRecord };
  return body.proposal;
}

async function markProposalApplied(
  proposalId: string,
  config: { apiUrl: string; apiKey: string },
): Promise<boolean> {
  const url = `${config.apiUrl}/api/v1/proposals/${encodeURIComponent(proposalId)}`;

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "User-Agent": `selftune/${getSelftuneVersion()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "applied" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      console.error(
        `Warning: Failed to mark proposal as applied: HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
      return false;
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: Failed to mark proposal as applied: ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Apply logic
// ---------------------------------------------------------------------------

function applyProposalToSkill(skillPath: string, proposal: ProposalRecord): { backupPath: string } {
  if (!existsSync(skillPath)) {
    throw new CLIError(
      `Skill file not found: ${skillPath}`,
      "FILE_NOT_FOUND",
      "Verify the --skill-path argument points to your SKILL.md.",
    );
  }

  const content = readFileSync(skillPath, "utf-8");

  // Back up before modifying
  const backupPath = `${skillPath}.bak`;
  copyFileSync(skillPath, backupPath);

  let updated: string;
  if (proposal.proposal_type === "description") {
    updated = replaceDescription(content, proposal.proposed_value);
  } else if (proposal.proposal_type === "body") {
    const lines = content.split("\n");
    let endIdx = -1;
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx >= 0) {
      updated = lines.slice(0, endIdx + 1).join("\n") + "\n\n" + proposal.proposed_value;
    } else {
      // No frontmatter -- replace entire content
      updated = proposal.proposed_value;
    }
  } else {
    throw new CLIError(
      `Unsupported proposal type: ${proposal.proposal_type}`,
      "UNSUPPORTED_TYPE",
      "Only 'description' and 'body' proposal types can be applied.",
    );
  }

  writeFileSync(skillPath, updated, "utf-8");
  return { backupPath };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      id: { type: "string" },
      "skill-path": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune evolve apply-proposal -- Apply an approved contributor proposal

Usage:
  selftune evolve apply-proposal --id <proposal-id> --skill-path <path> [options]

Options:
  --id            Proposal UUID (required)
  --skill-path    Path to the target SKILL.md (required)
  --dry-run       Preview the proposal without applying
  --help          Show this help message

The proposal must be proposed by "contributor_aggregate" and have status
"approved". The command fetches the proposal from the cloud API, applies
the proposed change to the local SKILL.md, and marks the proposal as applied.`);
    process.exit(0);
  }

  if (!values.id) {
    throw new CLIError(
      "--id is required",
      "MISSING_FLAG",
      "selftune evolve apply-proposal --id <proposal-id> --skill-path <path>",
    );
  }
  if (!values["skill-path"]) {
    throw new CLIError(
      "--skill-path is required",
      "MISSING_FLAG",
      "selftune evolve apply-proposal --id <proposal-id> --skill-path <path>",
    );
  }

  const proposalId = values.id;
  const skillPath = values["skill-path"];
  const dryRun = values["dry-run"] ?? false;

  try {
    // Resolve cloud config once for both fetch and mark calls
    const config = getCloudConfig();
    if (!config) {
      throw new CLIError(
        "Not authenticated. Run 'selftune init' to set up cloud credentials.",
        "AUTH_MISSING",
        "selftune init",
      );
    }

    // 1. Fetch the proposal from the cloud API
    console.log(`Fetching proposal ${proposalId}...`);
    const proposal = await fetchProposal(proposalId, config);

    // 2. Validate the proposal
    if (proposal.proposed_by !== "contributor_aggregate") {
      throw new CLIError(
        `Proposal was proposed by "${proposal.proposed_by}", not "contributor_aggregate".`,
        "INVALID_PROPOSAL",
        "Only contributor aggregate proposals can be applied via this command.",
      );
    }

    if (proposal.status !== "approved") {
      throw new CLIError(
        `Proposal status is "${proposal.status}", expected "approved".`,
        "INVALID_STATUS",
        "Approve the proposal in the dashboard first, then apply it.",
      );
    }

    // 3. Print proposal summary
    console.log(`\nProposal: ${proposal.id}`);
    console.log(`  Skill:         ${proposal.skill_name}`);
    console.log(`  Type:          ${proposal.proposal_type}`);
    console.log(`  Proposed by:   ${proposal.proposed_by}`);
    console.log(`  Reason:        ${proposal.reason ?? "(none)"}`);
    if (proposal.pass_rate_before != null) {
      console.log(
        `  Pass rate:     ${(proposal.pass_rate_before * 100).toFixed(1)}% -> ${proposal.projected_pass_rate != null ? (proposal.projected_pass_rate * 100).toFixed(1) + "%" : "?"}`,
      );
    }
    console.log(`\n--- Current Value ---`);
    console.log(proposal.current_value.slice(0, 500));
    console.log(`\n--- Proposed Value ---`);
    console.log(proposal.proposed_value.slice(0, 500));

    if (dryRun) {
      console.log("\n[dry-run] No changes written.");
      return;
    }

    // 4. Apply the proposal to the local SKILL.md
    const { backupPath } = applyProposalToSkill(skillPath, proposal);
    console.log(`\nApplied proposal to ${skillPath}`);
    console.log(`Backup saved to ${backupPath}`);

    // 5. Mark the proposal as applied in the cloud
    const markedApplied = await markProposalApplied(proposalId, config);
    if (markedApplied) {
      console.log(`Proposal ${proposalId} marked as applied.`);
    }
  } catch (err) {
    handleCLIError(err);
  }
}
