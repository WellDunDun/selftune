/**
 * deploy-proposal.ts
 *
 * Deploys a validated evolution proposal by updating SKILL.md, creating a
 * backup, building a commit message with metrics, and optionally creating
 * a git branch and PR via `gh pr create`.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EvolutionProposal } from "../types.js";
import type { ValidationResult } from "./validate-proposal.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployOptions {
  proposal: EvolutionProposal;
  validation: ValidationResult;
  skillPath: string;
  createPr: boolean;
  branchPrefix?: string; // default "selftune/evolve"
}

export interface DeployResult {
  skillMdUpdated: boolean;
  backupPath: string | null;
  branchName: string | null;
  commitMessage: string;
}

// ---------------------------------------------------------------------------
// SKILL.md reading
// ---------------------------------------------------------------------------

/** Read the contents of a SKILL.md file. Throws if the file does not exist. */
export function readSkillMd(skillPath: string): string {
  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found at ${skillPath}`);
  }
  return readFileSync(skillPath, "utf-8");
}

// ---------------------------------------------------------------------------
// Description replacement
// ---------------------------------------------------------------------------

/**
 * Replace the description section of a SKILL.md file.
 *
 * The description is defined as the content between the first `#` heading
 * and the first `##` heading. If no `##` heading exists, the entire body
 * after the first heading is replaced.
 */
export function replaceDescription(currentContent: string, newDescription: string): string {
  const lines = currentContent.split("\n");

  // Find the first # heading line
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("# ") && !lines[i].startsWith("## ")) {
      headingIndex = i;
      break;
    }
  }

  // If no heading found, just prepend the description
  if (headingIndex === -1) {
    return `${newDescription}\n${currentContent}`;
  }

  // Find the first ## heading after the main heading
  let subHeadingIndex = -1;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      subHeadingIndex = i;
      break;
    }
  }

  // Build the new content
  const headingLine = lines[headingIndex];
  const descriptionBlock = newDescription.length > 0 ? `\n${newDescription}\n` : "\n";

  if (subHeadingIndex === -1) {
    // No sub-heading: heading + new description + trailing newline
    return `${headingLine}\n${descriptionBlock}\n`;
  }

  // Heading + description + everything from the first ## onward
  const afterSubHeading = lines.slice(subHeadingIndex).join("\n");
  return `${headingLine}\n${descriptionBlock}\n${afterSubHeading}`;
}

// ---------------------------------------------------------------------------
// Commit message builder
// ---------------------------------------------------------------------------

/** Build a commit message that includes the skill name and pass rate change. */
export function buildCommitMessage(
  proposal: EvolutionProposal,
  validation: ValidationResult,
): string {
  const changePercent = Math.round(validation.net_change * 100);
  const sign = changePercent >= 0 ? "+" : "";
  const passRateStr = `${sign}${changePercent}% pass rate`;

  return `evolve(${proposal.skill_name}): ${passRateStr}`;
}

// ---------------------------------------------------------------------------
// Git/GH operations (PR creation)
// ---------------------------------------------------------------------------

/** Sanitize a string for use in a git branch name. */
function sanitizeForGitRef(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]|[.-]$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Generate a branch name from the prefix and skill name. */
function makeBranchName(prefix: string, skillName: string): string {
  const timestamp = Date.now();
  return `${prefix}/${sanitizeForGitRef(skillName)}-${timestamp}`;
}

/**
 * Run a git/gh command via Bun.spawn. Returns stdout on success.
 * Throws on non-zero exit code.
 */
async function runCommand(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): ${args.join(" ")}\n${stderr}`);
  }

  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Main deploy function
// ---------------------------------------------------------------------------

/** Deploy a validated evolution proposal to SKILL.md and optionally create a PR. */
export async function deployProposal(options: DeployOptions): Promise<DeployResult> {
  const { proposal, validation, skillPath, createPr, branchPrefix = "selftune/evolve" } = options;

  // Step 1: Read current SKILL.md
  const currentContent = readSkillMd(skillPath);

  // Step 2: Create backup
  const backupPath = `${skillPath}.bak`;
  copyFileSync(skillPath, backupPath);

  // Step 3: Replace description and write
  const updatedContent = replaceDescription(currentContent, proposal.proposed_description);
  writeFileSync(skillPath, updatedContent, "utf-8");

  // Step 4: Build commit message
  const commitMessage = buildCommitMessage(proposal, validation);

  // Step 5: Optionally create branch and PR
  let branchName: string | null = null;

  if (createPr) {
    branchName = makeBranchName(branchPrefix, proposal.skill_name);

    try {
      // Create and checkout branch
      await runCommand(["git", "checkout", "-b", branchName]);

      // Stage the SKILL.md
      await runCommand(["git", "add", skillPath]);

      // Commit
      await runCommand(["git", "commit", "-m", commitMessage]);

      // Push
      await runCommand(["git", "push", "-u", "origin", branchName]);

      // Create PR
      await runCommand([
        "gh",
        "pr",
        "create",
        "--title",
        commitMessage,
        "--body",
        `Proposal: ${proposal.proposal_id}\nRationale: ${proposal.rationale}\nNet change: ${validation.net_change > 0 ? "+" : ""}${Math.round(validation.net_change * 100)}%`,
      ]);
    } catch (err) {
      // Git/GH operations are best-effort in test environments.
      // The branch name is still returned for tracking.
      console.error(`[WARN] Git/GH operation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    skillMdUpdated: true,
    backupPath,
    branchName,
    commitMessage,
  };
}

// ---------------------------------------------------------------------------
// CLI entry guard
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log("deploy-proposal: use deployProposal() programmatically or via evolve CLI");
}
