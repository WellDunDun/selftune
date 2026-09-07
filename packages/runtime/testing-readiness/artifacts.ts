import type { Database } from "bun:sqlite";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Option, Schema } from "effect";
import type {
  canonical_eval_sets,
  unit_test_files,
  unit_test_run_results,
  package_evaluation_reports,
} from "@selftune/local-store/schema";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { getDb } from "../localdb/db.js";
import {
  CreatePackageEvaluationResult,
  CreatePackageEvaluationSummary,
  EvalEntry,
  SkillUnitTest,
  UnitTestSuiteResult,
} from "../types/evaluation.js";

function getConfigDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR || SELFTUNE_CONFIG_DIR;
}

export function getEvalSetDir(): string {
  return join(getConfigDir(), "eval-sets");
}

export function getUnitTestDir(): string {
  return join(getConfigDir(), "unit-tests");
}

export function getPackageEvaluationDir(): string {
  return join(getConfigDir(), "package-evaluations");
}

export function getCanonicalEvalSetPath(skillName: string): string {
  return join(getEvalSetDir(), `${skillName}.json`);
}

function resolveSkillDirectory(skillPath: string): string {
  const absolute = resolve(skillPath);
  return basename(absolute) === "SKILL.md" ? dirname(absolute) : absolute;
}

export function getPackageEvalSetPath(skillPath: string): string {
  return join(resolveSkillDirectory(skillPath), "evals", "routing.json");
}

export function getPackageUnitTestPath(skillPath: string): string {
  return join(resolveSkillDirectory(skillPath), "evals", "evals.json");
}

const PortableEvalCase = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  expected_output: Schema.String,
  files: Schema.Array(Schema.String),
  assertions: Schema.Array(Schema.String),
  selftune_assertions: SkillUnitTest.fields.assertions,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
const PortableEvalFile = Schema.Struct({
  skill_name: Schema.String,
  evals: Schema.Array(PortableEvalCase),
});
type PortableEvalFile = typeof PortableEvalFile.Type;

const EvalSet = Schema.mutable(Schema.Array(EvalEntry));
const UnitTests = Schema.mutable(Schema.Array(SkillUnitTest));

function parseArtifact<A>(schema: Schema.Codec<A>, value: string): A | null {
  return Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(value));
}

function readArtifact<A>(schema: Schema.Codec<A>, path: string): A | null {
  try {
    return parseArtifact(schema, readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function parsePackageEvaluation(value: string): CreatePackageEvaluationSummary | null {
  return parseArtifact(CreatePackageEvaluationSummary, value);
}

export function readPackageEvaluation(path: string): CreatePackageEvaluationSummary | null {
  return readArtifact(CreatePackageEvaluationSummary, path);
}

function describeExpectedOutput(test: SkillUnitTest): string {
  const descriptions = test.assertions
    .map((assertion) => assertion.description?.trim())
    .filter((description): description is string => Boolean(description));
  if (descriptions.length > 0) return descriptions.join("; ");
  return `The result satisfies ${test.assertions.length} objective behavior assertion${test.assertions.length === 1 ? "" : "s"}.`;
}

function toPortableEvalFile(skillName: string, tests: SkillUnitTest[]): PortableEvalFile {
  return {
    skill_name: skillName,
    evals: tests.map((test) => ({
      id: test.id,
      prompt: test.query,
      expected_output: describeExpectedOutput(test),
      files: [],
      assertions: test.assertions.map(
        (assertion) =>
          assertion.description?.trim() ||
          `The output passes the ${assertion.type} check for ${JSON.stringify(assertion.value)}.`,
      ),
      selftune_assertions: test.assertions,
      tags: test.tags,
    })),
  };
}

export function getUnitTestPath(skillName: string): string {
  return join(getUnitTestDir(), `${skillName}.json`);
}

export function getUnitTestResultPath(skillName: string): string {
  return join(getUnitTestDir(), `${skillName}.last-run.json`);
}

export function getCanonicalPackageEvaluationPath(skillName: string): string {
  return join(getPackageEvaluationDir(), `${skillName}.json`);
}

export function getCanonicalPackageEvaluationArtifactPath(skillName: string): string {
  return join(getPackageEvaluationDir(), `${skillName}.artifact.json`);
}

function getOptionalDb(): Database | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function upsertCanonicalEvalSet(db: Database, skillName: string, evalSet: EvalEntry[]): void {
  db.run(
    `INSERT INTO canonical_eval_sets (skill_name, stored_at, eval_set_json)
     VALUES (?, ?, ?)
     ON CONFLICT(skill_name) DO UPDATE SET
       stored_at = excluded.stored_at,
       eval_set_json = excluded.eval_set_json`,
    [skillName, new Date().toISOString(), JSON.stringify(evalSet)],
  );
}

function upsertUnitTestFile(db: Database, skillName: string, tests: SkillUnitTest[]): void {
  db.run(
    `INSERT INTO unit_test_files (skill_name, stored_at, tests_json)
     VALUES (?, ?, ?)
     ON CONFLICT(skill_name) DO UPDATE SET
       stored_at = excluded.stored_at,
       tests_json = excluded.tests_json`,
    [skillName, new Date().toISOString(), JSON.stringify(tests)],
  );
}

function upsertUnitTestRunResult(
  db: Database,
  skillName: string,
  suite: UnitTestSuiteResult,
): void {
  db.run(
    `INSERT INTO unit_test_run_results
      (skill_name, run_at, total, passed, failed, pass_rate, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_name) DO UPDATE SET
       run_at = excluded.run_at,
       total = excluded.total,
       passed = excluded.passed,
       failed = excluded.failed,
       pass_rate = excluded.pass_rate,
       result_json = excluded.result_json`,
    [
      skillName,
      suite.run_at,
      suite.total,
      suite.passed,
      suite.failed,
      suite.pass_rate,
      JSON.stringify(suite),
    ],
  );
}

function upsertPackageEvaluationReport(
  db: Database,
  skillName: string,
  summary: CreatePackageEvaluationSummary,
): void {
  db.run(
    `INSERT INTO package_evaluation_reports (skill_name, stored_at, summary_json)
     VALUES (?, ?, ?)
     ON CONFLICT(skill_name) DO UPDATE SET
       stored_at = excluded.stored_at,
       summary_json = excluded.summary_json`,
    [skillName, new Date().toISOString(), JSON.stringify(summary)],
  );
}

export function readCanonicalEvalSetFromDb(
  db: Database,
  skillName: string,
): { entries: EvalEntry[]; storedAt: string | null } | null {
  const row = db
    .query<Pick<typeof canonical_eval_sets.$inferSelect, "eval_set_json" | "stored_at">, string[]>(
      `SELECT eval_set_json, stored_at
       FROM canonical_eval_sets
       WHERE skill_name = ?`,
    )
    .get(skillName);
  if (!row) return null;
  const entries = parseArtifact(EvalSet, row.eval_set_json);
  if (!entries) return null;
  return {
    entries,
    storedAt: row.stored_at ?? null,
  };
}

export function readUnitTestsFromDb(
  db: Database,
  skillName: string,
): { tests: SkillUnitTest[]; storedAt: string | null } | null {
  const row = db
    .query<Pick<typeof unit_test_files.$inferSelect, "tests_json" | "stored_at">, string[]>(
      `SELECT tests_json, stored_at
       FROM unit_test_files
       WHERE skill_name = ?`,
    )
    .get(skillName);
  if (!row) return null;
  const tests = parseArtifact(UnitTests, row.tests_json);
  if (!tests) return null;
  return {
    tests,
    storedAt: row.stored_at ?? null,
  };
}

export function readUnitTestRunResultFromDb(
  db: Database,
  skillName: string,
): UnitTestSuiteResult | null {
  const row = db
    .query<Pick<typeof unit_test_run_results.$inferSelect, "result_json">, string[]>(
      `SELECT result_json
       FROM unit_test_run_results
       WHERE skill_name = ?`,
    )
    .get(skillName);
  if (!row?.result_json) return null;
  return parseArtifact(UnitTestSuiteResult, row.result_json);
}

export function readPackageEvaluationFromDb(
  db: Database,
  skillName: string,
): { summary: CreatePackageEvaluationSummary; storedAt: string | null } | null {
  const row = db
    .query<
      Pick<typeof package_evaluation_reports.$inferSelect, "summary_json" | "stored_at">,
      string[]
    >(
      `SELECT summary_json, stored_at
       FROM package_evaluation_reports
       WHERE skill_name = ?`,
    )
    .get(skillName);
  if (!row?.summary_json) return null;

  const summary = parsePackageEvaluation(row.summary_json);
  if (!summary) return null;

  return {
    summary,
    storedAt: row.stored_at ?? null,
  };
}

type ArtifactTable =
  | "canonical_eval_sets"
  | "unit_test_files"
  | "unit_test_run_results"
  | "package_evaluation_reports";

export function listStoredSkillNames(db: Database, tableName: ArtifactTable): Set<string> {
  const rows = db.query<{ skill_name: string }, []>(`SELECT skill_name FROM ${tableName}`).all();
  return new Set(rows.map((row) => row.skill_name).filter(Boolean));
}

export function writeCanonicalEvalSet(
  skillName: string,
  evalSet: EvalEntry[],
  packagePath?: string,
): string {
  const path = packagePath
    ? getPackageEvalSetPath(packagePath)
    : getCanonicalEvalSetPath(skillName);
  const db = getOptionalDb();
  if (db) upsertCanonicalEvalSet(db, skillName, evalSet);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(evalSet, null, 2), "utf-8");
  const compatibilityPath = getCanonicalEvalSetPath(skillName);
  if (compatibilityPath !== path) {
    mkdirSync(dirname(compatibilityPath), { recursive: true });
    writeFileSync(compatibilityPath, JSON.stringify(evalSet, null, 2), "utf-8");
  }
  return path;
}

export function writeCanonicalUnitTests(
  skillName: string,
  tests: SkillUnitTest[],
  outputPath?: string,
  packagePath?: string,
): string {
  const canonicalPath = packagePath
    ? getPackageUnitTestPath(packagePath)
    : getUnitTestPath(skillName);
  const db = getOptionalDb();
  if (db) upsertUnitTestFile(db, skillName, tests);
  mkdirSync(dirname(canonicalPath), { recursive: true });
  const canonicalContents = packagePath ? toPortableEvalFile(skillName, tests) : tests;
  writeFileSync(canonicalPath, JSON.stringify(canonicalContents, null, 2), "utf-8");
  const compatibilityPath = getUnitTestPath(skillName);
  if (compatibilityPath !== canonicalPath) {
    mkdirSync(dirname(compatibilityPath), { recursive: true });
    writeFileSync(compatibilityPath, JSON.stringify(tests, null, 2), "utf-8");
  }
  if (outputPath && outputPath !== canonicalPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(tests, null, 2), "utf-8");
    return outputPath;
  }
  return canonicalPath;
}

export function writeUnitTestRunResult(skillName: string, suite: UnitTestSuiteResult): string {
  const db = getOptionalDb();
  if (db) upsertUnitTestRunResult(db, skillName, suite);
  mkdirSync(getUnitTestDir(), { recursive: true });
  const path = getUnitTestResultPath(skillName);
  writeFileSync(path, JSON.stringify(suite, null, 2), "utf-8");
  return path;
}

export function writeCanonicalPackageEvaluation(
  skillName: string,
  summary: CreatePackageEvaluationSummary,
): string {
  const path = getCanonicalPackageEvaluationPath(skillName);
  const db = getOptionalDb();
  if (db) upsertPackageEvaluationReport(db, skillName, summary);
  mkdirSync(getPackageEvaluationDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2), "utf-8");
  return path;
}

export function writeCanonicalPackageEvaluationArtifact(
  skillName: string,
  result: CreatePackageEvaluationResult,
): string {
  const path = getCanonicalPackageEvaluationArtifactPath(skillName);
  mkdirSync(getPackageEvaluationDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2), "utf-8");
  return path;
}

export function readEvalSet(path: string): EvalEntry[] {
  return readArtifact(EvalSet, path) ?? [];
}

export function readUnitTests(path: string): SkillUnitTest[] {
  const contents = readArtifact(Schema.Union([UnitTests, PortableEvalFile]), path);
  if (contents == null) return [];
  if (Array.isArray(contents)) return contents;
  return contents.evals.map((entry) => ({
    id: entry.id,
    skill_name: contents.skill_name,
    query: entry.prompt,
    assertions: entry.selftune_assertions,
    tags: entry.tags ? [...entry.tags] : undefined,
  }));
}

export function readUnitTestResult(path: string): UnitTestSuiteResult | null {
  return readArtifact(UnitTestSuiteResult, path);
}

export function readCanonicalUnitTestRunResult(
  skillName: string,
  db: Database | null = getOptionalDb(),
): UnitTestSuiteResult | null {
  const storedResult = db ? readUnitTestRunResultFromDb(db, skillName) : null;
  if (storedResult) return storedResult;
  return readUnitTestResult(getUnitTestResultPath(skillName));
}

export function readCanonicalPackageEvaluationArtifact(
  skillName: string,
): CreatePackageEvaluationResult | null {
  return readArtifact(
    CreatePackageEvaluationResult,
    getCanonicalPackageEvaluationArtifactPath(skillName),
  );
}
