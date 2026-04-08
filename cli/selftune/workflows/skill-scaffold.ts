/**
 * skill-scaffold.ts
 *
 * Builds draft workflow skills from repeated telemetry-discovered workflows.
 * The draft is preview-first by default so agents can review the scaffold before
 * writing it into a local skill registry.
 */

import { join } from "node:path";

import type { DiscoveredWorkflow } from "../types.js";
import { findGitRepositoryRoot } from "../utils/skill-discovery.js";

export interface WorkflowSkillDraft {
  title: string;
  skill_name: string;
  description: string;
  output_dir: string;
  skill_dir: string;
  skill_path: string;
  content: string;
  source_workflow: {
    workflow_id: string;
    skills: string[];
    occurrence_count: number;
    synergy_score: number;
    representative_query: string;
  };
}

export interface WorkflowSkillDraftOptions {
  outputDir?: string;
  skillName?: string;
  description?: string;
  cwd?: string;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function splitWords(value: string): string[] {
  return value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function titleCase(value: string): string {
  return splitWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function slugifyWorkflowSkillName(value: string): string {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveBaseLabel(workflow: DiscoveredWorkflow): string {
  const filteredQueryWords = splitWords(workflow.representative_query).filter(
    (word) => !STOPWORDS.has(word.toLowerCase()),
  );

  if (filteredQueryWords.length >= 2) {
    return filteredQueryWords.slice(0, 5).join(" ");
  }

  return `${workflow.skills.join(" ")} workflow`;
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function wrapFoldedScalar(value: string, width = 78): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(`  ${current}`);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) lines.push(`  ${current}`);
  return lines.length > 0 ? lines : ["  "];
}

export function getDefaultWorkflowSkillOutputDir(cwd: string = process.cwd()): string {
  const repoRoot = findGitRepositoryRoot(cwd);
  return join(repoRoot ?? cwd, ".agents", "skills");
}

export function buildWorkflowSkillDescription(
  workflow: DiscoveredWorkflow,
  override?: string,
): string {
  if (override && override.trim().length > 0) return override.trim();

  const chain = formatList(workflow.skills);
  const query = workflow.representative_query.trim();
  if (query.length > 0) {
    return `Use when the user wants to ${query}. Coordinates ${chain} in sequence.`;
  }

  return `Use when the task consistently needs ${chain} in sequence.`;
}

export function buildWorkflowSkillContent(
  workflow: DiscoveredWorkflow,
  title: string,
  skillName: string,
  description: string,
): string {
  const workflowName = title.endsWith("Workflow") ? title : `${title} Workflow`;
  const chain = workflow.skills.join(" → ");
  const query = workflow.representative_query.trim();
  const foldedDescription = wrapFoldedScalar(description).join("\n");

  const whenToUseLines =
    query.length > 0
      ? [
          `- The user asks to "${query}"`,
          `- The request repeatedly needs this skill chain: ${chain}`,
        ]
      : [`- The request repeatedly needs this skill chain: ${chain}`];

  const executionPlanLines = workflow.skills.map(
    (skill, index) =>
      `${index + 1}. Invoke \`${skill}\` in its established role for this workflow.`,
  );

  return `---
name: ${skillName}
description: >
${foldedDescription}
metadata:
  author: selftune-autogen
  version: 0.1.0
  category: developer-tools
  generated_by: selftune workflows scaffold
  source_workflow_id: ${workflow.workflow_id}
---

# ${title}

This draft skill was scaffolded by selftune from repeated workflow telemetry.
Review the routing language and execution notes before broad distribution.

## When to Use

${whenToUseLines.join("\n")}

## Execution Plan

${executionPlanLines.join("\n")}

## Workflows

### ${workflowName}
- **Skills:** ${chain}
${query.length > 0 ? `- **Trigger:** ${query}\n` : ""}- **Source:** Discovered from ${workflow.occurrence_count} sessions (synergy: ${workflow.synergy_score.toFixed(2)})

## Notes

- This is a proposal scaffold, not a silently published marketplace skill.
- Add tighter scope boundaries and richer examples before publishing.
`;
}

export function buildWorkflowSkillDraft(
  workflow: DiscoveredWorkflow,
  options: WorkflowSkillDraftOptions = {},
): WorkflowSkillDraft {
  const baseLabel = options.skillName?.trim() || deriveBaseLabel(workflow);
  const skillName = slugifyWorkflowSkillName(baseLabel);
  const title = titleCase(baseLabel) || titleCase(`${workflow.skills.join(" ")} workflow`);
  const description = buildWorkflowSkillDescription(workflow, options.description);
  const outputDir = options.outputDir?.trim() || getDefaultWorkflowSkillOutputDir(options.cwd);
  const skillDir = join(outputDir, skillName);
  const skillPath = join(skillDir, "SKILL.md");

  return {
    title,
    skill_name: skillName,
    description,
    output_dir: outputDir,
    skill_dir: skillDir,
    skill_path: skillPath,
    content: buildWorkflowSkillContent(workflow, title, skillName, description),
    source_workflow: {
      workflow_id: workflow.workflow_id,
      skills: workflow.skills,
      occurrence_count: workflow.occurrence_count,
      synergy_score: workflow.synergy_score,
      representative_query: workflow.representative_query,
    },
  };
}

export function formatWorkflowSkillDraft(draft: WorkflowSkillDraft): string {
  const lines = [
    `Draft workflow skill: ${draft.title}`,
    `Skill name: ${draft.skill_name}`,
    `Output path: ${draft.skill_path}`,
    `Source workflow: ${draft.source_workflow.workflow_id}`,
    `Occurrences: ${draft.source_workflow.occurrence_count} | Synergy: ${draft.source_workflow.synergy_score.toFixed(2)}`,
  ];

  if (draft.source_workflow.representative_query.trim().length > 0) {
    lines.push(`Representative query: "${draft.source_workflow.representative_query.trim()}"`);
  }

  lines.push("", draft.content.trimEnd());
  return lines.join("\n");
}
