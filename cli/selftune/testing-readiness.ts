import type { Database } from "bun:sqlite";

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  CreatorLoopNextStep,
  CreatorTestingOverview,
  DeploymentReadiness,
  SkillEvalReadiness,
  SkillTestingReadiness,
} from "./dashboard-contract.js";
import type { EvalEntry, UnitTestSuiteResult } from "./types.js";
import { queryEvolutionEvidence } from "./localdb/queries/evolution.js";
import { queryTrustedSkillObservationRows } from "./localdb/queries/trust.js";
import {
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "./utils/skill-discovery.js";

interface TrustedSkillObservationSummary {
  session_id: string;
  triggered: number;
}

interface TestingReadinessContext {
  knownSkills: Set<string>;
  searchDirs: string[];
  trustedRowsBySkill: Map<string, TrustedSkillObservationSummary[]>;
  evalEvidenceBySkill: Map<string, { count: number; latestAt: string | null }>;
  fallbackSkillPathBySkill: Map<string, string>;
  replayBySkill: Map<string, { check_count: number; latest_validation_mode: string | null }>;
  baselineBySkill: Map<
    string,
    { sample_size: number; pass_rate: number | null; measured_at: string | null }
  >;
  latestEvolutionBySkill: Map<string, { action: string | null; timestamp: string | null }>;
}

function getConfigDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR || SELFTUNE_CONFIG_DIR;
}

function getEvalSetDir(): string {
  return join(getConfigDir(), "eval-sets");
}

function getUnitTestDir(): string {
  return join(getConfigDir(), "unit-tests");
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

export function writeCanonicalEvalSet(skillName: string, evalSet: EvalEntry[]): string {
  mkdirSync(getEvalSetDir(), { recursive: true });
  const path = getCanonicalEvalSetPath(skillName);
  writeFileSync(path, JSON.stringify(evalSet, null, 2), "utf-8");
  return path;
}

export function writeUnitTestRunResult(skillName: string, suite: UnitTestSuiteResult): string {
  mkdirSync(getUnitTestDir(), { recursive: true });
  const path = getUnitTestResultPath(skillName);
  writeFileSync(path, JSON.stringify(suite, null, 2), "utf-8");
  return path;
}

function readJsonArrayFile(path: string): unknown[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readUnitTestResult(path: string): UnitTestSuiteResult | null {
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

function getSkillSearchDirs(): string[] {
  const cwd = process.cwd();
  const homeDir = process.env.HOME ?? "";
  const codexHome = process.env.CODEX_HOME ?? `${homeDir}/.codex`;
  return [
    ...findRepositorySkillDirs(cwd),
    ...findRepositoryClaudeSkillDirs(cwd),
    `${homeDir}/.agents/skills`,
    `${homeDir}/.claude/skills`,
    `${codexHome}/skills`,
  ];
}

function scanSkillNamesFromDir(
  dir: string,
  matcher: (entryName: string) => string | null,
): Set<string> {
  const names = new Set<string>();
  if (!existsSync(dir)) return names;
  try {
    for (const entry of readdirSync(dir)) {
      const name = matcher(entry);
      if (name) names.add(name);
    }
  } catch {
    return names;
  }
  return names;
}

function deriveEvalReadiness(
  skillPath: string | null,
  trustedTriggerCount: number,
): SkillEvalReadiness {
  if (trustedTriggerCount > 0) return "log_ready";
  if (skillPath) return "cold_start_ready";
  return "telemetry_only";
}

function formatSkillPathArg(skillPath: string | null, skillName: string): string {
  return skillPath ?? `/path/to/skills/${skillName}/SKILL.md`;
}

function recommendCommand(
  skillName: string,
  skillPath: string | null,
  nextStep: CreatorLoopNextStep,
): string {
  const pathArg = formatSkillPathArg(skillPath, skillName);
  switch (nextStep) {
    case "generate_evals":
      return skillPath
        ? `selftune eval generate --skill ${skillName} --auto-synthetic --skill-path ${pathArg}`
        : `selftune eval generate --skill ${skillName} --skill-path ${pathArg}`;
    case "run_unit_tests":
      return `selftune eval unit-test --skill ${skillName} --generate --skill-path ${pathArg}`;
    case "run_replay_dry_run":
      return `selftune evolve --skill ${skillName} --skill-path ${pathArg} --dry-run --validation-mode replay`;
    case "measure_baseline":
      return `selftune grade baseline --skill ${skillName} --skill-path ${pathArg}`;
    case "deploy_candidate":
      return `selftune evolve --skill ${skillName} --skill-path ${pathArg} --with-baseline`;
    case "watch_deployment":
      return `selftune watch --skill ${skillName}`;
  }
}

function summarizeReadiness(
  nextStep: CreatorLoopNextStep,
  evalReadiness: SkillEvalReadiness,
  evalSetEntries: number,
  unitTestCases: number,
  replayCheckCount: number,
  baselineSampleSize: number,
  unitTestPassRate: number | null,
): string {
  switch (nextStep) {
    case "generate_evals":
      if (evalReadiness === "log_ready") {
        return "Trusted telemetry exists, but no canonical eval set is saved yet.";
      }
      if (evalReadiness === "cold_start_ready") {
        return "Installed locally but still cold-start. Generate synthetic evals before you evolve it.";
      }
      return "Telemetry exists, but selftune cannot resolve a local SKILL.md yet. Point it at the skill and generate evals.";
    case "run_unit_tests":
      return `Eval coverage is present (${evalSetEntries} entries), but no unit test file is saved yet.`;
    case "run_replay_dry_run": {
      const passRateText =
        unitTestPassRate != null
          ? ` Last unit-test run passed ${Math.round(unitTestPassRate * 100)}%.`
          : "";
      return `Unit tests are present (${unitTestCases} cases), but replay-backed dry-run validation has not been recorded yet.${passRateText}`;
    }
    case "measure_baseline":
      return `Replay-backed validation exists (${replayCheckCount} recorded checks), but no stored no-skill baseline exists yet.`;
    case "deploy_candidate":
      return `Evals, unit tests, replay validation, and a baseline are all present. Ready to run a live evolve and deploy a watched candidate.${baselineSampleSize > 0 ? ` Latest baseline used ${baselineSampleSize} samples.` : ""}`;
    case "watch_deployment":
      return `A candidate has already been deployed for this skill. Keep watching live traffic and baseline lift before making another mutation.${baselineSampleSize > 0 ? ` Latest baseline used ${baselineSampleSize} samples.` : ""}`;
  }
}

function nextStepPriority(step: CreatorLoopNextStep): number {
  switch (step) {
    case "generate_evals":
      return 0;
    case "run_unit_tests":
      return 1;
    case "run_replay_dry_run":
      return 2;
    case "measure_baseline":
      return 3;
    case "deploy_candidate":
      return 4;
    case "watch_deployment":
      return 5;
  }
}

function deriveDeploymentReadiness(
  nextStep: CreatorLoopNextStep,
  latestEvolutionAction: string | null,
): DeploymentReadiness {
  if (nextStep !== "deploy_candidate" && nextStep !== "watch_deployment") {
    return "blocked";
  }
  if (latestEvolutionAction === "rolled_back") {
    return "rolled_back";
  }
  if (nextStep === "watch_deployment" || latestEvolutionAction === "deployed") {
    return "watching";
  }
  return "ready_to_deploy";
}

function summarizeDeploymentReadiness(
  deploymentReadiness: DeploymentReadiness,
  skillName: string,
  skillPath: string | null,
): { summary: string; command: string | null } {
  const pathArg = formatSkillPathArg(skillPath, skillName);
  switch (deploymentReadiness) {
    case "blocked":
      return {
        summary: "Finish the creator test loop before shipping this skill.",
        command: null,
      };
    case "ready_to_deploy":
      return {
        summary:
          "Tests and baseline are in place. Run a live evolve so selftune can validate and deploy the strongest candidate.",
        command: `selftune evolve --skill ${skillName} --skill-path ${pathArg} --with-baseline`,
      };
    case "watching":
      return {
        summary:
          "A candidate is already deployed. Keep watching live trigger behavior and baseline lift before making another mutation.",
        command: `selftune watch --skill ${skillName}`,
      };
    case "rolled_back":
      return {
        summary:
          "The last deployment rolled back. Review the failure evidence, rerun a replay dry-run if needed, then redeploy once the candidate is trustworthy again.",
        command: `selftune evolve --skill ${skillName} --skill-path ${pathArg} --dry-run --validation-mode replay`,
      };
  }
}

export function listSkillTestingReadiness(
  db: Database,
  searchDirs: string[] = getSkillSearchDirs(),
): SkillTestingReadiness[] {
  const context = buildTestingReadinessContext(db, searchDirs);

  return [...context.knownSkills]
    .sort((a, b) => a.localeCompare(b))
    .map((skillName) => buildSkillTestingReadinessRow(skillName, context))
    .filter((row): row is SkillTestingReadiness => row != null)
    .sort((a, b) => {
      const priorityDiff = nextStepPriority(a.next_step) - nextStepPriority(b.next_step);
      if (priorityDiff !== 0) return priorityDiff;
      const trustedDiff = b.trusted_session_count - a.trusted_session_count;
      if (trustedDiff !== 0) return trustedDiff;
      return a.skill_name.localeCompare(b.skill_name);
    });
}

export function getSkillTestingReadiness(
  db: Database,
  skillName: string,
  searchDirs: string[] = getSkillSearchDirs(),
): SkillTestingReadiness | null {
  return buildSkillTestingReadinessRow(skillName, buildTestingReadinessContext(db, searchDirs));
}

function buildTestingReadinessContext(db: Database, searchDirs: string[]): TestingReadinessContext {
  const trustedRows = queryTrustedSkillObservationRows(db);
  const trustedRowsBySkill = new Map<string, TrustedSkillObservationSummary[]>();

  for (const row of trustedRows) {
    const existing = trustedRowsBySkill.get(row.skill_name);
    const compact = { session_id: row.session_id, triggered: row.triggered };
    if (existing) existing.push(compact);
    else trustedRowsBySkill.set(row.skill_name, [compact]);
  }

  const installedNames = findInstalledSkillNames(searchDirs);
  const unitTestDir = getUnitTestDir();
  const evalSetDir = getEvalSetDir();
  const unitTestNames = scanSkillNamesFromDir(unitTestDir, (entry) => {
    if (!entry.endsWith(".json") || entry.endsWith(".last-run.json")) return null;
    return entry.slice(0, -".json".length);
  });
  const unitTestResultNames = scanSkillNamesFromDir(unitTestDir, (entry) => {
    if (!entry.endsWith(".last-run.json")) return null;
    return entry.slice(0, -".last-run.json".length);
  });
  const canonicalEvalNames = scanSkillNamesFromDir(evalSetDir, (entry) => {
    if (!entry.endsWith(".json")) return null;
    return entry.slice(0, -".json".length);
  });

  const evidenceRows = queryEvolutionEvidence(db);
  const evalEvidenceBySkill = new Map<string, { count: number; latestAt: string | null }>();
  const fallbackSkillPathBySkill = new Map<string, string>();
  for (const row of evidenceRows) {
    if (row.eval_set && row.eval_set.length > 0 && !evalEvidenceBySkill.has(row.skill_name)) {
      evalEvidenceBySkill.set(row.skill_name, {
        count: row.eval_set.length,
        latestAt: row.timestamp,
      });
    }
    if (row.skill_path && !fallbackSkillPathBySkill.has(row.skill_name)) {
      fallbackSkillPathBySkill.set(row.skill_name, row.skill_path);
    }
  }

  const replayRows = db
    .query(
      `SELECT skill_name, validation_mode, COUNT(*) AS check_count, MAX(id) AS latest_id
       FROM replay_entry_results
       GROUP BY skill_name, validation_mode
       ORDER BY latest_id DESC`,
    )
    .all() as Array<{
    skill_name: string;
    validation_mode: string;
    check_count: number;
    latest_id: number;
  }>;
  const replayBySkill = new Map<
    string,
    { check_count: number; latest_validation_mode: string | null }
  >();
  for (const row of replayRows) {
    const existing = replayBySkill.get(row.skill_name);
    if (existing) {
      existing.check_count += row.check_count;
      continue;
    }
    replayBySkill.set(row.skill_name, {
      check_count: row.check_count,
      latest_validation_mode: row.validation_mode ?? null,
    });
  }

  const baselineRows = db
    .query(
      `SELECT skill_name, pass_rate, sample_size, measured_at
       FROM grading_baselines
       ORDER BY measured_at DESC`,
    )
    .all() as Array<{
    skill_name: string;
    pass_rate: number;
    sample_size: number;
    measured_at: string;
  }>;
  const baselineBySkill = new Map<
    string,
    { sample_size: number; pass_rate: number | null; measured_at: string | null }
  >();
  for (const row of baselineRows) {
    if (baselineBySkill.has(row.skill_name)) continue;
    baselineBySkill.set(row.skill_name, {
      sample_size: row.sample_size,
      pass_rate: row.pass_rate,
      measured_at: row.measured_at,
    });
  }

  const latestEvolutionRows = db
    .query(
      `SELECT skill_name, action, timestamp
       FROM evolution_audit
       WHERE skill_name IS NOT NULL
       ORDER BY timestamp DESC`,
    )
    .all() as Array<{
    skill_name: string;
    action: string;
    timestamp: string;
  }>;
  const latestEvolutionBySkill = new Map<
    string,
    { action: string | null; timestamp: string | null }
  >();
  for (const row of latestEvolutionRows) {
    if (latestEvolutionBySkill.has(row.skill_name)) continue;
    latestEvolutionBySkill.set(row.skill_name, {
      action: row.action,
      timestamp: row.timestamp,
    });
  }

  const latestSkillPathRows = db
    .query(
      `SELECT skill_name, skill_path
       FROM skill_invocations
       WHERE skill_path IS NOT NULL AND skill_path != ''
       ORDER BY occurred_at DESC`,
    )
    .all() as Array<{ skill_name: string; skill_path: string }>;
  for (const row of latestSkillPathRows) {
    if (!fallbackSkillPathBySkill.has(row.skill_name)) {
      fallbackSkillPathBySkill.set(row.skill_name, row.skill_path);
    }
  }

  const knownSkills = new Set<string>([
    ...trustedRowsBySkill.keys(),
    ...installedNames,
    ...unitTestNames,
    ...unitTestResultNames,
    ...canonicalEvalNames,
    ...evalEvidenceBySkill.keys(),
    ...replayBySkill.keys(),
    ...baselineBySkill.keys(),
    ...fallbackSkillPathBySkill.keys(),
  ]);

  return {
    knownSkills,
    searchDirs,
    trustedRowsBySkill,
    evalEvidenceBySkill,
    fallbackSkillPathBySkill,
    replayBySkill,
    baselineBySkill,
    latestEvolutionBySkill,
  };
}

function buildSkillTestingReadinessRow(
  skillName: string,
  context: TestingReadinessContext,
): SkillTestingReadiness | null {
  const trustRows = context.trustedRowsBySkill.get(skillName) ?? [];
  const trustedTriggerCount = trustRows.filter((row) => row.triggered === 1).length;
  const trustedSessionCount = new Set(trustRows.map((row) => row.session_id)).size;

  const installedSkillPath = findInstalledSkillPath(skillName, context.searchDirs) ?? null;
  if (!context.knownSkills.has(skillName) && installedSkillPath == null) {
    return null;
  }

  const skillPath = installedSkillPath ?? context.fallbackSkillPathBySkill.get(skillName) ?? null;
  const evalReadiness = deriveEvalReadiness(skillPath, trustedTriggerCount);

  const canonicalEvalPath = getCanonicalEvalSetPath(skillName);
  const canonicalEvalEntries = readJsonArrayFile(canonicalEvalPath);
  const canonicalEvalStat = existsSync(canonicalEvalPath) ? statSync(canonicalEvalPath) : null;
  const evidenceEval = context.evalEvidenceBySkill.get(skillName) ?? { count: 0, latestAt: null };
  const evalSetEntries =
    canonicalEvalEntries.length > 0 ? canonicalEvalEntries.length : evidenceEval.count;
  const latestEvalAt = canonicalEvalStat?.mtime.toISOString?.() ?? evidenceEval.latestAt ?? null;

  const unitTestPath = getUnitTestPath(skillName);
  const unitTestCases = readJsonArrayFile(unitTestPath).length;
  const unitTestResult = readUnitTestResult(getUnitTestResultPath(skillName));

  const replay = context.replayBySkill.get(skillName) ?? {
    check_count: 0,
    latest_validation_mode: null,
  };
  const baseline = context.baselineBySkill.get(skillName) ?? {
    sample_size: 0,
    pass_rate: null,
    measured_at: null,
  };
  const latestEvolution = context.latestEvolutionBySkill.get(skillName) ?? {
    action: null,
    timestamp: null,
  };

  let nextStep: CreatorLoopNextStep;
  if (evalSetEntries === 0) {
    nextStep = "generate_evals";
  } else if (unitTestCases === 0) {
    nextStep = "run_unit_tests";
  } else if (replay.check_count === 0) {
    nextStep = "run_replay_dry_run";
  } else if (baseline.sample_size === 0) {
    nextStep = "measure_baseline";
  } else if (latestEvolution.action === "deployed") {
    nextStep = "watch_deployment";
  } else {
    nextStep = "deploy_candidate";
  }

  const deploymentReadiness = deriveDeploymentReadiness(nextStep, latestEvolution.action);
  const deployment = summarizeDeploymentReadiness(deploymentReadiness, skillName, skillPath);
  const recommended_command = recommendCommand(skillName, skillPath, nextStep);
  const summary = summarizeReadiness(
    nextStep,
    evalReadiness,
    evalSetEntries,
    unitTestCases,
    replay.check_count,
    baseline.sample_size,
    unitTestResult?.pass_rate ?? null,
  );

  return {
    skill_name: skillName,
    eval_readiness: evalReadiness,
    next_step: nextStep,
    summary,
    recommended_command,
    skill_path: skillPath,
    trusted_trigger_count: trustedTriggerCount,
    trusted_session_count: trustedSessionCount,
    eval_set_entries: evalSetEntries,
    latest_eval_at: latestEvalAt,
    unit_test_cases: unitTestCases,
    unit_test_pass_rate: unitTestResult?.pass_rate ?? null,
    unit_test_ran_at: unitTestResult?.run_at ?? null,
    replay_check_count: replay.check_count,
    latest_validation_mode:
      replay.latest_validation_mode === "host_replay" ||
      replay.latest_validation_mode === "llm_judge" ||
      replay.latest_validation_mode === "structural_guard"
        ? replay.latest_validation_mode
        : null,
    baseline_sample_size: baseline.sample_size,
    baseline_pass_rate: baseline.pass_rate,
    latest_baseline_at: baseline.measured_at,
    deployment_readiness: deploymentReadiness,
    deployment_summary: deployment.summary,
    deployment_command: deployment.command,
    latest_evolution_action: latestEvolution.action,
    latest_evolution_at: latestEvolution.timestamp,
  } satisfies SkillTestingReadiness;
}

export function buildCreatorTestingOverview(
  readinessRows: SkillTestingReadiness[],
): CreatorTestingOverview {
  const counts = {
    generate_evals: 0,
    run_unit_tests: 0,
    run_replay_dry_run: 0,
    measure_baseline: 0,
    deploy_candidate: 0,
    watch_deployment: 0,
  } satisfies CreatorTestingOverview["counts"];

  for (const row of readinessRows) {
    counts[row.next_step]++;
  }

  const priorities = readinessRows
    .filter((row) => row.next_step !== "watch_deployment")
    .slice(0, 5)
    .map((row) => ({
      skill_name: row.skill_name,
      next_step: row.next_step,
      summary: row.summary,
      recommended_command: row.recommended_command,
    }));

  const summary = `${counts.deploy_candidate} ready to deploy, ${counts.watch_deployment} already shipped and under watch, ${counts.generate_evals} still need evals, ${counts.run_unit_tests} need unit tests, ${counts.run_replay_dry_run} need replay dry-runs, ${counts.measure_baseline} need baselines.`;

  return { summary, counts, priorities };
}
