import type { Database } from "bun:sqlite";

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
  persistPackageCandidateEvaluation,
  readPackageCandidateArtifactByFingerprint,
} from "./package-candidate-state.js";
import { parseSkillSections } from "../evolution/deploy-proposal.js";
import { getLastDeployedProposal } from "../evolution/audit.js";
import { assessBodyQuality, validateBodyStructure } from "../evolution/validate-body.js";
import { getDb } from "../localdb/db.js";
import { queryGradingBaseline, queryRecentGradingResults } from "../localdb/queries.js";
import type { WatchResult } from "../monitoring/watch.js";
import {
  readCanonicalPackageEvaluationArtifact,
  readCanonicalUnitTestRunResult,
  writeCanonicalPackageEvaluationArtifact,
  writeCanonicalPackageEvaluation,
} from "../testing-readiness.js";
import type {
  CreatePackageBodySummary,
  CreatePackageEvaluationSummary,
  CreatePackageEvaluationGradingSummary,
  CreatePackageEvaluationUnitTestSummary,
  CreatePackageEvaluationWatchSummary,
} from "../types.js";
import { computeCreatePackageFingerprint } from "./package-fingerprint.js";
import {
  runCreateBaseline,
  type CreateBaselineDeps,
  type CreateBaselineResult,
  type RunCreateBaselineOptions,
} from "./baseline.js";
import {
  runCreateReplay,
  type CreateReplayMode,
  type CreateReplayResult,
  type RunCreateReplayOptions,
} from "./replay.js";

export interface RunCreatePackageEvaluationOptions {
  skillPath: string;
  skillName?: string;
  mode?: Extract<CreateReplayMode, "package">;
  agent?: string;
  evalSetPath?: string;
}

export interface CreatePackageEvaluationResult {
  summary: CreatePackageEvaluationSummary;
  replay: CreateReplayResult;
  baseline: CreateBaselineResult;
}

export interface CreatePackageEvaluationDeps extends CreateBaselineDeps {
  getDb?: () => Database;
  getLastDeployedProposal?: typeof getLastDeployedProposal;
  queryGradingBaseline?: typeof queryGradingBaseline;
  queryRecentGradingResults?: typeof queryRecentGradingResults;
  computeCreatePackageFingerprint?: typeof computeCreatePackageFingerprint;
  readCanonicalPackageEvaluationArtifact?: typeof readCanonicalPackageEvaluationArtifact;
  readPackageCandidateArtifactByFingerprint?: typeof readPackageCandidateArtifactByFingerprint;
  readCanonicalUnitTestRunResult?: typeof readCanonicalUnitTestRunResult;
  assessBodyQuality?: typeof assessBodyQuality;
  readSkillContent?: (skillPath: string) => string;
  persistPackageCandidateEvaluation?: typeof persistPackageCandidateEvaluation;
  writeCanonicalPackageEvaluationArtifact?: typeof writeCanonicalPackageEvaluationArtifact;
  writeCanonicalPackageEvaluation?: typeof writeCanonicalPackageEvaluation;
  runCreateReplay?: (
    options: RunCreateReplayOptions,
  ) => Promise<Awaited<ReturnType<typeof runCreateReplay>>>;
  runCreateBaseline?: (
    options: RunCreateBaselineOptions,
    deps?: CreateBaselineDeps,
  ) => Promise<CreateBaselineResult>;
}

type BaselineResultLike = CreateBaselineResult["per_entry"][number];
const BODY_QUALITY_THRESHOLD = 0.6;

function inferSkillNameFromSkillPath(skillPath: string): string {
  return basename(dirname(skillPath));
}

function emptyRuntimeMetrics() {
  return {
    eval_runs: 0,
    usage_observations: 0,
    total_duration_ms: 0,
    avg_duration_ms: 0,
    total_input_tokens: null,
    total_output_tokens: null,
    total_cache_creation_input_tokens: null,
    total_cache_read_input_tokens: null,
    total_cost_usd: null,
    total_turns: null,
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectEvidenceSamples(replay: CreateReplayResult, baseline: CreateBaselineResult) {
  const replayFailureSamples = replay.results
    .filter((result) => !result.passed)
    .slice(0, 3)
    .map((result) => ({
      query: result.query,
      evidence: result.evidence ?? null,
    }));

  const perQuery = new Map<
    string,
    {
      with_skill?: BaselineResultLike;
      without_skill?: BaselineResultLike;
    }
  >();
  for (const entry of baseline.per_entry) {
    const current = perQuery.get(entry.query) ?? {};
    if (entry.with_skill) {
      current.with_skill = entry;
    } else {
      current.without_skill = entry;
    }
    perQuery.set(entry.query, current);
  }

  const baselineWins: Array<{ query: string; evidence: string | null }> = [];
  const baselineRegressions: Array<{ query: string; evidence: string | null }> = [];
  for (const [query, pair] of perQuery) {
    if (pair.with_skill?.pass === true && pair.without_skill?.pass === false) {
      baselineWins.push({
        query,
        evidence: pair.with_skill.evidence ?? pair.without_skill.evidence ?? null,
      });
    }
    if (pair.with_skill?.pass === false && pair.without_skill?.pass === true) {
      baselineRegressions.push({
        query,
        evidence: pair.with_skill.evidence ?? pair.without_skill.evidence ?? null,
      });
    }
  }

  return {
    replay_failures: replay.results.filter((result) => !result.passed).length,
    baseline_wins: baselineWins.length,
    baseline_regressions: baselineRegressions.length,
    replay_failure_samples: replayFailureSamples,
    baseline_win_samples: baselineWins.slice(0, 3),
    baseline_regression_samples: baselineRegressions.slice(0, 3),
  };
}

function buildGradingSummary(
  skillName: string,
  deps: CreatePackageEvaluationDeps,
): CreatePackageEvaluationGradingSummary | undefined {
  try {
    const db = (deps.getDb ?? getDb)();
    const lastDeployed = (deps.getLastDeployedProposal ?? getLastDeployedProposal)(skillName);
    const baselineRow = (deps.queryGradingBaseline ?? queryGradingBaseline)(
      db,
      skillName,
      lastDeployed?.proposal_id,
    );
    const recentRows = (deps.queryRecentGradingResults ?? queryRecentGradingResults)(
      db,
      skillName,
      10,
    );

    if (!baselineRow && recentRows.length === 0) {
      return undefined;
    }

    const recentPassRates = recentRows.flatMap((row) =>
      row.pass_rate == null ? [] : [row.pass_rate],
    );
    const recentMeanScores = recentRows.flatMap((row) =>
      row.mean_score == null ? [] : [row.mean_score],
    );
    const recentSummary =
      recentRows.length === 0
        ? null
        : {
            sample_size: recentRows.length,
            average_pass_rate: average(recentPassRates),
            average_mean_score: average(recentMeanScores),
            newest_graded_at: recentRows[0]?.graded_at ?? null,
            oldest_graded_at: recentRows.at(-1)?.graded_at ?? null,
          };
    const baselineSummary = baselineRow
      ? {
          proposal_id: baselineRow.proposal_id,
          measured_at: baselineRow.measured_at,
          pass_rate: baselineRow.pass_rate,
          mean_score: baselineRow.mean_score,
          sample_size: baselineRow.sample_size,
        }
      : null;
    const passRateDelta =
      baselineSummary && recentSummary?.average_pass_rate != null
        ? recentSummary.average_pass_rate - baselineSummary.pass_rate
        : null;
    const meanScoreDelta =
      baselineSummary?.mean_score != null && recentSummary?.average_mean_score != null
        ? recentSummary.average_mean_score - baselineSummary.mean_score
        : null;

    return {
      baseline: baselineSummary,
      recent: recentSummary,
      pass_rate_delta: passRateDelta,
      mean_score_delta: meanScoreDelta,
      regressed: passRateDelta == null ? null : passRateDelta < 0,
    };
  } catch {
    // Fail-open: grading context should enrich the evaluator, never block it.
    return undefined;
  }
}

function buildUnitTestSummary(
  skillName: string,
  deps: CreatePackageEvaluationDeps,
): CreatePackageEvaluationUnitTestSummary | undefined {
  try {
    const suite = deps.getDb
      ? (deps.readCanonicalUnitTestRunResult ?? readCanonicalUnitTestRunResult)(
          skillName,
          deps.getDb(),
        )
      : (deps.readCanonicalUnitTestRunResult ?? readCanonicalUnitTestRunResult)(skillName);
    if (!suite) return undefined;

    return {
      total: suite.total,
      passed: suite.passed,
      failed: suite.failed,
      pass_rate: suite.pass_rate,
      run_at: suite.run_at,
      failing_tests: suite.results
        .filter((result) => !result.passed)
        .slice(0, 3)
        .map((result) => ({
          test_id: result.test_id,
          error: result.error ?? null,
          failed_assertions: result.assertion_results
            .filter((assertion) => !assertion.passed)
            .map((assertion) => `${assertion.assertion.type}: ${assertion.assertion.value}`),
        })),
    };
  } catch {
    return undefined;
  }
}

function extractSkillBody(skillContent: string): string {
  const parsed = parseSkillSections(skillContent);
  const bodyParts: string[] = [];

  if (parsed.description.trim()) {
    bodyParts.push(parsed.description.trim());
    bodyParts.push("");
  }

  for (const [sectionName, sectionContent] of Object.entries(parsed.sections)) {
    bodyParts.push(`## ${sectionName}`);
    bodyParts.push("");
    bodyParts.push(sectionContent.trim());
    bodyParts.push("");
  }

  return bodyParts.join("\n").trim();
}

function canReuseCachedPackageEvaluation(
  cached: CreatePackageEvaluationResult | null,
  options: RunCreatePackageEvaluationOptions,
  packageFingerprint: string | null,
): cached is CreatePackageEvaluationResult {
  if (!cached || !packageFingerprint || options.evalSetPath) return false;
  if (cached.summary.mode !== "package") return false;
  if (cached.summary.skill_path !== options.skillPath) return false;
  if (options.skillName && cached.summary.skill_name !== options.skillName) return false;
  if (cached.summary.package_fingerprint !== packageFingerprint) return false;
  if (options.agent && cached.summary.replay.agent !== options.agent) return false;
  if (cached.summary.replay.validation_mode !== "host_replay") return false;
  if (cached.summary.routing?.validation_mode !== "host_replay") return false;
  if (typeof cached.summary.candidate_id !== "string") return false;
  if (typeof cached.summary.candidate_generation !== "number") return false;
  if (!cached.summary.candidate_acceptance) return false;
  if (!cached.summary.body) return false;
  if (cached.replay.skill !== cached.summary.skill_name) return false;
  if (cached.baseline.skill_name !== cached.summary.skill_name) return false;
  return true;
}

function buildSummary(
  skillName: string,
  skillPath: string,
  replay: CreateReplayResult,
  routing: CreateReplayResult | undefined,
  baseline: CreateBaselineResult,
  grading?: CreatePackageEvaluationGradingSummary,
  body?: CreatePackageBodySummary,
  unitTests?: CreatePackageEvaluationUnitTestSummary,
  packageFingerprint?: string | null,
): CreatePackageEvaluationSummary {
  const replayFailed = replay.failed > 0;
  const baselineFailed = !baseline.adds_value;
  const status = replayFailed ? "replay_failed" : baselineFailed ? "baseline_failed" : "passed";
  const withSkillMetrics = replay.runtime_metrics ?? emptyRuntimeMetrics();
  const withoutSkillMetrics = baseline.runtime_metrics?.without_skill ?? emptyRuntimeMetrics();

  return {
    skill_name: skillName,
    skill_path: skillPath,
    mode: "package",
    ...(packageFingerprint ? { package_fingerprint: packageFingerprint } : {}),
    evaluation_source: "fresh",
    status,
    evaluation_passed: status === "passed",
    next_command:
      status === "passed"
        ? null
        : replayFailed
          ? `selftune create replay --skill-path ${skillPath} --mode package`
          : `selftune create baseline --skill-path ${skillPath} --mode package`,
    replay: {
      mode: replay.mode,
      validation_mode: "host_replay",
      agent: replay.agent,
      proposal_id: replay.proposal_id,
      fixture_id: replay.fixture_id,
      total: replay.total,
      passed: replay.passed,
      failed: replay.failed,
      pass_rate: replay.pass_rate,
      runtime_metrics: replay.runtime_metrics,
    },
    ...(routing
      ? {
          routing: {
            mode: routing.mode,
            validation_mode: "host_replay",
            agent: routing.agent,
            proposal_id: routing.proposal_id,
            fixture_id: routing.fixture_id,
            total: routing.total,
            passed: routing.passed,
            failed: routing.failed,
            pass_rate: routing.pass_rate,
            runtime_metrics: routing.runtime_metrics,
          },
        }
      : {}),
    baseline: {
      mode: baseline.mode,
      baseline_pass_rate: baseline.baseline_pass_rate,
      with_skill_pass_rate: baseline.with_skill_pass_rate,
      lift: baseline.lift,
      adds_value: baseline.adds_value,
      measured_at: baseline.measured_at,
      sample_size: baseline.per_entry.filter((entry) => entry.with_skill).length,
      ...(baseline.runtime_metrics ? { runtime_metrics: baseline.runtime_metrics } : {}),
    },
    evidence: collectEvidenceSamples(replay, baseline),
    ...(baseline.runtime_metrics
      ? {
          efficiency: {
            with_skill: withSkillMetrics,
            without_skill: withoutSkillMetrics,
          },
        }
      : {}),
    ...(grading ? { grading } : {}),
    ...(body ? { body } : {}),
    ...(unitTests ? { unit_tests: unitTests } : {}),
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatEvaluationSource(
  source: CreatePackageEvaluationSummary["evaluation_source"],
): string {
  if (source === "artifact_cache") return "cached artifact";
  if (source === "candidate_cache") return "accepted candidate cache";
  return "fresh";
}

function formatCandidateAcceptance(summary: CreatePackageEvaluationSummary): string | null {
  const acceptance = summary.candidate_acceptance;
  if (!acceptance) return null;
  const comparedTo = acceptance.compared_to_candidate_id ?? "root";
  return `${acceptance.decision} vs ${comparedTo} | ${acceptance.rationale}`;
}

function summarizeReplayFailures(replay: CreateReplayResult): string[] {
  return replay.results
    .filter((result) => !result.passed)
    .map((result) => {
      const expected = result.should_trigger ? "trigger" : "skip";
      const actual = result.triggered ? "triggered" : "skipped";
      const evidence = result.evidence?.trim() ? ` | evidence: ${result.evidence.trim()}` : "";
      return `- query: ${result.query} | expected: ${expected} | actual: ${actual}${evidence}`;
    });
}

function summarizeBaselineDiffs(baseline: CreateBaselineResult): string[] {
  const byQuery = new Map<
    string,
    {
      withSkill?: boolean;
      withoutSkill?: boolean;
    }
  >();

  for (const entry of baseline.per_entry) {
    const current = byQuery.get(entry.query) ?? {};
    if (entry.with_skill) {
      current.withSkill = entry.pass;
    } else {
      current.withoutSkill = entry.pass;
    }
    byQuery.set(entry.query, current);
  }

  return [...byQuery.entries()]
    .filter(([, value]) => value.withSkill !== value.withoutSkill)
    .map(([query, value]) => {
      const withoutSkill =
        value.withoutSkill == null ? "n/a" : value.withoutSkill ? "pass" : "fail";
      const withSkill = value.withSkill == null ? "n/a" : value.withSkill ? "pass" : "fail";
      return `- query: ${query} | without skill: ${withoutSkill} | with skill: ${withSkill}`;
    });
}

function summarizeFailedUnitTests(
  unitTests: CreatePackageEvaluationUnitTestSummary | undefined,
): string[] {
  if (!unitTests || unitTests.failed === 0) return [];
  return unitTests.failing_tests.slice(0, 3).map((failure) => {
    const failureDetails =
      failure.failed_assertions.length > 0
        ? ` | failed assertions: ${failure.failed_assertions.join(", ")}`
        : "";
    const error = failure.error?.trim() ? ` | error: ${failure.error.trim()}` : "";
    return `- unit test: ${failure.test_id}${error}${failureDetails}`;
  });
}

export function formatCreatePackageBenchmarkReport(
  evaluation: CreatePackageEvaluationResult,
): string {
  const routing = evaluation.summary.routing;
  const body = evaluation.summary.body;
  const grading = evaluation.summary.grading;
  const unitTests = evaluation.summary.unit_tests;
  const candidateAcceptance = formatCandidateAcceptance(evaluation.summary);
  const lines = [
    `CREATE PACKAGE BENCHMARK REPORT: ${evaluation.summary.skill_name}`,
    "",
    `PACKAGE: skill=${evaluation.summary.skill_name} | mode=${evaluation.summary.mode} | status=${evaluation.summary.status}`,
    `SOURCE: ${formatEvaluationSource(evaluation.summary.evaluation_source)}`,
    ...(evaluation.summary.candidate_id
      ? [
          `CANDIDATE: id=${evaluation.summary.candidate_id} | generation=${evaluation.summary.candidate_generation ?? 0} | parent=${evaluation.summary.parent_candidate_id ?? "root"}`,
        ]
      : []),
    ...(candidateAcceptance ? [`ACCEPTANCE: ${candidateAcceptance}`] : []),
    `REPLAY: agent=${evaluation.summary.replay.agent} | pass_rate=${formatPercent(evaluation.summary.replay.pass_rate)} | passed=${evaluation.summary.replay.passed}/${evaluation.summary.replay.total} | fixture=${evaluation.summary.replay.fixture_id}`,
    ...(routing
      ? [
          `ROUTING VALIDATION: pass_rate=${formatPercent(routing.pass_rate)} | passed=${routing.passed}/${routing.total} | fixture=${routing.fixture_id}`,
          "",
        ]
      : []),
    ...(body
      ? [
          `BODY VALIDATION: structural=${body.structural_valid ? "pass" : "fail"} | quality=${body.quality_score == null ? "n/a" : body.quality_score.toFixed(2)} | threshold=${body.quality_threshold.toFixed(2)} | valid=${body.valid ? "yes" : "no"}`,
          "",
        ]
      : []),
    `SKILLS IMPACT: without_skill=${formatPercent(evaluation.summary.baseline.baseline_pass_rate)} | with_skill=${formatPercent(evaluation.summary.baseline.with_skill_pass_rate)} | lift=${evaluation.summary.baseline.lift.toFixed(3)} | adds_value=${evaluation.summary.baseline.adds_value ? "yes" : "no"}`,
    ...(unitTests
      ? [
          `UNIT TESTS: passed=${unitTests.passed}/${unitTests.total} | pass_rate=${formatPercent(unitTests.pass_rate)} | latest_run=${unitTests.run_at}`,
          "",
        ]
      : []),
    "",
    ...(grading
      ? [
          `GRADING CONTEXT: baseline=${grading.baseline ? formatPercent(grading.baseline.pass_rate) : "n/a"} | recent_avg=${grading.recent?.average_pass_rate != null ? formatPercent(grading.recent.average_pass_rate) : "n/a"} | delta=${grading.pass_rate_delta == null ? "n/a" : `${grading.pass_rate_delta >= 0 ? "+" : ""}${(grading.pass_rate_delta * 100).toFixed(1)}%`} | regressed=${grading.regressed == null ? "unknown" : grading.regressed ? "yes" : "no"}`,
          "",
        ]
      : []),
    "FAILURE ANALYSIS:",
  ];

  const replayFailures = summarizeReplayFailures(evaluation.replay);
  const baselineDiffs = summarizeBaselineDiffs(evaluation.baseline);
  const unitTestFailures = summarizeFailedUnitTests(unitTests);

  if (replayFailures.length === 0 && baselineDiffs.length === 0 && unitTestFailures.length === 0) {
    lines.push("- none");
  } else {
    if (replayFailures.length > 0) {
      lines.push(...replayFailures);
    }
    if (baselineDiffs.length > 0) {
      lines.push(...baselineDiffs);
    }
    if (unitTestFailures.length > 0) {
      lines.push(...unitTestFailures);
    }
  }

  lines.push("");
  lines.push(
    `RECOMMENDATION: ${evaluation.summary.evaluation_passed ? "APPROVE FOR PUBLISH" : "DO NOT PUBLISH"}`,
  );

  if (evaluation.summary.next_command) {
    lines.push(`NEXT: ${evaluation.summary.next_command}`);
  }

  return lines.join("\n");
}

export function buildCreatePackageWatchSummary(
  watchResult: WatchResult,
): CreatePackageEvaluationWatchSummary {
  return {
    snapshot: watchResult.snapshot,
    alert: watchResult.alert,
    rolled_back: watchResult.rolledBack,
    recommendation: watchResult.recommendation,
    recommended_command: watchResult.recommended_command ?? null,
    grade_alert: watchResult.gradeAlert ?? null,
    grade_regression: watchResult.gradeRegression ?? null,
    ...(watchResult.efficiencyAlert || watchResult.efficiencyRegression
      ? {
          efficiency_alert: watchResult.efficiencyAlert ?? null,
          efficiency_regression: watchResult.efficiencyRegression ?? null,
        }
      : {}),
  };
}

export function attachCreatePackageWatchSummary(
  summary: CreatePackageEvaluationSummary,
  watchResult: WatchResult,
): CreatePackageEvaluationSummary {
  return {
    ...summary,
    watch: buildCreatePackageWatchSummary(watchResult),
  };
}

export async function runCreatePackageEvaluation(
  options: RunCreatePackageEvaluationOptions,
  deps: CreatePackageEvaluationDeps = {},
): Promise<CreatePackageEvaluationResult> {
  const packageFingerprint = (
    deps.computeCreatePackageFingerprint ?? computeCreatePackageFingerprint
  )(options.skillPath);
  const skillName = options.skillName?.trim() || inferSkillNameFromSkillPath(options.skillPath);
  const cachedEvaluation = (
    deps.readCanonicalPackageEvaluationArtifact ?? readCanonicalPackageEvaluationArtifact
  )(skillName);
  if (canReuseCachedPackageEvaluation(cachedEvaluation, options, packageFingerprint)) {
    return {
      ...cachedEvaluation,
      summary: {
        ...cachedEvaluation.summary,
        evaluation_source: "artifact_cache",
      },
    };
  }
  if (packageFingerprint) {
    const candidateCachedEvaluation = (
      deps.readPackageCandidateArtifactByFingerprint ?? readPackageCandidateArtifactByFingerprint
    )(skillName, packageFingerprint, {
      acceptedOnly: true,
      db: deps.getDb ? deps.getDb() : undefined,
    });
    if (canReuseCachedPackageEvaluation(candidateCachedEvaluation, options, packageFingerprint)) {
      return {
        ...candidateCachedEvaluation,
        summary: {
          ...candidateCachedEvaluation.summary,
          evaluation_source: "candidate_cache",
        },
      };
    }
  }

  let replay = await (deps.runCreateReplay ?? runCreateReplay)({
    skillPath: options.skillPath,
    mode: options.mode ?? "package",
    agent: options.agent,
    evalSetPath: options.evalSetPath,
  });
  if (replay.skill !== skillName) {
    replay = { ...replay, skill: skillName };
  }
  let routing: CreateReplayResult | undefined;
  try {
    routing = await (deps.runCreateReplay ?? runCreateReplay)({
      skillPath: options.skillPath,
      mode: "routing",
      agent: replay.agent,
      evalSetPath: options.evalSetPath,
    });
    if (routing.skill !== skillName) {
      routing = { ...routing, skill: skillName };
    }
  } catch {
    // Fail-open: routing validation should enrich package reports when available.
  }

  let baseline = await (deps.runCreateBaseline ?? runCreateBaseline)(
    {
      skillPath: options.skillPath,
      mode: "package",
      agent: options.agent,
      evalSetPath: options.evalSetPath,
      withSkillReplayResult: replay,
    },
    deps,
  );
  if (baseline.skill_name !== skillName) {
    baseline = { ...baseline, skill_name: skillName };
  }
  const grading = buildGradingSummary(skillName, deps);
  let body: CreatePackageBodySummary | undefined;
  try {
    const skillContent = (deps.readSkillContent ?? ((path) => readFileSync(path, "utf-8")))(
      options.skillPath,
    );
    const bodyContent = extractSkillBody(skillContent);
    const structural = validateBodyStructure(bodyContent);
    const quality = await (deps.assessBodyQuality ?? assessBodyQuality)(
      bodyContent,
      replay.skill,
      replay.agent,
    );
    body = {
      structural_valid: structural.valid,
      structural_reason: structural.reason,
      quality_score: quality.score,
      quality_reason: quality.reason,
      quality_threshold: BODY_QUALITY_THRESHOLD,
      quality_passed: quality.score >= BODY_QUALITY_THRESHOLD,
      valid: structural.valid && quality.score >= BODY_QUALITY_THRESHOLD,
    };
  } catch {
    // Fail-open: body validation should enrich package reports when available.
  }
  const unitTests = buildUnitTestSummary(skillName, deps);
  let evaluationResult: CreatePackageEvaluationResult = {
    summary: buildSummary(
      skillName,
      options.skillPath,
      replay,
      routing,
      baseline,
      grading,
      body,
      unitTests,
      packageFingerprint,
    ),
    replay,
    baseline,
  };

  try {
    evaluationResult = (
      deps.persistPackageCandidateEvaluation ?? persistPackageCandidateEvaluation
    )(evaluationResult, deps.getDb ? deps.getDb() : undefined);
  } catch {
    // Fail-open: candidate persistence should not block measurement.
  }

  try {
    (deps.writeCanonicalPackageEvaluation ?? writeCanonicalPackageEvaluation)(
      skillName,
      evaluationResult.summary,
    );
    (deps.writeCanonicalPackageEvaluationArtifact ?? writeCanonicalPackageEvaluationArtifact)(
      skillName,
      evaluationResult,
    );
  } catch {
    // Fail-open: evaluation artifacts should improve reuse, never block scoring.
  }

  return evaluationResult;
}
