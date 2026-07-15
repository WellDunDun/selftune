import { join } from "node:path";

import { findGitRepositoryRoot } from "../utils/skill-discovery.js";

export interface CreateSkillManifest {
  version: 1;
  entry_workflow: string;
  supports_package_replay: boolean;
  expected_resources: {
    workflows: boolean;
    references: boolean;
    scripts: boolean;
    assets: boolean;
  };
}

export interface CreateSkillDraftFile {
  relative_path: string;
  absolute_path: string;
  content: string;
}

export interface CreateSkillDraft {
  display_name: string;
  skill_name: string;
  description: string;
  output_dir: string;
  skill_dir: string;
  skill_path: string;
  manifest: CreateSkillManifest;
  directories: string[];
  files: CreateSkillDraftFile[];
}

export interface CreateSkillDraftOptions {
  name: string;
  description: string;
  outputDir?: string;
  cwd?: string;
}

function splitWords(value: string): string[] {
  return value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function slugifyCreateSkillName(value: string): string {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getDefaultCreateSkillOutputDir(cwd: string = process.cwd()): string {
  const repoRoot = findGitRepositoryRoot(cwd);
  return join(repoRoot ?? cwd, ".agents", "skills");
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

  if (current.length > 0) {
    lines.push(`  ${current}`);
  }

  return lines.length > 0 ? lines : ["  "];
}

export function buildCreateSkillManifest(): CreateSkillManifest {
  return {
    version: 1,
    entry_workflow: "workflows/default.md",
    supports_package_replay: true,
    expected_resources: {
      workflows: true,
      references: false,
      scripts: false,
      assets: false,
    },
  };
}

function buildSkillContent(displayName: string, skillName: string, description: string): string {
  const foldedDescription = wrapFoldedScalar(description).join("\n");
  return `---
name: ${skillName}
description: >
${foldedDescription}
metadata:
  author: selftune-create
  version: 0.1.0
  category: custom
  generated_by: selftune create init
---

# ${displayName}

This draft skill package was initialized by selftune. Review the trigger
language, workflow steps, references, and scripts before broad distribution.

## When to Use

- Replace these bullets with the user-language triggers that should activate
  this skill.
- Current starting point: ${description}

## Workflow Routing

| Trigger | Workflow | File |
| --- | --- | --- |
| Default execution path | Default | workflows/default.md |

## Package Resources

- \`workflows/default.md\` is the primary execution path once the skill triggers.
- \`references/overview.md\` is where background context and terminology should
  live instead of bloating the router.
- \`scripts/\` is reserved for deterministic helpers and repeatable mechanics.
- \`assets/\` is reserved for templates or static artifacts.

## Notes

- This is a draft package scaffold, not a published skill.
- Tighten the scope, add concrete examples, and validate the package before
  shipping it.
`;
}

function buildDefaultWorkflowContent(displayName: string): string {
  return `# ${displayName} Default Workflow

## When to Use

Use this after \`../SKILL.md\` has already matched the request.

## Goal

Replace this placeholder with the concrete execution flow for the skill.

## Steps

1. Confirm the request still matches the boundaries in \`../SKILL.md\`.
2. Load only the reference material needed from \`../references/\`.
3. Use deterministic helpers from \`../scripts/\` when the task has repeatable
   mechanics.
4. Produce the requested result and surface any unresolved ambiguity.

## Authoring Notes

- Keep routing guidance in \`../SKILL.md\`; keep execution detail here.
- Move reusable background context into \`../references/overview.md\`.
- Prefer scripts for mechanical steps that need to stay stable.
`;
}

function buildOverviewReferenceContent(displayName: string, description: string): string {
  return `# ${displayName} Overview

Use this file for domain context that should be loaded on demand instead of
living in the top-level router.

## Starting Point

- Working description: ${description}
- Add boundaries, vocabulary, examples, and source material here.
- Keep this file concise enough that the agent can load it only when needed.
`;
}

export function buildCreateSkillDraft(options: CreateSkillDraftOptions): CreateSkillDraft {
  const displayName = options.name.trim();
  const description = options.description.trim();
  const skillName = slugifyCreateSkillName(displayName);
  const outputDir = options.outputDir?.trim() || getDefaultCreateSkillOutputDir(options.cwd);
  const skillDir = join(outputDir, skillName);
  const workflowsDir = join(skillDir, "workflows");
  const referencesDir = join(skillDir, "references");
  const scriptsDir = join(skillDir, "scripts");
  const assetsDir = join(skillDir, "assets");
  const skillPath = join(skillDir, "SKILL.md");
  const manifest = buildCreateSkillManifest();

  return {
    display_name: displayName,
    skill_name: skillName,
    description,
    output_dir: outputDir,
    skill_dir: skillDir,
    skill_path: skillPath,
    manifest,
    directories: [skillDir, workflowsDir, referencesDir, scriptsDir, assetsDir],
    files: [
      {
        relative_path: "SKILL.md",
        absolute_path: skillPath,
        content: buildSkillContent(displayName, skillName, description),
      },
      {
        relative_path: "workflows/default.md",
        absolute_path: join(workflowsDir, "default.md"),
        content: buildDefaultWorkflowContent(displayName),
      },
      {
        relative_path: "references/overview.md",
        absolute_path: join(referencesDir, "overview.md"),
        content: buildOverviewReferenceContent(displayName, description),
      },
      {
        relative_path: "selftune.create.json",
        absolute_path: join(skillDir, "selftune.create.json"),
        content: `${JSON.stringify(manifest, null, 2)}\n`,
      },
    ],
  };
}

export function formatCreateSkillDraft(draft: CreateSkillDraft): string {
  const lines = [
    `Draft skill package: ${draft.display_name}`,
    `Skill name: ${draft.skill_name}`,
    `Directory: ${draft.skill_dir}`,
    `Entry workflow: ${draft.manifest.entry_workflow}`,
    "",
    "Files:",
    ...draft.files.map((file) => `  - ${file.relative_path}`),
    "",
    "Empty directories:",
    "  - scripts/",
    "  - assets/",
  ];

  return lines.join("\n");
}
