/**
 * deploy-proposal.ts
 *
 * Deploys a validated evolution proposal by updating SKILL.md, creating a
 * backup, building a commit message with metrics, and optionally creating
 * a git branch and PR via `gh pr create`.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EvolutionProposal, SkillSections } from "../types.js";
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

  // Build the new content, preserving any preamble before the first heading
  const preamble = headingIndex > 0 ? `${lines.slice(0, headingIndex).join("\n")}\n` : "";
  const headingLine = lines[headingIndex];
  const descriptionBlock = newDescription.length > 0 ? `\n${newDescription}\n` : "\n";

  if (subHeadingIndex === -1) {
    // No sub-heading: preamble + heading + new description + trailing newline
    return `${preamble}${headingLine}\n${descriptionBlock}\n`;
  }

  // Preamble + heading + description + everything from the first ## onward
  const afterSubHeading = lines.slice(subHeadingIndex).join("\n");
  return `${preamble}${headingLine}\n${descriptionBlock}\n${afterSubHeading}`;
}

// ---------------------------------------------------------------------------
// Structured SKILL.md parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file into named sections.
 *
 * Splits the content into:
 *   - frontmatter: YAML frontmatter block (if present, including delimiters)
 *   - title: the first `# Heading` line
 *   - description: content between the title and the first `## ` heading
 *   - sections: map of `## Name` -> content (up to next `##` or EOF)
 */
export function parseSkillSections(content: string): SkillSections {
  const lines = content.split("\n");
  let idx = 0;

  // --- frontmatter ---
  let frontmatter = "";
  if (lines[0]?.trim() === "---") {
    const endIdx = lines.indexOf("---", 1);
    if (endIdx > 0) {
      frontmatter = lines.slice(0, endIdx + 1).join("\n");
      idx = endIdx + 1;
      // skip blank line after frontmatter
      if (idx < lines.length && lines[idx].trim() === "") idx++;
    }
  }

  // --- title ---
  let title = "";
  while (idx < lines.length) {
    if (lines[idx].startsWith("# ") && !lines[idx].startsWith("## ")) {
      title = lines[idx];
      idx++;
      break;
    }
    idx++;
  }

  // --- description (between title and first ## heading) ---
  const descLines: string[] = [];
  while (idx < lines.length && !lines[idx].startsWith("## ")) {
    descLines.push(lines[idx]);
    idx++;
  }
  // Trim leading/trailing blank lines from description
  const description = descLines.join("\n").trim();

  // --- remaining ## sections ---
  const sections: Record<string, string> = {};
  let currentSection = "";
  const sectionLines: string[] = [];

  while (idx < lines.length) {
    if (lines[idx].startsWith("## ")) {
      // Flush previous section
      if (currentSection) {
        sections[currentSection] = sectionLines.join("\n").trim();
        sectionLines.length = 0;
      }
      currentSection = lines[idx].replace(/^## /, "").trim();
      idx++;
    } else {
      sectionLines.push(lines[idx]);
      idx++;
    }
  }
  // Flush last section
  if (currentSection) {
    sections[currentSection] = sectionLines.join("\n").trim();
  }

  return { frontmatter, title, description, sections };
}

// ---------------------------------------------------------------------------
// Section replacement
// ---------------------------------------------------------------------------

/**
 * Replace a named `## Section` block in a SKILL.md file.
 *
 * If the section does not exist, appends it at the end.
 */
export function replaceSection(content: string, sectionName: string, newContent: string): string {
  const lines = content.split("\n");
  const heading = `## ${sectionName}`;
  let startIdx = -1;
  let endIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === heading) {
      startIdx = i;
      // Find end: next ## heading or EOF
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("## ")) {
          endIdx = j;
          break;
        }
      }
      break;
    }
  }

  if (startIdx === -1) {
    // Section not found — append
    const trimmed = content.trimEnd();
    return `${trimmed}\n\n${heading}\n\n${newContent}\n`;
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  return [...before, heading, "", newContent, "", ...after].join("\n");
}

/**
 * Replace the entire body below frontmatter with a proposed body.
 *
 * Preserves frontmatter (if present) and the `# Title` line intact.
 */
export function replaceBody(currentContent: string, proposedBody: string): string {
  const parsed = parseSkillSections(currentContent);
  const parts: string[] = [];

  if (parsed.frontmatter) {
    parts.push(parsed.frontmatter);
    parts.push("");
  }
  if (parsed.title) {
    parts.push(parsed.title);
    parts.push("");
  }
  parts.push(proposedBody);

  return `${parts.join("\n").trimEnd()}\n`;
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
  const safeName = sanitizeForGitRef(skillName) || "untitled";
  return `${prefix}/${safeName}-${timestamp}`;
}

/**
 * Run a git/gh command via Bun.spawn. Returns stdout on success.
 * Throws on non-zero exit code or if the command exceeds timeoutMs.
 */
async function runCommand(args: string[], cwd?: string, timeoutMs = 30_000): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    // Read stdout and stderr concurrently to avoid deadlock when both pipes fill.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (timedOut) {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${args.join(" ")}`);
    }

    if (exitCode !== 0) {
      throw new Error(`Command failed (exit ${exitCode}): ${args.join(" ")}\n${stderr}`);
    }

    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main deploy function
// ---------------------------------------------------------------------------

/** Deploy a validated evolution proposal to SKILL.md and optionally create a PR. */
export async function deployProposal(options: DeployOptions): Promise<DeployResult> {
  const { proposal, validation, skillPath, createPr, branchPrefix = "selftune/evolve" } = options;

  // Step 1: Read current SKILL.md
  const currentContent = readSkillMd(skillPath);

  // Step 2: Create backup (unique per deploy to avoid overwriting previous backups)
  const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${skillPath}.${backupTimestamp}.bak`;
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
