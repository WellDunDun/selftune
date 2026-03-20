#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";

type AgentSpec = {
  file: string;
  name: string;
  mode: "read-only" | "hands-on";
  requiredSections: string[];
  requiredPhrases: string[];
  forbiddenPhrases: string[];
};

type ValidationFailure = {
  file: string;
  message: string;
};

const repoRoot = join(import.meta.dir, "..");

const sharedRequiredSections = [
  "## Required Inputs From Parent",
  "## Operating Rules",
  "## Stop Conditions",
  "## Return Format",
];

const sharedForbiddenPhrases = [
  "Ask the user",
  "Parse JSON",
  "parse JSON",
  "settings_snippet.json",
  "routing_table",
  "full_body",
];

const agents: AgentSpec[] = [
  {
    file: "skill/agents/diagnosis-analyst.md",
    name: "diagnosis-analyst",
    mode: "read-only",
    requiredSections: [...sharedRequiredSections, "## Investigation Workflow"],
    requiredPhrases: [
      "Use when",
      "Do not ask the user directly unless the parent explicitly told you to.",
      "selftune status",
      "selftune last",
      "selftune doctor",
    ],
    forbiddenPhrases: sharedForbiddenPhrases,
  },
  {
    file: "skill/agents/evolution-reviewer.md",
    name: "evolution-reviewer",
    mode: "read-only",
    requiredSections: [...sharedRequiredSections, "## Review Workflow"],
    requiredPhrases: [
      "Use when",
      "Do not ask the user directly unless the parent explicitly told you to.",
      "selftune evolve --skill <name> --skill-path <path> --dry-run",
      "routing|body",
    ],
    forbiddenPhrases: sharedForbiddenPhrases,
  },
  {
    file: "skill/agents/integration-guide.md",
    name: "integration-guide",
    mode: "hands-on",
    requiredSections: [...sharedRequiredSections, "## Setup Workflow"],
    requiredPhrases: [
      "Use when",
      "Do not ask the user directly unless the parent explicitly told you to.",
      "`requestedMode`: `plan-only` or `hands-on`",
      "`selftune init` is the source of truth for config bootstrap and automatic",
    ],
    forbiddenPhrases: sharedForbiddenPhrases,
  },
  {
    file: "skill/agents/pattern-analyst.md",
    name: "pattern-analyst",
    mode: "read-only",
    requiredSections: [...sharedRequiredSections, "## Analysis Workflow"],
    requiredPhrases: [
      "Use when",
      "Do not ask the user directly unless the parent explicitly told",
      "selftune eval composability",
      "selftune eval generate --list-skills",
    ],
    forbiddenPhrases: sharedForbiddenPhrases,
  },
];

function getFrontmatterBlock(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(1, i).join("\n");
    }
  }

  return null;
}

function getFrontmatterValue(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function requireIncludes(
  failures: ValidationFailure[],
  file: string,
  content: string,
  needle: string,
  label = needle,
): void {
  if (!content.includes(needle)) {
    failures.push({ file, message: `Missing required content: ${label}` });
  }
}

function requireExcludes(
  failures: ValidationFailure[],
  file: string,
  content: string,
  needle: string,
): void {
  if (content.includes(needle)) {
    failures.push({ file, message: `Contains forbidden stale content: ${needle}` });
  }
}

function validateAgent(spec: AgentSpec, failures: ValidationFailure[]): void {
  const filePath = join(repoRoot, spec.file);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ file: spec.file, message: `Failed to read file: ${msg}` });
    return;
  }
  const frontmatter = getFrontmatterBlock(content);

  if (!frontmatter) {
    failures.push({ file: spec.file, message: "Missing YAML frontmatter block" });
    return;
  }

  const name = getFrontmatterValue(frontmatter, "name");
  const description = getFrontmatterValue(frontmatter, "description");
  const tools = getFrontmatterValue(frontmatter, "tools");
  const disallowedTools = getFrontmatterValue(frontmatter, "disallowedTools");
  const model = getFrontmatterValue(frontmatter, "model");
  const maxTurns = getFrontmatterValue(frontmatter, "maxTurns");

  if (name !== spec.name) {
    failures.push({
      file: spec.file,
      message: `Expected frontmatter name '${spec.name}', found '${name || "(missing)"}'`,
    });
  }

  if (!description.startsWith("Use when")) {
    failures.push({
      file: spec.file,
      message: "Description must be delegation-oriented and start with 'Use when'",
    });
  }

  if (!model) {
    failures.push({ file: spec.file, message: "Missing frontmatter field: model" });
  }

  if (!maxTurns) {
    failures.push({ file: spec.file, message: "Missing frontmatter field: maxTurns" });
  }

  if (!tools) {
    failures.push({ file: spec.file, message: "Missing frontmatter field: tools" });
  }

  if (spec.mode === "read-only") {
    if (disallowedTools !== "Write, Edit") {
      failures.push({
        file: spec.file,
        message: "Read-only subagents must set 'disallowedTools: Write, Edit'",
      });
    }
  } else {
    if (!tools.includes("Write") || !tools.includes("Edit")) {
      failures.push({
        file: spec.file,
        message: "Hands-on subagents must expose Write and Edit in tools",
      });
    }
  }

  for (const section of spec.requiredSections) {
    requireIncludes(failures, spec.file, content, section);
  }

  for (const phrase of spec.requiredPhrases) {
    requireIncludes(failures, spec.file, content, phrase);
  }

  for (const phrase of spec.forbiddenPhrases) {
    requireExcludes(failures, spec.file, content, phrase);
  }
}

function validateSkillSummary(failures: ValidationFailure[]): void {
  const file = "skill/SKILL.md";
  let content: string;
  try {
    content = readFileSync(join(repoRoot, file), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ file, message: `Failed to read file: ${msg}` });
    return;
  }

  requireIncludes(failures, file, content, "Treat these as worker-style subagents:");
  const specializedAgentsSection =
    content.match(
      /## Specialized Agents[\s\S]*?\n\| Trigger keywords \| Agent file \| When to use \|\n([\s\S]*?)\n## /,
    )?.[1] ?? "";

  if (!specializedAgentsSection) {
    failures.push({
      file,
      message: "Missing or malformed Specialized Agents table in SKILL.md",
    });
    return;
  }

  const agentRows = specializedAgentsSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.includes("---"));

  for (const agent of agents) {
    const agentPath = `\`${agent.file.replace("skill/", "")}\``;
    if (!agentRows.some((row) => row.includes(agentPath))) {
      failures.push({
        file,
        message: `Specialized Agents table is missing row for ${agentPath}`,
      });
    }
  }
}

function main(): void {
  const failures: ValidationFailure[] = [];

  for (const agent of agents) {
    validateAgent(agent, failures);
  }
  validateSkillSummary(failures);

  if (failures.length > 0) {
    console.error("Subagent doc validation failed:\n");
    for (const failure of failures) {
      console.error(`- ${failure.file}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Validated ${agents.length} bundled subagent docs and the SKILL.md specialized-agent summary.`,
  );
}

main();
