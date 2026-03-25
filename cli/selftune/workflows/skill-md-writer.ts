/**
 * skill-md-writer.ts
 *
 * Line-based parser and writer for the `## Workflows` section in SKILL.md files.
 * Pure functions, zero dependencies — follows the frontmatter.ts pattern.
 */

import type { CodifiedWorkflow } from "../types.js";

type WorkflowBuilder = Pick<CodifiedWorkflow, "name" | "skills" | "source"> &
  Partial<Pick<CodifiedWorkflow, "description" | "discovered_from">>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse existing `## Workflows` section from SKILL.md content.
 * Returns an empty array if the section is missing or empty.
 */
export function parseWorkflowsSection(content: string): CodifiedWorkflow[] {
  const lines = content.split("\n");
  const workflows: CodifiedWorkflow[] = [];

  // Find the ## Workflows heading
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "## Workflows") {
      sectionStart = i + 1;
      break;
    }
  }

  if (sectionStart < 0) return [];

  // Find the end of the section (next ## heading or EOF)
  let sectionEnd = lines.length;
  for (let i = sectionStart; i < lines.length; i++) {
    if (lines[i].startsWith("## ") && lines[i].trim() !== "## Workflows") {
      sectionEnd = i;
      break;
    }
  }

  // Parse each ### subsection within the workflows section
  const sectionLines = lines.slice(sectionStart, sectionEnd);
  let current: WorkflowBuilder | null = null;

  for (const line of sectionLines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("### ")) {
      // Save previous workflow if any
      if (current) workflows.push(current);
      current = {
        name: trimmed.slice(4).trim(),
        skills: [],
        source: "authored",
      };
      continue;
    }

    if (!current) continue;

    if (trimmed.startsWith("- **Skills:**")) {
      const skillsStr = trimmed.slice("- **Skills:**".length).trim();
      current.skills = skillsStr
        .split(" \u2192 ")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    if (trimmed.startsWith("- **Trigger:**")) {
      current.description = trimmed.slice("- **Trigger:**".length).trim();
      continue;
    }

    if (trimmed.startsWith("- **Source:**")) {
      const sourceStr = trimmed.slice("- **Source:**".length).trim();
      const discoveredMatch = sourceStr.match(
        /^Discovered from (\d+) sessions? \(synergy: (-?\d+(?:\.\d+)?)\)$/,
      );
      if (discoveredMatch) {
        current.source = "discovered";
        current.discovered_from = {
          workflow_id: current.skills.join("\u2192"),
          occurrence_count: parseInt(discoveredMatch[1], 10),
          synergy_score: parseFloat(discoveredMatch[2]),
        };
      } else {
        current.source = "authored";
      }
    }
  }

  // Don't forget the last workflow
  if (current) workflows.push(current);

  return workflows;
}

// ---------------------------------------------------------------------------
// Writer — append
// ---------------------------------------------------------------------------

/**
 * Format a single workflow as a markdown subsection.
 */
function formatWorkflowSubsection(workflow: CodifiedWorkflow): string {
  const lines: string[] = [];
  lines.push(`### ${workflow.name}`);
  lines.push(`- **Skills:** ${workflow.skills.join(" \u2192 ")}`);
  if (workflow.description) {
    lines.push(`- **Trigger:** ${workflow.description}`);
  }

  if (workflow.source === "discovered" && workflow.discovered_from) {
    const { occurrence_count, synergy_score } = workflow.discovered_from;
    lines.push(
      `- **Source:** Discovered from ${occurrence_count} sessions (synergy: ${synergy_score.toFixed(2)})`,
    );
  } else {
    lines.push(`- **Source:** authored`);
  }

  return lines.join("\n");
}

/**
 * Append a workflow to the `## Workflows` section.
 * Creates the section if it doesn't exist.
 * Returns content unchanged if a workflow with the same name already exists.
 */
export function appendWorkflow(content: string, workflow: CodifiedWorkflow): string {
  // Check for duplicate
  const existing = parseWorkflowsSection(content);
  if (existing.some((w) => w.name === workflow.name)) {
    return content;
  }

  const subsection = formatWorkflowSubsection(workflow);
  const lines = content.split("\n");

  // Find the ## Workflows heading
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "## Workflows") {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart >= 0) {
    // Find the end of the workflows section (next ## heading or EOF)
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        sectionEnd = i;
        break;
      }
    }

    // Insert before the next ## heading (or at EOF)
    const before = lines.slice(0, sectionEnd);
    const after = lines.slice(sectionEnd);

    // Ensure blank line before the new subsection
    const lastNonEmpty = findLastNonEmptyIndex(before);
    const needsBlankLine = lastNonEmpty >= 0 && lastNonEmpty === before.length - 1;

    const result: string[] = [...before];
    if (needsBlankLine) result.push("");
    result.push(subsection);
    if (after.length > 0) {
      result.push("");
      result.push(...after);
    }
    return result.join("\n");
  }

  // No ## Workflows section — append at end
  const trimmedContent = content.replace(/\n*$/, "");
  return `${trimmedContent}\n\n## Workflows\n\n${subsection}\n`;
}

// ---------------------------------------------------------------------------
// Writer — remove
// ---------------------------------------------------------------------------

/**
 * Remove a workflow by name from the `## Workflows` section.
 * If the section becomes empty after removal, the section heading is also removed.
 * Returns content unchanged if the workflow is not found.
 */
export function removeWorkflow(content: string, name: string): string {
  const lines = content.split("\n");

  // Find the ## Workflows heading
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "## Workflows") {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart < 0) return content;

  // Find the end of the workflows section
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }

  // Find the ### <name> subsection
  let subStart = -1;
  let subEnd = -1;

  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (lines[i].trim() === `### ${name}`) {
      subStart = i;
      // Find the end of this subsection (next ### or ## or sectionEnd)
      subEnd = sectionEnd;
      for (let j = i + 1; j < sectionEnd; j++) {
        if (lines[j].startsWith("### ")) {
          subEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (subStart < 0) return content;

  // Remove blank lines before the subsection (cleanup)
  let removeFrom = subStart;
  while (removeFrom > sectionStart + 1 && lines[removeFrom - 1].trim() === "") {
    removeFrom--;
  }

  // Remove blank lines after the subsection (cleanup)
  let removeTo = subEnd;
  while (removeTo < sectionEnd && lines[removeTo]?.trim() === "") {
    removeTo++;
  }

  // Build result without the removed subsection
  const before = lines.slice(0, removeFrom);
  const after = lines.slice(removeTo);

  // Check if the workflows section is now empty
  const remaining = [...before.slice(sectionStart + 1), ...after.slice(0, sectionEnd - removeTo)];
  const hasRemainingWorkflows = remaining.some((l) => l.startsWith("### "));

  if (!hasRemainingWorkflows) {
    // Remove the entire ## Workflows section (heading + any blank lines)
    let headingStart = sectionStart;
    // Remove blank lines before the heading too
    while (headingStart > 0 && lines[headingStart - 1].trim() === "") {
      headingStart--;
    }

    const beforeSection = lines.slice(0, headingStart);
    const afterSection = lines.slice(removeTo);

    const result = [...beforeSection, ...afterSection].join("\n");
    // Clean up trailing newlines
    return result.replace(/\n{3,}$/, "\n");
  }

  return [...before, ...after].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLastNonEmptyIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}
