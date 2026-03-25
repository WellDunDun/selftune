import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convertToEvalEntries,
  parseSkillsBenchDir,
} from "../../cli/selftune/eval/import-skillsbench.js";
import type { SkillsBenchTask } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-skillsbench-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to create a task fixture directory
// ---------------------------------------------------------------------------
function createTask(
  taskId: string,
  opts: {
    instruction: string;
    toml?: string;
  },
): void {
  const taskDir = join(tmpDir, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "instruction.md"), opts.instruction, "utf-8");
  if (opts.toml) {
    writeFileSync(join(taskDir, "task.toml"), opts.toml, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// parseSkillsBenchDir
// ---------------------------------------------------------------------------
describe("parseSkillsBenchDir", () => {
  test("parses a single task with instruction.md and task.toml", () => {
    createTask("fix-login-bug", {
      instruction: "Fix the login bug in the authentication module.",
      toml: `
difficulty = "easy"
category = "debugging"
tags = ["auth", "login", "bugfix"]
expected_skill = "debug-helper"
`,
    });

    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks.length).toBe(1);
    expect(tasks[0].task_id).toBe("fix-login-bug");
    expect(tasks[0].query).toBe("Fix the login bug in the authentication module.");
    expect(tasks[0].difficulty).toBe("easy");
    expect(tasks[0].category).toBe("debugging");
    expect(tasks[0].tags).toEqual(["auth", "login", "bugfix"]);
    expect(tasks[0].expected_skill).toBe("debug-helper");
  });

  test("parses multiple tasks", () => {
    createTask("task-a", {
      instruction: "Task A instruction.",
      toml: `difficulty = "easy"\ncategory = "general"`,
    });
    createTask("task-b", {
      instruction: "Task B instruction.",
      toml: `difficulty = "hard"\ncategory = "refactoring"`,
    });

    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks.length).toBe(2);
    const ids = tasks.map((t) => t.task_id).sort();
    expect(ids).toEqual(["task-a", "task-b"]);
  });

  test("uses defaults when task.toml is missing", () => {
    createTask("no-toml-task", {
      instruction: "Just an instruction, no TOML.",
    });

    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks.length).toBe(1);
    expect(tasks[0].task_id).toBe("no-toml-task");
    expect(tasks[0].difficulty).toBe("medium");
    expect(tasks[0].category).toBe("general");
    expect(tasks[0].tags).toBeUndefined();
  });

  test("trims whitespace from instruction", () => {
    createTask("whitespace-task", {
      instruction: "  \n  Trimmed instruction content.  \n\n",
      toml: `difficulty = "easy"\ncategory = "test"`,
    });

    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks[0].query).toBe("Trimmed instruction content.");
  });

  test("skips directories without instruction.md", () => {
    // Create a task dir with only task.toml but no instruction.md
    const taskDir = join(tmpDir, "tasks", "no-instruction");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.toml"), `difficulty = "easy"`, "utf-8");

    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks.length).toBe(0);
  });

  test("returns empty array for nonexistent directory", () => {
    const tasks = parseSkillsBenchDir(join(tmpDir, "nonexistent"));
    expect(tasks).toEqual([]);
  });

  test("returns empty array when tasks directory is empty", () => {
    mkdirSync(join(tmpDir, "tasks"), { recursive: true });
    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks).toEqual([]);
  });

  test("parses expected_tools from TOML", () => {
    createTask("tools-task", {
      instruction: "A task with expected tools.",
      toml: `
difficulty = "medium"
category = "tooling"
expected_tools = ["Bash", "Read", "Grep"]
`,
    });

    const tasks = parseSkillsBenchDir(tmpDir);
    expect(tasks[0].expected_tools).toEqual(["Bash", "Read", "Grep"]);
  });
});

// ---------------------------------------------------------------------------
// convertToEvalEntries
// ---------------------------------------------------------------------------
describe("convertToEvalEntries", () => {
  const sampleTasks: SkillsBenchTask[] = [
    {
      task_id: "task-1",
      category: "debugging",
      query: "Fix the authentication bug",
      expected_skill: "debug-helper",
      difficulty: "easy",
      tags: ["auth", "debug"],
    },
    {
      task_id: "task-2",
      category: "refactoring",
      query: "Refactor the data pipeline",
      expected_skill: "refactoring-tool",
      difficulty: "medium",
      tags: ["data", "refactor"],
    },
    {
      task_id: "task-3",
      category: "testing",
      query: "Write unit tests for the API",
      difficulty: "hard",
      tags: ["testing", "api"],
    },
  ];

  test("exact match: includes only tasks whose expected_skill matches", () => {
    const entries = convertToEvalEntries(sampleTasks, "debug-helper", "exact");
    expect(entries.length).toBe(1);
    expect(entries[0].query).toBe("Fix the authentication bug");
    expect(entries[0].should_trigger).toBe(true);
  });

  test("exact match: returns empty for no matching skill", () => {
    const entries = convertToEvalEntries(sampleTasks, "nonexistent-skill", "exact");
    expect(entries.length).toBe(0);
  });

  test("fuzzy match: includes tasks with keyword overlap in tags/category", () => {
    const entries = convertToEvalEntries(sampleTasks, "debug", "fuzzy");
    // Should match task-1 (tags contain "debug", category is "debugging")
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.query === "Fix the authentication bug")).toBe(true);
    expect(entries.every((e) => e.should_trigger)).toBe(true);
  });

  test("fuzzy match: matches on category substring", () => {
    const entries = convertToEvalEntries(sampleTasks, "refactor", "fuzzy");
    expect(entries.some((e) => e.query === "Refactor the data pipeline")).toBe(true);
  });

  test("fuzzy match: matches on tags", () => {
    const entries = convertToEvalEntries(sampleTasks, "api", "fuzzy");
    expect(entries.some((e) => e.query === "Write unit tests for the API")).toBe(true);
  });

  test("all entries have should_trigger set to true", () => {
    const entries = convertToEvalEntries(sampleTasks, "debug-helper", "exact");
    for (const e of entries) {
      expect(e.should_trigger).toBe(true);
    }
  });

  test("handles empty tasks array", () => {
    const entries = convertToEvalEntries([], "debug-helper", "exact");
    expect(entries).toEqual([]);
  });

  test("fuzzy match with no overlap returns empty", () => {
    const entries = convertToEvalEntries(sampleTasks, "zzz-no-match-zzz", "fuzzy");
    expect(entries).toEqual([]);
  });

  test("defaults to exact match when matchStrategy not specified", () => {
    const entries = convertToEvalEntries(sampleTasks, "debug-helper");
    expect(entries.length).toBe(1);
    expect(entries[0].query).toBe("Fix the authentication bug");
  });
});
