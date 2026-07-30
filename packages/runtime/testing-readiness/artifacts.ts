import type { Database } from "bun:sqlite";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import type { CreatePackageEvaluationResult } from "../create/package-evaluator.js";
import { getDb } from "../localdb/db.js";
import type {
  CreatePackageEvaluationSummary,
  EvalEntry,
  SkillUnitTest,
  UnitTestSuiteResult,
} from "../types.js";

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

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
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
    .query(
      `SELECT eval_set_json, stored_at
       FROM canonical_eval_sets
       WHERE skill_name = ?`,
    )
    .get(skillName) as { eval_set_json: string; stored_at: string } | null;
  if (!row) return null;
  return {
    entries: parseJsonArray(row.eval_set_json) as EvalEntry[],
    storedAt: row.stored_at ?? null,
  };
}

export function readUnitTestsFromDb(
  db: Database,
  skillName: string,
): { tests: SkillUnitTest[]; storedAt: string | null } | null {
  const row = db
    .query(
      `SELECT tests_json, stored_at
       FROM unit_test_files
       WHERE skill_name = ?`,
    )
    .get(skillName) as { tests_json: string; stored_at: string } | null;
  if (!row) return null;
  return {
    tests: parseJsonArray(row.tests_json) as SkillUnitTest[],
    storedAt: row.stored_at ?? null,
  };
}

export function readUnitTestRunResultFromDb(
  db: Database,
  skillName: string,
): UnitTestSuiteResult | null {
  const row = db
    .query(
      `SELECT result_json
       FROM unit_test_run_results
       WHERE skill_name = ?`,
    )
    .get(skillName) as { result_json: string } | null;
  if (!row?.result_json) return null;
  try {
    const parsed = JSON.parse(row.result_json) as Partial<UnitTestSuiteResult>;
    if (
      typeof parsed !== "object" ||
      parsed == null ||
      typeof parsed.skill_name !== "string" ||
      typeof parsed.total !== "number" ||
      typeof parsed.passed !== "number" ||
      typeof parsed.failed !== "number" ||
      typeof parsed.pass_rate !== "number" ||
      typeof parsed.run_at !== "string"
    ) {
      return null;
    }
    return parsed as UnitTestSuiteResult;
  } catch {
    return null;
  }
}

export function readPackageEvaluationFromDb(
  db: Database,
  skillName: string,
): { summary: CreatePackageEvaluationSummary; storedAt: string | null } | null {
  const row = db
    .query(
      `SELECT summary_json, stored_at
       FROM package_evaluation_reports
       WHERE skill_name = ?`,
    )
    .get(skillName) as { summary_json: string; stored_at: string } | null;
  if (!row?.summary_json) return null;

  const parsed = parseJsonObject(row.summary_json);
  if (
    !parsed ||
    typeof parsed["skill_name"] !== "string" ||
    typeof parsed["status"] !== "string" ||
    typeof parsed["evaluation_passed"] !== "boolean"
  ) {
    return null;
  }

  return {
    summary: parsed as unknown as CreatePackageEvaluationSummary,
    storedAt: row.stored_at ?? null,
  };
}

export function listStoredSkillNames(db: Database, tableName: string): Set<string> {
  const rows = db.query(`SELECT skill_name FROM ${tableName}`).all() as Array<{
    skill_name: string;
  }>;
  return new Set(rows.map((row) => row.skill_name).filter(Boolean));
}

export function writeCanonicalEvalSet(skillName: string, evalSet: EvalEntry[]): string {
  const path = getCanonicalEvalSetPath(skillName);
  const db = getOptionalDb();
  if (db) upsertCanonicalEvalSet(db, skillName, evalSet);
  mkdirSync(getEvalSetDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(evalSet, null, 2), "utf-8");
  return path;
}

export function writeCanonicalUnitTests(
  skillName: string,
  tests: SkillUnitTest[],
  outputPath?: string,
): string {
  const canonicalPath = getUnitTestPath(skillName);
  const db = getOptionalDb();
  if (db) upsertUnitTestFile(db, skillName, tests);
  mkdirSync(getUnitTestDir(), { recursive: true });
  writeFileSync(canonicalPath, JSON.stringify(tests, null, 2), "utf-8");
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

export function readJsonArrayFile(path: string): unknown[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readUnitTestResult(path: string): UnitTestSuiteResult | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<UnitTestSuiteResult>;
    if (typeof parsed !== "object" || parsed == null) return null;
    if (
      typeof parsed.skill_name !== "string" ||
      typeof parsed.total !== "number" ||
      typeof parsed.passed !== "number" ||
      typeof parsed.failed !== "number" ||
      typeof parsed.pass_rate !== "number" ||
      typeof parsed.run_at !== "string"
    ) {
      return null;
    }
    return parsed as UnitTestSuiteResult;
  } catch {
    return null;
  }
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
  try {
    const path = getCanonicalPackageEvaluationArtifactPath(skillName);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<CreatePackageEvaluationResult>;
    if (
      typeof parsed !== "object" ||
      parsed == null ||
      typeof parsed.summary !== "object" ||
      parsed.summary == null ||
      typeof parsed.replay !== "object" ||
      parsed.replay == null ||
      typeof parsed.baseline !== "object" ||
      parsed.baseline == null
    ) {
      return null;
    }
    if (
      typeof parsed.summary.skill_name !== "string" ||
      typeof parsed.summary.status !== "string" ||
      typeof parsed.summary.evaluation_passed !== "boolean" ||
      typeof parsed.replay.skill !== "string" ||
      typeof parsed.baseline.skill_name !== "string"
    ) {
      return null;
    }
    return parsed as CreatePackageEvaluationResult;
  } catch {
    return null;
  }
}
