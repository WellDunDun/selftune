import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readGradingResults,
  readGradingResultsForSkill,
} from "../../packages/runtime/grading/results.js";
import type { GradingResult } from "../../packages/runtime/types.js";

function makeResult(overrides: Partial<GradingResult> = {}): GradingResult {
  return {
    session_id: "sess-1",
    skill_name: "selftune",
    transcript_path: "/tmp/session.jsonl",
    graded_at: "2026-03-12T00:00:00.000Z",
    expectations: [],
    summary: { passed: 3, failed: 1, total: 4, pass_rate: 0.75 },
    execution_metrics: {
      tool_calls: {},
      total_tool_calls: 0,
      total_steps: 0,
      bash_commands_run: 0,
      errors_encountered: 0,
      skills_triggered: [],
      transcript_chars: 0,
    },
    claims: [],
    eval_feedback: { suggestions: [], overall: "" },
    ...overrides,
  };
}

describe("grading result readers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("reads and sorts grading result artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-grading-results-"));
    tempDirs.push(dir);

    writeFileSync(join(dir, "result-b.json"), JSON.stringify(makeResult()), "utf-8");
    writeFileSync(
      join(dir, "result-a.json"),
      JSON.stringify(makeResult({ session_id: "sess-2", graded_at: "2026-03-13T00:00:00.000Z" })),
      "utf-8",
    );
    writeFileSync(join(dir, "ignored.json"), JSON.stringify({ nope: true }), "utf-8");

    const results = readGradingResults(dir);
    expect(results.map((result) => result.session_id)).toEqual(["sess-2", "sess-1"]);
  });

  test("filters grading results by skill name case-insensitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-grading-results-"));
    tempDirs.push(dir);

    writeFileSync(join(dir, "result-1.json"), JSON.stringify(makeResult()), "utf-8");
    writeFileSync(
      join(dir, "result-2.json"),
      JSON.stringify(makeResult({ session_id: "sess-2", skill_name: "Research" })),
      "utf-8",
    );

    const results = readGradingResultsForSkill("SELFTUNE", dir);
    expect(results).toHaveLength(1);
    expect(results[0].skill_name).toBe("selftune");
  });
});
