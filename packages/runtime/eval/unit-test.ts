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

import * as Schema from "effect/Schema";

import type {
  SkillAssertion,
  SkillUnitTest,
  UnitTestResult,
  UnitTestSuiteResult,
} from "../types.js";

const AssertionSchema = Schema.Struct({
  type: Schema.Literals([
    "contains",
    "not_contains",
    "regex",
    "json_path",
    "tool_called",
    "tool_not_called",
  ]),
  value: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
const AssertionsSchema = Schema.mutable(Schema.Array(AssertionSchema));
const TagsSchema = Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)));
const UnitTestSchema = Schema.Struct({
  id: Schema.String,
  skill_name: Schema.String,
  query: Schema.String,
  assertions: AssertionsSchema,
  timeout_ms: Schema.optionalKey(Schema.Number),
  tags: TagsSchema,
});
const PortableTestsSchema = Schema.Struct({
  skill_name: Schema.String,
  evals: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      prompt: Schema.String,
      selftune_assertions: Schema.optionalKey(AssertionsSchema),
      tags: TagsSchema,
    }),
  ),
});
const decodeTestFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([Schema.mutable(Schema.Array(UnitTestSchema)), PortableTestsSchema]),
  ),
);
const decodeTranscriptObject = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
type AssertionCheck = Pick<UnitTestResult["assertion_results"][number], "passed" | "actual">;

// ---------------------------------------------------------------------------
// Assertion checker (deterministic, no agent needed)
// ---------------------------------------------------------------------------

/** Check a single assertion against a transcript string. */
export function checkAssertion(assertion: SkillAssertion, transcript: string): AssertionCheck {
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
        const parsed = decodeTranscriptObject(transcript);
        const actual = String(Object.hasOwn(parsed, key) ? (parsed[key] ?? "") : "");
        return { passed: actual === expected, actual };
      } catch {
        // Try to find JSON in the transcript
        const jsonMatch = transcript.match(/\{[^}]+\}/);
        if (jsonMatch) {
          try {
            const parsed = decodeTranscriptObject(jsonMatch[0]);
            const actual = String(Object.hasOwn(parsed, key) ? (parsed[key] ?? "") : "");
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
    const parsed = decodeTestFile(raw);
    if ("evals" in parsed) {
      const skillName = parsed.skill_name;
      return parsed.evals.flatMap((entry, index): SkillUnitTest[] => {
        if (entry.selftune_assertions === undefined) return [];
        const test: SkillUnitTest = {
          id: entry.id === undefined ? `eval-${index + 1}` : String(entry.id),
          skill_name: skillName,
          query: entry.prompt,
          assertions: entry.selftune_assertions,
        };
        if (entry.tags !== undefined) test.tags = entry.tags;
        return [test];
      });
    }
    return parsed;
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
