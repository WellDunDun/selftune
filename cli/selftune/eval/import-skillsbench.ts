#!/usr/bin/env bun
/**
 * import-skillsbench.ts
 *
 * Imports task definitions from a SkillsBench-style corpus directory and
 * converts them into EvalEntry arrays for use with selftune eval/grading.
 *
 * Expected directory structure:
 *   <dir>/tasks/<task-id>/instruction.md   — task description (query text)
 *   <dir>/tasks/<task-id>/task.toml        — metadata (difficulty, category, tags, etc.)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import type { EvalEntry, SkillsBenchTask } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal TOML parser (handles the subset used by SkillsBench task.toml files)
// ---------------------------------------------------------------------------

function parseSimpleToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const rawValue = line.slice(eqIdx + 1).trim();

    if (rawValue.startsWith("[")) {
      // Array value — parse simple string arrays like ["a", "b", "c"]
      const arrayContent = rawValue.slice(1, rawValue.lastIndexOf("]"));
      const items: string[] = [];
      for (const item of arrayContent.split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "");
        if (trimmed) items.push(trimmed);
      }
      result[key] = items;
    } else if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      // String value
      result[key] = rawValue.replace(/^["']|["']$/g, "");
    } else {
      // Bare value (number, boolean, etc.)
      result[key] = rawValue;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Parse SkillsBench directory
// ---------------------------------------------------------------------------

export function parseSkillsBenchDir(dirPath: string): SkillsBenchTask[] {
  const tasksDir = join(dirPath, "tasks");
  if (!existsSync(tasksDir)) return [];

  const tasks: SkillsBenchTask[] = [];

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const taskDir = join(tasksDir, entry.name);
    const instructionPath = join(taskDir, "instruction.md");

    if (!existsSync(instructionPath)) continue;

    const query = readFileSync(instructionPath, "utf-8").trim();
    if (!query) continue;

    // Parse optional task.toml
    const tomlPath = join(taskDir, "task.toml");
    let metadata: Record<string, unknown> = {};
    if (existsSync(tomlPath)) {
      metadata = parseSimpleToml(readFileSync(tomlPath, "utf-8"));
    }

    const difficulty = metadata.difficulty as SkillsBenchTask["difficulty"] | undefined;

    const task: SkillsBenchTask = {
      task_id: entry.name,
      category: (metadata.category as string) ?? "general",
      query,
      difficulty: difficulty && ["easy", "medium", "hard"].includes(difficulty) ? difficulty : "medium",
    };

    if (metadata.expected_skill) {
      task.expected_skill = metadata.expected_skill as string;
    }
    if (metadata.expected_tools && Array.isArray(metadata.expected_tools)) {
      task.expected_tools = metadata.expected_tools as string[];
    }
    if (metadata.tags && Array.isArray(metadata.tags)) {
      task.tags = metadata.tags as string[];
    }

    tasks.push(task);
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Convert tasks to EvalEntries
// ---------------------------------------------------------------------------

export function convertToEvalEntries(
  tasks: SkillsBenchTask[],
  targetSkill: string,
  matchStrategy: "exact" | "fuzzy" = "exact",
): EvalEntry[] {
  const entries: EvalEntry[] = [];

  for (const task of tasks) {
    let matches = false;

    if (matchStrategy === "exact") {
      matches = task.expected_skill === targetSkill;
    } else {
      // Fuzzy: check if targetSkill appears as substring in category, tags, or expected_skill
      const skillLower = targetSkill.toLowerCase();
      const searchable = [
        task.category,
        task.expected_skill,
        ...(task.tags ?? []),
      ]
        .filter(Boolean)
        .map((s) => (s as string).toLowerCase());

      matches = searchable.some(
        (s) => s === skillLower || s.includes(skillLower),
      );
    }

    if (matches) {
      entries.push({
        query: task.query,
        should_trigger: true,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      skill: { type: "string" },
      output: { type: "string" },
      "match-strategy": { type: "string", default: "exact" },
    },
    strict: true,
  });

  if (!values.dir) {
    console.error("[ERROR] --dir required (path to SkillsBench corpus directory)");
    process.exit(1);
  }

  if (!values.skill) {
    console.error("[ERROR] --skill required (target skill name)");
    process.exit(1);
  }

  const matchStrategy = values["match-strategy"] === "fuzzy" ? "fuzzy" : "exact";

  const tasks = parseSkillsBenchDir(values.dir);

  if (tasks.length === 0) {
    console.error(`[WARN] No tasks found in ${values.dir}/tasks/`);
    console.error("Expected structure: <dir>/tasks/<task-id>/instruction.md");
    process.exit(1);
  }

  console.log(`Parsed ${tasks.length} tasks from ${values.dir}`);

  const entries = convertToEvalEntries(tasks, values.skill, matchStrategy);

  if (entries.length === 0) {
    console.log(`[WARN] No tasks matched skill '${values.skill}' with strategy '${matchStrategy}'.`);
    console.log("Available expected_skills:");
    const skills = [...new Set(tasks.map((t) => t.expected_skill).filter(Boolean))].sort();
    for (const s of skills) {
      console.log(`  ${s}`);
    }
    if (matchStrategy === "exact") {
      console.log("\nTip: try --match-strategy fuzzy for keyword-based matching.");
    }
  }

  const outputPath = values.output ?? `${values.skill}_skillsbench_eval.json`;
  writeFileSync(outputPath, JSON.stringify(entries, null, 2), "utf-8");
  console.log(`Wrote ${entries.length} eval entries to ${outputPath}`);
}

if (import.meta.main) {
  cliMain();
}
