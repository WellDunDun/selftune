import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupStagedWorkspace,
  createStagedWorkspace,
  runAssertion,
  runExecutionEvals,
} from "../../packages/runtime/eval/execution-eval.js";
import type { ExecutionAssertion, ExecutionEvalEntry } from "../../packages/runtime/types.js";

// ---------------------------------------------------------------------------
// createStagedWorkspace — temp directory with skill content
// ---------------------------------------------------------------------------
describe("createStagedWorkspace", () => {
  test("creates temp directory with skill content", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-src-"));
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, "# Test Skill\nDescription here.");

    const workspace = createStagedWorkspace(skillPath);
    try {
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(join(workspace, "skill"))).toBe(true);
      expect(existsSync(join(workspace, "skill", "SKILL.md"))).toBe(true);

      const { readFileSync } = require("node:fs");
      const content = readFileSync(join(workspace, "skill", "SKILL.md"), "utf-8");
      expect(content).toBe("# Test Skill\nDescription here.");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates workspace even when skill path does not exist", () => {
    const workspace = createStagedWorkspace("/nonexistent/SKILL.md");
    try {
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(join(workspace, "skill"))).toBe(true);
      // SKILL.md should NOT be copied since source doesn't exist
      expect(existsSync(join(workspace, "skill", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cleanupStagedWorkspace — removes the workspace
// ---------------------------------------------------------------------------
describe("cleanupStagedWorkspace", () => {
  test("removes the workspace directory", () => {
    const workspace = mkdtempSync(join(tmpdir(), "exec-eval-cleanup-"));
    mkdirSync(join(workspace, "nested"), { recursive: true });
    writeFileSync(join(workspace, "nested", "file.txt"), "content");

    expect(existsSync(workspace)).toBe(true);
    cleanupStagedWorkspace(workspace);
    expect(existsSync(workspace)).toBe(false);
  });

  test("does not throw for nonexistent path", () => {
    expect(() => cleanupStagedWorkspace("/nonexistent/workspace")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runAssertion — file_exists type
// ---------------------------------------------------------------------------
describe("runAssertion — file_exists", () => {
  test("passes when file exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));
    writeFileSync(join(tmpDir, "output.txt"), "data");

    const assertion: ExecutionAssertion = { type: "file_exists", target: "output.txt" };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(true);
    expect(result.actual).toBe("exists");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fails when file does not exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));

    const assertion: ExecutionAssertion = { type: "file_exists", target: "missing.txt" };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(false);
    expect(result.actual).toBe("not found");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("negated: passes when file does NOT exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));

    const assertion: ExecutionAssertion = {
      type: "file_exists",
      target: "should-not-exist.txt",
      negated: true,
    };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("negated: fails when file exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));
    writeFileSync(join(tmpDir, "unwanted.txt"), "oops");

    const assertion: ExecutionAssertion = {
      type: "file_exists",
      target: "unwanted.txt",
      negated: true,
    };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runAssertion — file_contains type with regex
// ---------------------------------------------------------------------------
describe("runAssertion — file_contains", () => {
  test("passes when file content matches regex", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));
    writeFileSync(join(tmpDir, "output.md"), "# Title\nversion: 2.3.1\nend");

    const assertion: ExecutionAssertion = {
      type: "file_contains",
      target: "output.md",
      expected: "version:\\s+\\d+\\.\\d+\\.\\d+",
    };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(true);
    expect(result.actual).toBe("matched");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fails when file content does not match regex", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));
    writeFileSync(join(tmpDir, "output.md"), "no version here");

    const assertion: ExecutionAssertion = {
      type: "file_contains",
      target: "output.md",
      expected: "version:\\s+\\d+",
    };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(false);
    expect(result.actual).toBe("no match");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fails when target file does not exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));

    const assertion: ExecutionAssertion = {
      type: "file_contains",
      target: "missing.md",
      expected: "anything",
    };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(false);
    expect(result.actual).toBe("file not found");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("negated: passes when content does NOT match", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-assert-"));
    writeFileSync(join(tmpDir, "clean.txt"), "all good here");

    const assertion: ExecutionAssertion = {
      type: "file_contains",
      target: "clean.txt",
      expected: "ERROR",
      negated: true,
    };
    const result = runAssertion(assertion, tmpDir);

    expect(result.passed).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runAssertion — unimplemented types return error
// ---------------------------------------------------------------------------
describe("runAssertion — unimplemented types", () => {
  test("command_output returns error", () => {
    const assertion: ExecutionAssertion = { type: "command_output", target: "echo hello" };
    const result = runAssertion(assertion, ".");
    expect(result.passed).toBe(false);
    expect(result.error).toContain("not yet implemented");
  });

  test("skill_triggered returns error", () => {
    const assertion: ExecutionAssertion = { type: "skill_triggered", target: "pptx" };
    const result = runAssertion(assertion, ".");
    expect(result.passed).toBe(false);
    expect(result.error).toContain("not yet implemented");
  });

  test("custom returns error", () => {
    const assertion: ExecutionAssertion = { type: "custom", target: "anything" };
    const result = runAssertion(assertion, ".");
    expect(result.passed).toBe(false);
    expect(result.error).toContain("not yet implemented");
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeEntry(overrides: Partial<ExecutionEvalEntry> = {}): ExecutionEvalEntry {
  return {
    query: "test query",
    should_trigger: true,
    experimental: true,
    assertions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runExecutionEvals — full harness
// ---------------------------------------------------------------------------
describe("runExecutionEvals", () => {
  test("runs all entries and computes summary", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-run-"));
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, "# Skill");

    const entriesWithWorkspace: ExecutionEvalEntry[] = [
      makeEntry({
        query: "check skill copied",
        requires_workspace: true,
        assertions: [{ type: "file_exists", target: "skill/SKILL.md" }],
      }),
      makeEntry({
        query: "check missing in workspace",
        requires_workspace: true,
        assertions: [{ type: "file_exists", target: "nonexistent.txt" }],
      }),
    ];

    const { results, summary, gate_passed } = await runExecutionEvals(
      entriesWithWorkspace,
      skillPath,
    );

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(gate_passed).toBe(true); // gateDeployment not set
    expect(results[0].elapsed_ms).toBeGreaterThanOrEqual(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("gateDeployment: true fails gate when assertions fail", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-gate-"));
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, "# Skill");

    const entries: ExecutionEvalEntry[] = [
      makeEntry({
        query: "should fail",
        requires_workspace: true,
        assertions: [{ type: "file_exists", target: "does-not-exist.txt" }],
      }),
    ];

    const { gate_passed, summary } = await runExecutionEvals(entries, skillPath, {
      gateDeployment: true,
    });

    expect(gate_passed).toBe(false);
    expect(summary.failed).toBe(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("gateDeployment: true passes gate when all assertions pass", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-eval-gate-"));
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, "# Skill Content");

    const entries: ExecutionEvalEntry[] = [
      makeEntry({
        query: "should pass",
        requires_workspace: true,
        assertions: [
          { type: "file_exists", target: "skill/SKILL.md" },
          { type: "file_contains", target: "skill/SKILL.md", expected: "Skill Content" },
        ],
      }),
    ];

    const { gate_passed, summary } = await runExecutionEvals(entries, skillPath, {
      gateDeployment: true,
    });

    expect(gate_passed).toBe(true);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("handles empty entries array", async () => {
    const { results, summary, gate_passed } = await runExecutionEvals([], "/nonexistent");

    expect(results).toHaveLength(0);
    expect(summary.total).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(gate_passed).toBe(true);
  });
});
