import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAssertion,
  loadUnitTests,
  runUnitTest,
  runUnitTestSuite,
} from "../../cli/selftune/eval/unit-test.js";
import type { SkillAssertion, SkillUnitTest } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// checkAssertion — deterministic assertion logic
// ---------------------------------------------------------------------------
describe("checkAssertion", () => {
  test("contains: passes when transcript includes value", () => {
    const assertion: SkillAssertion = { type: "contains", value: "hello world" };
    const result = checkAssertion(assertion, "some text hello world more text");
    expect(result.passed).toBe(true);
  });

  test("contains: fails when transcript does not include value", () => {
    const assertion: SkillAssertion = { type: "contains", value: "missing" };
    const result = checkAssertion(assertion, "some text hello world");
    expect(result.passed).toBe(false);
  });

  test("not_contains: passes when transcript does not include value", () => {
    const assertion: SkillAssertion = { type: "not_contains", value: "missing" };
    const result = checkAssertion(assertion, "some text hello world");
    expect(result.passed).toBe(true);
  });

  test("not_contains: fails when transcript includes value", () => {
    const assertion: SkillAssertion = { type: "not_contains", value: "hello" };
    const result = checkAssertion(assertion, "some text hello world");
    expect(result.passed).toBe(false);
  });

  test("regex: passes when pattern matches transcript", () => {
    const assertion: SkillAssertion = { type: "regex", value: "hello\\s+world" };
    const result = checkAssertion(assertion, "some text hello   world more text");
    expect(result.passed).toBe(true);
  });

  test("regex: fails when pattern does not match", () => {
    const assertion: SkillAssertion = { type: "regex", value: "^exact$" };
    const result = checkAssertion(assertion, "not exact match");
    expect(result.passed).toBe(false);
  });

  test("tool_called: passes when tool name appears in transcript", () => {
    const assertion: SkillAssertion = { type: "tool_called", value: "Bash" };
    const transcript = JSON.stringify({ tool_name: "Bash", tool_input: {} });
    const result = checkAssertion(assertion, transcript);
    expect(result.passed).toBe(true);
  });

  test("tool_called: fails when tool name not in transcript", () => {
    const assertion: SkillAssertion = { type: "tool_called", value: "Write" };
    const transcript = JSON.stringify({ tool_name: "Bash", tool_input: {} });
    const result = checkAssertion(assertion, transcript);
    expect(result.passed).toBe(false);
  });

  test("tool_not_called: passes when tool name not in transcript", () => {
    const assertion: SkillAssertion = { type: "tool_not_called", value: "Write" };
    const transcript = "some output without that tool";
    const result = checkAssertion(assertion, transcript);
    expect(result.passed).toBe(true);
  });

  test("tool_not_called: fails when tool name in transcript", () => {
    const assertion: SkillAssertion = {
      type: "tool_not_called",
      value: "Bash",
    };
    const transcript = JSON.stringify({ tool_name: "Bash" });
    const result = checkAssertion(assertion, transcript);
    expect(result.passed).toBe(false);
  });

  test("json_path: passes when JSON path value found in transcript", () => {
    const assertion: SkillAssertion = { type: "json_path", value: "status=ok" };
    const transcript = JSON.stringify({ status: "ok", data: [1, 2, 3] });
    const result = checkAssertion(assertion, transcript);
    expect(result.passed).toBe(true);
  });

  test("json_path: fails when JSON path value not found", () => {
    const assertion: SkillAssertion = { type: "json_path", value: "status=error" };
    const transcript = JSON.stringify({ status: "ok" });
    const result = checkAssertion(assertion, transcript);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadUnitTests — JSON loading
// ---------------------------------------------------------------------------
describe("loadUnitTests", () => {
  let tmpDir: string;

  test("loads valid unit test JSON file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "selftune-unit-test-"));
    const tests: SkillUnitTest[] = [
      {
        id: "test-1",
        skill_name: "pptx",
        query: "make slides",
        assertions: [{ type: "contains", value: "slides" }],
      },
      {
        id: "test-2",
        skill_name: "pptx",
        query: "create a presentation",
        assertions: [{ type: "tool_called", value: "Write" }],
        tags: ["smoke"],
      },
    ];
    const filePath = join(tmpDir, "tests.json");
    writeFileSync(filePath, JSON.stringify(tests, null, 2));
    const loaded = loadUnitTests(filePath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("test-1");
    expect(loaded[1].tags).toEqual(["smoke"]);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for missing file", () => {
    const loaded = loadUnitTests("/nonexistent/path/tests.json");
    expect(loaded).toEqual([]);
  });

  test("returns empty array for invalid JSON", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "selftune-unit-test-"));
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "not valid json {{{");
    const loaded = loadUnitTests(filePath);
    expect(loaded).toEqual([]);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runUnitTest — mock agent, verify assertion logic
// ---------------------------------------------------------------------------
describe("runUnitTest", () => {
  const testCase: SkillUnitTest = {
    id: "test-contains",
    skill_name: "pptx",
    query: "make slides",
    assertions: [
      { type: "contains", value: "presentation" },
      { type: "not_contains", value: "error" },
    ],
  };

  test("passes when all assertions match the mock transcript", async () => {
    const mockAgent = async (_query: string): Promise<string> =>
      "Here is your presentation output with no issues";

    const result = await runUnitTest(testCase, mockAgent);
    expect(result.test_id).toBe("test-contains");
    expect(result.passed).toBe(true);
    expect(result.assertion_results).toHaveLength(2);
    expect(result.assertion_results[0].passed).toBe(true);
    expect(result.assertion_results[1].passed).toBe(true);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("fails when an assertion does not match", async () => {
    const mockAgent = async (_query: string): Promise<string> => "error: something went wrong";

    const result = await runUnitTest(testCase, mockAgent);
    expect(result.passed).toBe(false);
    // "contains presentation" should fail, "not_contains error" should fail
    expect(result.assertion_results[0].passed).toBe(false);
    expect(result.assertion_results[1].passed).toBe(false);
  });

  test("handles agent errors gracefully", async () => {
    const mockAgent = async (_query: string): Promise<string> => {
      throw new Error("Agent crashed");
    };

    const result = await runUnitTest(testCase, mockAgent);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Agent crashed");
  });
});

// ---------------------------------------------------------------------------
// runUnitTestSuite — suite aggregation
// ---------------------------------------------------------------------------
describe("runUnitTestSuite", () => {
  test("aggregates results from multiple tests", async () => {
    const tests: SkillUnitTest[] = [
      {
        id: "t1",
        skill_name: "pptx",
        query: "make slides",
        assertions: [{ type: "contains", value: "ok" }],
      },
      {
        id: "t2",
        skill_name: "pptx",
        query: "do something",
        assertions: [{ type: "contains", value: "missing-value" }],
      },
      {
        id: "t3",
        skill_name: "pptx",
        query: "another test",
        assertions: [{ type: "not_contains", value: "bad" }],
      },
    ];

    const mockAgent = async (_query: string): Promise<string> => "ok output here";

    const suite = await runUnitTestSuite(tests, "pptx", mockAgent);
    expect(suite.skill_name).toBe("pptx");
    expect(suite.total).toBe(3);
    expect(suite.passed).toBe(2); // t1 passes (contains "ok"), t2 fails (no "missing-value"), t3 passes (no "bad")
    expect(suite.failed).toBe(1);
    expect(suite.pass_rate).toBeCloseTo(2 / 3, 2);
    expect(suite.results).toHaveLength(3);
    expect(suite.run_at).toBeTruthy();
  });

  test("handles empty test suite", async () => {
    const mockAgent = async (_query: string): Promise<string> => "output";

    const suite = await runUnitTestSuite([], "pptx", mockAgent);
    expect(suite.total).toBe(0);
    expect(suite.passed).toBe(0);
    expect(suite.failed).toBe(0);
    expect(suite.pass_rate).toBe(0);
  });
});
