/**
 * skill-scaffold.ts
 *
 * Builds draft workflow skill packages from repeated telemetry-discovered
 * workflows. The draft is preview-first by default so agents can review the
 * scaffold before writing it into a local skill registry.
 */

import { join } from "node:path";

import type { CreateSkillDraft } from "../create/templates.js";
import { buildCreateSkillDraft } from "../create/templates.js";
import type { DiscoveredWorkflow } from "../types.js";
import { findGitRepositoryRoot } from "../utils/skill-discovery.js";

export interface WorkflowSkillDraft extends CreateSkillDraft {
  title: string;
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
  generatedBy?: string;
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

export function getDefaultWorkflowSkillOutputDir(cwd: string = process.cwd()): string {
  const repoRoot = findGitRepositoryRoot(cwd);
  return join(repoRoot ?? cwd, ".agents", "skills");
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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

function buildWorkflowSkillContent(
  workflow: DiscoveredWorkflow,
  title: string,
  skillName: string,
  description: string,
  generatedBy: string,
): string {
  const chain = workflow.skills.join(" → ");
  const query = workflow.representative_query.trim();

  const whenToUseLines =
    query.length > 0
      ? [
          `- The user asks to "${query}"`,
          `- The request repeatedly needs this skill chain: ${chain}`,
        ]
      : [`- The request repeatedly needs this skill chain: ${chain}`];

  return `---
name: ${skillName}
description: >
  ${description}
metadata:
  author: selftune-autogen
  version: 0.1.0
  category: custom
  generated_by: ${generatedBy}
  source_workflow_id: ${workflow.workflow_id}
---

# ${title}

This draft skill package was scaffolded by selftune from repeated workflow
telemetry. Review the routing language and package contents before broad
distribution.

## When to Use

${whenToUseLines.join("\n")}

## Workflow Routing

| Trigger | Workflow | File |
| --- | --- | --- |
| Default execution path | Default | workflows/default.md |

## Package Resources

- \`workflows/default.md\` contains the ordered execution steps for the workflow.
- \`references/overview.md\` preserves the observed provenance and trigger
  evidence from telemetry.
- \`selftune.create.json\` records the package-level readiness hints for future
  validation.

## Notes

- This is a proposal scaffold, not a silently published skill.
- Source workflow: ${chain}
- Add tighter scope boundaries and richer examples before publishing.
`;
}

function buildWorkflowDefaultContent(workflow: DiscoveredWorkflow, title: string): string {
  const query = workflow.representative_query.trim();
  const chain = workflow.skills.join(" → ");
  const executionPlanLines = workflow.skills.map(
    (skill, index) =>
      `${index + 1}. Invoke \`${skill}\` in its established role for this workflow.`,
  );

  return `# ${title} Default Workflow

## When to Use

Use this after \`../SKILL.md\` has already matched the request.${query.length > 0 ? ` The representative trigger was "${query}".` : ""}

## Goal

Coordinate this repeated multi-skill chain without making the top-level router
carry all of the execution detail: ${chain}.

## Steps

${executionPlanLines.join("\n")}

## Notes

- Provenance lives in \`../references/overview.md\`.
- Replace these placeholders with concrete execution mechanics before shipping.
`;
}

function buildWorkflowReferenceContent(workflow: DiscoveredWorkflow, title: string): string {
  const query = workflow.representative_query.trim();
  const chain = workflow.skills.join(" → ");

  return `# ${title} Overview

This package was scaffolded from observed workflow telemetry.

## Provenance

- Workflow ID: ${workflow.workflow_id}
- Skills: ${chain}
- Observed sessions: ${workflow.occurrence_count}
- Synergy score: ${workflow.synergy_score.toFixed(2)}
- Sequence consistency: ${Math.round(workflow.sequence_consistency * 100)}%
- Completion rate: ${Math.round(workflow.completion_rate * 100)}%
${query.length > 0 ? `- Representative trigger: ${query}` : "- Representative trigger: not captured"}

## Authoring Notes

- Keep the router lean in \`../SKILL.md\`.
- Move detailed steps into \`../workflows/default.md\`.
- Expand this file with examples, vocabulary, and edge cases as the skill matures.
`;
}

function replaceDraftFile(
  draft: CreateSkillDraft,
  relativePath: string,
  content: string,
): CreateSkillDraft["files"] {
  return draft.files.map((file) =>
    file.relative_path === relativePath
      ? {
          ...file,
          content,
        }
      : file,
  );
}

export function buildWorkflowSkillDraft(
  workflow: DiscoveredWorkflow,
  options: WorkflowSkillDraftOptions = {},
): WorkflowSkillDraft {
  const baseLabel = options.skillName?.trim() || deriveBaseLabel(workflow);
  const skillName = slugifyWorkflowSkillName(baseLabel);
  const title = titleCase(baseLabel) || titleCase(`${workflow.skills.join(" ")} workflow`);
  const description = buildWorkflowSkillDescription(workflow, options.description);
  const generatedBy = options.generatedBy?.trim() || "selftune workflows scaffold";
  const baseDraft = buildCreateSkillDraft({
    name: title,
    description,
    outputDir: options.outputDir,
    cwd: options.cwd,
  });
  const skillContent = buildWorkflowSkillContent(
    workflow,
    title,
    skillName,
    description,
    generatedBy,
  );
  const workflowContent = buildWorkflowDefaultContent(workflow, title);
  const referenceContent = buildWorkflowReferenceContent(workflow, title);
  const files = replaceDraftFile(baseDraft, "SKILL.md", skillContent).map((file) => {
    if (file.relative_path === "workflows/default.md") {
      return { ...file, content: workflowContent };
    }
    if (file.relative_path === "references/overview.md") {
      return { ...file, content: referenceContent };
    }
    return file;
  });

  const draft: WorkflowSkillDraft = {
    ...baseDraft,
    title,
    skill_name: skillName,
    files,
    content: "",
    source_workflow: {
      workflow_id: workflow.workflow_id,
      skills: workflow.skills,
      occurrence_count: workflow.occurrence_count,
      synergy_score: workflow.synergy_score,
      representative_query: workflow.representative_query,
    },
  };

  draft.content = formatWorkflowSkillDraft(draft);
  return draft;
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

  lines.push("");
  for (const file of draft.files) {
    lines.push(`=== ${file.relative_path} ===`, file.content.trimEnd(), "");
  }

  lines.push("Empty directories:", "  - scripts/", "  - assets/");
  return lines.join("\n");
}
