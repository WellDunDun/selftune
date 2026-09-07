import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setTestDb, openDb } from "../../packages/runtime/localdb/db.js";
import {
  loadCreateEvalSet,
  summarizeReplayRuntimeMetrics,
} from "../../packages/runtime/create/replay.js";
import type {
  CreatePackageEvaluationResult,
  SkillUnitTest,
  UnitTestSuiteResult,
} from "../../packages/runtime/types/evaluation.js";
import {
  getCanonicalPackageEvaluationArtifactPath,
  readCanonicalEvalSetFromDb,
  readCanonicalPackageEvaluationArtifact,
  readCanonicalUnitTestRunResult,
  readEvalSet,
  readPackageEvaluationFromDb,
  readUnitTestRunResultFromDb,
  readUnitTests,
  readUnitTestsFromDb,
  writeCanonicalEvalSet,
  writeCanonicalPackageEvaluation,
  writeCanonicalPackageEvaluationArtifact,
  writeCanonicalUnitTests,
  writeUnitTestRunResult,
} from "../../packages/runtime/testing-readiness/artifacts.js";

let db: Database;
let directory: string;
let previousConfig: string | undefined;
const skillName = "marketing";
const timestamp = "2026-09-05T00:00:00Z";
const tests: SkillUnitTest[] = [
  {
    id: "campaign",
    skill_name: skillName,
    query: "write a campaign",
    assertions: [{ type: "contains", value: "campaign" }],
    tags: ["copy"],
  },
];
const suite: UnitTestSuiteResult = {
  skill_name: skillName,
  total: 1,
  passed: 1,
  failed: 0,
  pass_rate: 1,
  run_at: timestamp,
  results: [{ test_id: "campaign", passed: true, assertion_results: [], duration_ms: 12 }],
};

function evaluation(): CreatePackageEvaluationResult {
  const metrics = summarizeReplayRuntimeMetrics([]);
  return {
    summary: {
      skill_name: skillName,
      skill_path: "/skills/marketing/SKILL.md",
      mode: "package",
      status: "passed",
      evaluation_passed: true,
      next_command: null,
      replay: {
        mode: "package",
        validation_mode: "host_replay",
        agent: "codex",
        proposal_id: "proposal",
        fixture_id: "fixture",
        total: 0,
        passed: 0,
        failed: 0,
        pass_rate: 0,
        runtime_metrics: metrics,
      },
      baseline: {
        mode: "package",
        baseline_pass_rate: 0,
        with_skill_pass_rate: 0,
        lift: 0,
        adds_value: false,
        measured_at: timestamp,
      },
    },
    replay: {
      skill: skillName,
      skill_path: "/skills/marketing/SKILL.md",
      mode: "package",
      agent: "codex",
      proposal_id: "proposal",
      fixture_id: "fixture",
      total: 0,
      passed: 0,
      failed: 0,
      pass_rate: 0,
      results: [],
      runtime_metrics: metrics,
    },
    baseline: {
      skill_name: skillName,
      mode: "package",
      baseline_pass_rate: 0,
      with_skill_pass_rate: 0,
      lift: 0,
      adds_value: false,
      per_entry: [],
      measured_at: timestamp,
    },
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  _setTestDb(db);
  directory = mkdtempSync(join(tmpdir(), "selftune-artifact-boundary-"));
  previousConfig = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = directory;
});

afterEach(() => {
  _setTestDb(null);
  db.close();
  if (previousConfig === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = previousConfig;
  rmSync(directory, { recursive: true, force: true });
});

describe("evaluation artifact boundaries", () => {
  test("round-trips routing entries through files and SQLite", () => {
    const entries = [{ query: "write a campaign", should_trigger: true }];
    const path = writeCanonicalEvalSet(skillName, entries);
    expect(readEvalSet(path)).toEqual(entries);
    expect(loadCreateEvalSet(skillName, path)).toEqual(entries);
    expect(readCanonicalEvalSetFromDb(db, skillName)?.entries).toEqual(entries);
  });

  test.each([
    { content: "null" },
    { content: "[null]" },
    { content: "{" },
    { content: '[{"query":"write a campaign","should_trigger":"yes"}]' },
    { content: '{"evals":[{"prompt":"not a routing eval"}]}' },
  ])("rejects malformed routing data: $content", ({ content }) => {
    const path = writeCanonicalEvalSet(skillName, []);
    writeFileSync(path, content);
    db.run("UPDATE canonical_eval_sets SET eval_set_json = ? WHERE skill_name = ?", [
      content,
      skillName,
    ]);
    expect(readEvalSet(path)).toEqual([]);
    expect(readCanonicalEvalSetFromDb(db, skillName)).toBeNull();
    expect(() => loadCreateEvalSet(skillName, path)).toThrow("invalid");
  });

  test("round-trips native and portable unit-test files without losing assertions or tags", () => {
    const nativePath = writeCanonicalUnitTests(skillName, tests);
    expect(readUnitTests(nativePath)).toEqual(tests);
    const portablePath = writeCanonicalUnitTests(
      skillName,
      tests,
      undefined,
      join(directory, "skill", "SKILL.md"),
    );
    expect(readUnitTests(portablePath)).toEqual(tests);
    expect(readUnitTestsFromDb(db, skillName)?.tests).toEqual(tests);
  });

  test("does not count malformed unit-test cases as coverage", () => {
    const path = writeCanonicalUnitTests(skillName, tests);
    const content = JSON.stringify([
      { ...tests[0], assertions: [{ type: "made_up", value: "x" }] },
    ]);
    writeFileSync(path, content);
    db.run("UPDATE unit_test_files SET tests_json = ? WHERE skill_name = ?", [content, skillName]);
    expect(readUnitTests(path)).toEqual([]);
    expect(readUnitTestsFromDb(db, skillName)).toBeNull();
  });

  test("rejects malformed nested run results and can recover from a valid local file", () => {
    const path = writeUnitTestRunResult(skillName, suite);
    expect(readUnitTestRunResultFromDb(db, skillName)).toEqual(suite);
    const malformed = JSON.stringify({ ...suite, results: [{ passed: true }] });
    db.run("UPDATE unit_test_run_results SET result_json = ? WHERE skill_name = ?", [
      malformed,
      skillName,
    ]);
    expect(readUnitTestRunResultFromDb(db, skillName)).toBeNull();
    expect(readCanonicalUnitTestRunResult(skillName, db)).toEqual(suite);
    writeFileSync(path, malformed);
    expect(readCanonicalUnitTestRunResult(skillName, db)).toBeNull();
  });

  test("round-trips a complete package artifact and rejects invalid nested baseline entries", () => {
    const result = evaluation();
    const path = writeCanonicalPackageEvaluationArtifact(skillName, result);
    expect(readCanonicalPackageEvaluationArtifact(skillName)).toEqual(result);
    writeFileSync(
      path,
      JSON.stringify({ ...result, baseline: { ...result.baseline, per_entry: [null] } }),
    );
    expect(readCanonicalPackageEvaluationArtifact(skillName)).toBeNull();
  });

  test("rejects a purported passing summary with no measured replay or baseline", () => {
    const result = evaluation();
    writeCanonicalPackageEvaluation(skillName, result.summary);
    expect(readPackageEvaluationFromDb(db, skillName)?.summary).toEqual(result.summary);
    const incomplete = { skill_name: skillName, status: "passed", evaluation_passed: true };
    db.run("UPDATE package_evaluation_reports SET summary_json = ? WHERE skill_name = ?", [
      JSON.stringify(incomplete),
      skillName,
    ]);
    expect(readPackageEvaluationFromDb(db, skillName)).toBeNull();
    writeCanonicalPackageEvaluationArtifact(skillName, result);
    writeFileSync(
      getCanonicalPackageEvaluationArtifactPath(skillName),
      JSON.stringify({
        summary: incomplete,
        replay: { skill: skillName },
        baseline: { skill_name: skillName },
      }),
    );
    expect(readCanonicalPackageEvaluationArtifact(skillName)).toBeNull();
  });
});
