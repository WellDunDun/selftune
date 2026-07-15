/**
 * execution-eval.ts
 *
 * Experimental execution eval harness — runs assertion-based evals
 * in a staged skill workspace. Phase 2 of eval system gap closure.
 *
 * Behind experimental flag: must be explicitly opted into.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionAssertion, ExecutionEvalEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ExecutionEvalResult {
  entry: ExecutionEvalEntry;
  passed: boolean;
  assertion_results: AssertionResult[];
  workspace_path?: string;
  elapsed_ms: number;
}

export interface AssertionResult {
  assertion: ExecutionAssertion;
  passed: boolean;
  actual?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Staged workspace management
// ---------------------------------------------------------------------------

/**
 * Create a staged workspace for execution eval isolation.
 * Copies the skill into a temp directory so assertions don't affect the real skill.
 */
export function createStagedWorkspace(skillPath: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "selftune-exec-eval-"));
  const skillDir = join(workspace, "skill");
  mkdirSync(skillDir, { recursive: true });

  if (existsSync(skillPath)) {
    copyFileSync(skillPath, join(skillDir, "SKILL.md"));
  }

  return workspace;
}

/**
 * Clean up a staged workspace.
 */
export function cleanupStagedWorkspace(workspacePath: string): void {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Assertion runner
// ---------------------------------------------------------------------------

/**
 * Run a single execution assertion against a workspace.
 */
export function runAssertion(
  assertion: ExecutionAssertion,
  workspacePath: string,
): AssertionResult {
  try {
    switch (assertion.type) {
      case "file_exists": {
        const target = join(workspacePath, assertion.target);
        const exists = existsSync(target);
        const passed = assertion.negated ? !exists : exists;
        return { assertion, passed, actual: exists ? "exists" : "not found" };
      }

      case "file_contains": {
        const target = join(workspacePath, assertion.target);
        if (!existsSync(target)) {
          return { assertion, passed: !!assertion.negated, actual: "file not found" };
        }
        const content = readFileSync(target, "utf-8");
        const pattern = new RegExp(assertion.expected ?? "");
        const matches = pattern.test(content);
        const passed = assertion.negated ? !matches : matches;
        return { assertion, passed, actual: matches ? "matched" : "no match" };
      }

      case "command_output":
      case "skill_triggered":
      case "custom": {
        return {
          assertion,
          passed: false,
          error: `Assertion type "${assertion.type}" not yet implemented`,
        };
      }

      default:
        return { assertion, passed: false, error: "Unknown assertion type" };
    }
  } catch (err) {
    return { assertion, passed: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Execution eval runner
// ---------------------------------------------------------------------------

/**
 * Run all execution evals for a set of entries.
 * Requires experimental opt-in (entries must have `experimental: true`).
 */
export async function runExecutionEvals(
  entries: ExecutionEvalEntry[],
  skillPath: string,
  options?: { gateDeployment?: boolean },
): Promise<{
  results: ExecutionEvalResult[];
  gate_passed: boolean;
  summary: { total: number; passed: number; failed: number };
}> {
  const results: ExecutionEvalResult[] = [];

  for (const entry of entries) {
    const start = Date.now();
    let workspace: string | undefined;

    try {
      if (entry.requires_workspace) {
        workspace = createStagedWorkspace(skillPath);
      }

      const assertionResults = entry.assertions.map((a) => runAssertion(a, workspace ?? "."));

      const passed = assertionResults.every((r) => r.passed);

      results.push({
        entry,
        passed,
        assertion_results: assertionResults,
        workspace_path: workspace,
        elapsed_ms: Date.now() - start,
      });
    } finally {
      if (workspace) {
        cleanupStagedWorkspace(workspace);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const gatePassed = !options?.gateDeployment || failed === 0;

  return {
    results,
    gate_passed: gatePassed,
    summary: { total: results.length, passed, failed },
  };
}
