/**
 * Skill unit test runner.
 *
 * Loads, runs, and reports on skill-level unit tests.
 * Tests are stored as JSON arrays of SkillUnitTest objects.
 *
 * Assertion types:
 *   - contains / not_contains: check transcript for substring
 *   - regex: check transcript against a regex pattern
 *   - tool_called / tool_not_called: check transcript for tool usage
 *   - json_path: check key=value in parsed JSON from transcript
 */

import { existsSync, readFileSync } from "node:fs";

import type {
  SkillAssertion,
  SkillUnitTest,
  UnitTestResult,
  UnitTestSuiteResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Assertion checker (deterministic, no agent needed)
// ---------------------------------------------------------------------------

/** Check a single assertion against a transcript string. */
export function checkAssertion(
  assertion: SkillAssertion,
  transcript: string,
): { passed: boolean; actual?: string } {
  switch (assertion.type) {
    case "contains":
      return {
        passed: transcript.includes(assertion.value),
        actual: transcript.includes(assertion.value) ? assertion.value : "(not found)",
      };

    case "not_contains":
      return {
        passed: !transcript.includes(assertion.value),
        actual: transcript.includes(assertion.value) ? `found: ${assertion.value}` : "(absent)",
      };

    case "regex": {
      const re = new RegExp(assertion.value);
      const match = re.exec(transcript);
      return {
        passed: match !== null,
        actual: match ? match[0] : "(no match)",
      };
    }

    case "tool_called":
      return {
        passed: transcript.includes(assertion.value),
        actual: transcript.includes(assertion.value) ? assertion.value : "(tool not found)",
      };

    case "tool_not_called":
      return {
        passed: !transcript.includes(assertion.value),
        actual: transcript.includes(assertion.value) ? `found: ${assertion.value}` : "(absent)",
      };

    case "json_path": {
      // Simple key=value check: "status=ok" looks for {"status":"ok"} in transcript
      const eqIdx = assertion.value.indexOf("=");
      if (eqIdx < 0) {
        return { passed: false, actual: "invalid json_path format (expected key=value)" };
      }
      const key = assertion.value.slice(0, eqIdx);
      const expected = assertion.value.slice(eqIdx + 1);
      try {
        const parsed = JSON.parse(transcript);
        const actual = String(parsed[key] ?? "");
        return { passed: actual === expected, actual };
      } catch {
        // Try to find JSON in the transcript
        const jsonMatch = transcript.match(/\{[^}]+\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            const actual = String(parsed[key] ?? "");
            return { passed: actual === expected, actual };
          } catch {
            return { passed: false, actual: "(json parse error)" };
          }
        }
        return { passed: false, actual: "(no json found)" };
      }
    }

    default:
      return { passed: false, actual: `unknown assertion type: ${assertion.type}` };
  }
}

// ---------------------------------------------------------------------------
// Load unit tests from JSON file
// ---------------------------------------------------------------------------

/** Load unit tests from a JSON file. Returns empty array on error. */
export function loadUnitTests(testsPath: string): SkillUnitTest[] {
  try {
    if (!existsSync(testsPath)) {
      console.warn(`[WARN] Unit test file not found: ${testsPath}`);
      return [];
    }
    const raw = readFileSync(testsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[WARN] Unit test file is not an array: ${testsPath}`);
      return [];
    }
    return parsed as SkillUnitTest[];
  } catch (err) {
    console.warn(`[WARN] Failed to load unit tests from ${testsPath}:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Run a single unit test
// ---------------------------------------------------------------------------

/** Agent function type: takes a query, returns transcript text. */
export type AgentRunner = (query: string) => Promise<string>;

/** Run a single unit test against an agent runner. */
export async function runUnitTest(
  test: SkillUnitTest,
  agent: AgentRunner,
): Promise<UnitTestResult> {
  const start = Date.now();

  try {
    const transcript = await agent(test.query);
    const assertionResults = test.assertions.map((assertion) => {
      const result = checkAssertion(assertion, transcript);
      return { assertion, passed: result.passed, actual: result.actual };
    });

    const allPassed = assertionResults.every((r) => r.passed);

    return {
      test_id: test.id,
      passed: allPassed,
      assertion_results: assertionResults,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      test_id: test.id,
      passed: false,
      assertion_results: test.assertions.map((assertion) => ({
        assertion,
        passed: false,
        actual: "error",
      })),
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Run a full unit test suite
// ---------------------------------------------------------------------------

/** Run all unit tests and return aggregated results. */
export async function runUnitTestSuite(
  tests: SkillUnitTest[],
  skillName: string,
  agent: AgentRunner,
): Promise<UnitTestSuiteResult> {
  const results: UnitTestResult[] = [];

  for (const t of tests) {
    const result = await runUnitTest(t, agent);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  return {
    skill_name: skillName,
    total,
    passed,
    failed,
    pass_rate: total > 0 ? passed / total : 0,
    results,
    run_at: new Date().toISOString(),
  };
}
