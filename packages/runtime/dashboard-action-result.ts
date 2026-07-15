import type {
  DashboardActionName,
  DashboardActionResultSummary,
  DashboardSearchRunSummary,
} from "./dashboard-contract.js";
import type {
  CreatePackageBodySummary,
  CreatePackageEvaluationEfficiencySummary,
  CreatePackageEvaluationEvidenceSample,
  CreatePackageEvaluationEvidenceSummary,
  CreatePackageEvaluationGradingSummary,
  CreatePackageEvaluationSource,
  CreatePackageReplaySummary,
  CreatePackageEvaluationUnitTestSummary,
  CreatePackageEvaluationWatchSummary,
  MonitoringSnapshot,
  RuntimeReplayAggregateMetrics,
} from "./types.js";
import { extractJsonObject } from "./utils/json-output.js";

export interface DashboardActionOutcomeInput {
  action: DashboardActionName;
  stdout: string;
  stderr: string | null;
  exitCode: number | null;
}

export interface DashboardActionOutcome {
  success: boolean;
  error: string | null;
  summary: DashboardActionResultSummary | null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readEvidenceSample(value: unknown): CreatePackageEvaluationEvidenceSample | null {
  const sample = readObject(value);
  const query = readString(sample?.["query"]);
  if (!query) return null;

  return {
    query,
    evidence: readString(sample?.["evidence"]),
  };
}

function readEvidenceSamples(value: unknown): CreatePackageEvaluationEvidenceSample[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((sample) => readEvidenceSample(sample))
    .filter((sample): sample is CreatePackageEvaluationEvidenceSample => sample != null);
}

function readRuntimeReplayAggregateMetrics(value: unknown): RuntimeReplayAggregateMetrics | null {
  const metrics = readObject(value);
  if (!metrics) return null;

  const evalRuns = readNumber(metrics["eval_runs"]);
  const usageObservations = readNumber(metrics["usage_observations"]);
  const totalDurationMs = readNumber(metrics["total_duration_ms"]);
  const avgDurationMs = readNumber(metrics["avg_duration_ms"]);
  if (
    evalRuns == null ||
    usageObservations == null ||
    totalDurationMs == null ||
    avgDurationMs == null
  ) {
    return null;
  }

  return {
    eval_runs: evalRuns,
    usage_observations: usageObservations,
    total_duration_ms: totalDurationMs,
    avg_duration_ms: avgDurationMs,
    total_input_tokens: readNumber(metrics["total_input_tokens"]),
    total_output_tokens: readNumber(metrics["total_output_tokens"]),
    total_cache_creation_input_tokens: readNumber(metrics["total_cache_creation_input_tokens"]),
    total_cache_read_input_tokens: readNumber(metrics["total_cache_read_input_tokens"]),
    total_cost_usd: readNumber(metrics["total_cost_usd"]),
    total_turns: readNumber(metrics["total_turns"]),
  };
}

function readPackageEvidenceSummary(value: unknown): CreatePackageEvaluationEvidenceSummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const replayFailures = readNumber(summary["replay_failures"]);
  const baselineWins = readNumber(summary["baseline_wins"]);
  const baselineRegressions = readNumber(summary["baseline_regressions"]);
  const replayFailureSamples = readEvidenceSamples(summary["replay_failure_samples"]);
  const baselineWinSamples = readEvidenceSamples(summary["baseline_win_samples"]);
  const baselineRegressionSamples = readEvidenceSamples(summary["baseline_regression_samples"]);

  if (
    replayFailures == null &&
    baselineWins == null &&
    baselineRegressions == null &&
    replayFailureSamples.length === 0 &&
    baselineWinSamples.length === 0 &&
    baselineRegressionSamples.length === 0
  ) {
    return null;
  }

  return {
    replay_failures: replayFailures ?? replayFailureSamples.length,
    baseline_wins: baselineWins ?? baselineWinSamples.length,
    baseline_regressions: baselineRegressions ?? baselineRegressionSamples.length,
    replay_failure_samples: replayFailureSamples,
    baseline_win_samples: baselineWinSamples,
    baseline_regression_samples: baselineRegressionSamples,
  };
}

function readPackageEfficiencySummary(
  value: unknown,
): CreatePackageEvaluationEfficiencySummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const withSkill = readRuntimeReplayAggregateMetrics(summary["with_skill"]);
  const withoutSkill = readRuntimeReplayAggregateMetrics(summary["without_skill"]);
  if (!withSkill || !withoutSkill) return null;

  return {
    with_skill: withSkill,
    without_skill: withoutSkill,
  };
}

function readPackageEvaluationSource(value: unknown): CreatePackageEvaluationSource | null {
  const source = readString(value);
  if (source !== "fresh" && source !== "artifact_cache" && source !== "candidate_cache") {
    return null;
  }
  return source;
}

function readPackageReplaySummary(value: unknown): CreatePackageReplaySummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const mode = readString(summary["mode"]);
  const validationMode = readString(summary["validation_mode"]);
  const agent = readString(summary["agent"]);
  const proposalId = readString(summary["proposal_id"]);
  const fixtureId = readString(summary["fixture_id"]);
  const total = readNumber(summary["total"]);
  const passed = readNumber(summary["passed"]);
  const failed = readNumber(summary["failed"]);
  const passRate = readNumber(summary["pass_rate"]);
  if (
    (mode !== "routing" && mode !== "package") ||
    validationMode !== "host_replay" ||
    agent == null ||
    proposalId == null ||
    fixtureId == null ||
    total == null ||
    passed == null ||
    failed == null ||
    passRate == null
  ) {
    return null;
  }

  const runtimeMetrics = readRuntimeReplayAggregateMetrics(summary["runtime_metrics"]);

  return {
    mode,
    validation_mode: validationMode,
    agent,
    proposal_id: proposalId,
    fixture_id: fixtureId,
    total,
    passed,
    failed,
    pass_rate: passRate,
    ...(runtimeMetrics ? { runtime_metrics: runtimeMetrics } : {}),
  };
}

function readPackageBodySummary(value: unknown): CreatePackageBodySummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const structuralValid = readBoolean(summary["structural_valid"]);
  const structuralReason = readString(summary["structural_reason"]);
  const qualityThreshold = readNumber(summary["quality_threshold"]);
  const valid = readBoolean(summary["valid"]);
  if (
    structuralValid == null ||
    structuralReason == null ||
    qualityThreshold == null ||
    valid == null
  ) {
    return null;
  }

  return {
    structural_valid: structuralValid,
    structural_reason: structuralReason,
    quality_score: readNumber(summary["quality_score"]),
    quality_reason: readString(summary["quality_reason"]),
    quality_threshold: qualityThreshold,
    quality_passed: readBoolean(summary["quality_passed"]),
    valid,
  };
}

function readPackageGradingSummary(value: unknown): CreatePackageEvaluationGradingSummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const baseline = readObject(summary["baseline"]);
  const recent = readObject(summary["recent"]);
  const baselinePassRate = readNumber(baseline?.["pass_rate"]);
  const baselineMeasuredAt = readString(baseline?.["measured_at"]);
  const baselineSampleSize = readNumber(baseline?.["sample_size"]);
  const recentSampleSize = readNumber(recent?.["sample_size"]);

  const parsedBaseline =
    baselinePassRate != null && baselineMeasuredAt != null && baselineSampleSize != null
      ? {
          proposal_id: readString(baseline?.["proposal_id"]),
          measured_at: baselineMeasuredAt,
          pass_rate: baselinePassRate,
          mean_score: readNumber(baseline?.["mean_score"]),
          sample_size: baselineSampleSize,
        }
      : null;
  const parsedRecent =
    recentSampleSize != null
      ? {
          sample_size: recentSampleSize,
          average_pass_rate: readNumber(recent?.["average_pass_rate"]),
          average_mean_score: readNumber(recent?.["average_mean_score"]),
          newest_graded_at: readString(recent?.["newest_graded_at"]),
          oldest_graded_at: readString(recent?.["oldest_graded_at"]),
        }
      : null;

  if (!parsedBaseline && !parsedRecent) return null;

  return {
    baseline: parsedBaseline,
    recent: parsedRecent,
    pass_rate_delta: readNumber(summary["pass_rate_delta"]),
    mean_score_delta: readNumber(summary["mean_score_delta"]),
    regressed: readBoolean(summary["regressed"]),
  };
}

function readPackageUnitTestSummary(value: unknown): CreatePackageEvaluationUnitTestSummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const total = readNumber(summary["total"]);
  const passed = readNumber(summary["passed"]);
  const failed = readNumber(summary["failed"]);
  const passRate = readNumber(summary["pass_rate"]);
  const runAt = readString(summary["run_at"]);
  if (total == null || passed == null || failed == null || passRate == null || runAt == null) {
    return null;
  }

  const failingTests = Array.isArray(summary["failing_tests"])
    ? summary["failing_tests"]
        .map((entry) => {
          const failure = readObject(entry);
          const testId = readString(failure?.["test_id"]);
          if (!testId) return null;

          const failedAssertions = Array.isArray(failure?.["failed_assertions"])
            ? failure["failed_assertions"].filter(
                (assertion): assertion is string =>
                  typeof assertion === "string" && assertion.trim().length > 0,
              )
            : [];

          return {
            test_id: testId,
            error: readString(failure?.["error"]),
            failed_assertions: failedAssertions,
          };
        })
        .filter(
          (failure): failure is CreatePackageEvaluationUnitTestSummary["failing_tests"][number] =>
            failure != null,
        )
    : [];

  return {
    total,
    passed,
    failed,
    pass_rate: passRate,
    run_at: runAt,
    failing_tests: failingTests,
  };
}

function readInvocationTotals(value: unknown): { passed: number; total: number } | null {
  const entry = readObject(value);
  const passed = readNumber(entry?.["passed"]);
  const total = readNumber(entry?.["total"]);
  if (passed == null || total == null) return null;

  return { passed, total };
}

function readMonitoringSnapshot(value: unknown): MonitoringSnapshot | null {
  const snapshot = readObject(value);
  if (!snapshot) return null;

  const timestamp = readString(snapshot["timestamp"]);
  const skillName = readString(snapshot["skill_name"]);
  const windowSessions = readNumber(snapshot["window_sessions"]);
  const skillChecks = readNumber(snapshot["skill_checks"]);
  const passRate = readNumber(snapshot["pass_rate"]);
  const falseNegativeRate = readNumber(snapshot["false_negative_rate"]);
  const regressionDetected = readBoolean(snapshot["regression_detected"]);
  const baselinePassRate = readNumber(snapshot["baseline_pass_rate"]);
  const byInvocationType = readObject(snapshot["by_invocation_type"]);

  const explicit = readInvocationTotals(byInvocationType?.["explicit"]);
  const implicit = readInvocationTotals(byInvocationType?.["implicit"]);
  const contextual = readInvocationTotals(byInvocationType?.["contextual"]);
  const negative = readInvocationTotals(byInvocationType?.["negative"]);

  if (
    timestamp == null ||
    skillName == null ||
    windowSessions == null ||
    skillChecks == null ||
    passRate == null ||
    falseNegativeRate == null ||
    regressionDetected == null ||
    baselinePassRate == null ||
    explicit == null ||
    implicit == null ||
    contextual == null ||
    negative == null
  ) {
    return null;
  }

  return {
    timestamp,
    skill_name: skillName,
    window_sessions: windowSessions,
    skill_checks: skillChecks,
    pass_rate: passRate,
    false_negative_rate: falseNegativeRate,
    by_invocation_type: {
      explicit,
      implicit,
      contextual,
      negative,
    },
    regression_detected: regressionDetected,
    baseline_pass_rate: baselinePassRate,
  };
}

function readGradeRegression(
  value: unknown,
): CreatePackageEvaluationWatchSummary["grade_regression"] {
  const regression = readObject(value);
  if (!regression) return null;

  const before = readNumber(regression["before"]);
  const after = readNumber(regression["after"]);
  const delta = readNumber(regression["delta"]);
  if (before == null || after == null || delta == null) return null;

  return { before, after, delta };
}

function readEfficiencyRegression(
  value: unknown,
): CreatePackageEvaluationWatchSummary["efficiency_regression"] {
  const regression = readObject(value);
  if (!regression) return null;

  const sampleSize = readNumber(regression["sample_size"]);
  if (sampleSize == null) return null;

  return {
    sample_size: sampleSize,
    baseline_avg_duration_ms: readNumber(regression["baseline_avg_duration_ms"]),
    observed_avg_duration_ms: readNumber(regression["observed_avg_duration_ms"]),
    duration_delta_ratio: readNumber(regression["duration_delta_ratio"]),
    baseline_avg_input_tokens: readNumber(regression["baseline_avg_input_tokens"]),
    observed_avg_input_tokens: readNumber(regression["observed_avg_input_tokens"]),
    input_tokens_delta_ratio: readNumber(regression["input_tokens_delta_ratio"]),
    baseline_avg_output_tokens: readNumber(regression["baseline_avg_output_tokens"]),
    observed_avg_output_tokens: readNumber(regression["observed_avg_output_tokens"]),
    output_tokens_delta_ratio: readNumber(regression["output_tokens_delta_ratio"]),
    baseline_avg_turns: readNumber(regression["baseline_avg_turns"]),
    observed_avg_turns: readNumber(regression["observed_avg_turns"]),
    turns_delta_ratio: readNumber(regression["turns_delta_ratio"]),
  };
}

export function readCreatePackageEvaluationWatchSummary(
  value: unknown,
): CreatePackageEvaluationWatchSummary | null {
  const summary = readObject(value);
  if (!summary) return null;

  const snapshot = readMonitoringSnapshot(summary["snapshot"]);
  const rolledBack = readBoolean(summary["rolled_back"]) ?? readBoolean(summary["rolledBack"]);
  const recommendation = readString(summary["recommendation"]);

  if (!snapshot || rolledBack == null || recommendation == null) return null;

  return {
    snapshot,
    alert: readString(summary["alert"]),
    rolled_back: rolledBack,
    recommendation,
    recommended_command: readString(summary["recommended_command"]),
    grade_alert: readString(summary["grade_alert"]) ?? readString(summary["gradeAlert"]),
    grade_regression:
      readGradeRegression(summary["grade_regression"]) ??
      readGradeRegression(summary["gradeRegression"]),
    ...((readString(summary["efficiency_alert"]) ?? readString(summary["efficiencyAlert"]))
      ? {
          efficiency_alert:
            readString(summary["efficiency_alert"]) ?? readString(summary["efficiencyAlert"]),
        }
      : {}),
    ...((readEfficiencyRegression(summary["efficiency_regression"]) ??
    readEfficiencyRegression(summary["efficiencyRegression"]))
      ? {
          efficiency_regression:
            readEfficiencyRegression(summary["efficiency_regression"]) ??
            readEfficiencyRegression(summary["efficiencyRegression"]),
        }
      : {}),
  };
}

function subtractRates(current: number | null, baseline: number | null): number | null {
  if (current == null || baseline == null) return null;
  return Number.parseFloat((current - baseline).toFixed(4));
}

function buildWatchSummary(
  watchResult: Record<string, unknown>,
  fallbackReason: string | null = null,
  packageEvaluation: Record<string, unknown> | null = null,
): DashboardActionResultSummary | null {
  const packageWatch =
    readCreatePackageEvaluationWatchSummary(watchResult) ??
    readCreatePackageEvaluationWatchSummary(packageEvaluation?.["watch"]);
  const snapshot = packageWatch?.snapshot ?? readMonitoringSnapshot(watchResult["snapshot"]);
  if (!snapshot) return null;

  const baselinePassRate = snapshot.baseline_pass_rate;
  const currentPassRate = snapshot.pass_rate;
  const regressionDetected = snapshot.regression_detected;
  const gradeAlert = packageWatch?.grade_alert ?? readString(watchResult["gradeAlert"]);
  const alert = packageWatch?.alert ?? readString(watchResult["alert"]);
  const recommendation =
    packageWatch?.recommendation ?? readString(watchResult["recommendation"]) ?? fallbackReason;
  const recommendedCommand =
    packageWatch?.recommended_command ?? readString(watchResult["recommended_command"]);
  const packageEvaluationSource = readPackageEvaluationSource(
    packageEvaluation?.["evaluation_source"],
  );
  const packageCandidateId = readString(packageEvaluation?.["candidate_id"]);
  const packageParentCandidateId = readString(packageEvaluation?.["parent_candidate_id"]);
  const packageCandidateGeneration = readNumber(packageEvaluation?.["candidate_generation"]);
  const packageCandidateAcceptance = readObject(packageEvaluation?.["candidate_acceptance"]);
  const packageCandidateAcceptanceDecision = readString(packageCandidateAcceptance?.["decision"]);
  const packageCandidateAcceptanceRationale = readString(packageCandidateAcceptance?.["rationale"]);
  const packageEvidence = readPackageEvidenceSummary(packageEvaluation?.["evidence"]);
  const packageEfficiency = readPackageEfficiencySummary(packageEvaluation?.["efficiency"]);
  const packageRouting = readPackageReplaySummary(packageEvaluation?.["routing"]);
  const packageBody = readPackageBodySummary(packageEvaluation?.["body"]);
  const packageGrading = readPackageGradingSummary(packageEvaluation?.["grading"]);
  const packageUnitTests = readPackageUnitTestSummary(packageEvaluation?.["unit_tests"]);

  return {
    reason: alert ?? recommendation,
    improved: alert == null,
    deployed: true,
    before_pass_rate: baselinePassRate,
    before_label: "Baseline",
    after_pass_rate: currentPassRate,
    after_label: "Observed",
    net_change: subtractRates(currentPassRate, baselinePassRate),
    net_change_label: "Delta",
    validation_mode:
      gradeAlert != null && regressionDetected
        ? "trigger+grade_watch"
        : gradeAlert != null
          ? "grade_watch"
          : regressionDetected
            ? "trigger_watch"
            : "live_watch",
    validation_label: "Signal",
    ...((recommendedCommand ?? readString(packageEvaluation?.["next_command"]))
      ? {
          recommended_command:
            recommendedCommand ?? readString(packageEvaluation?.["next_command"]),
        }
      : {}),
    ...(packageEvaluationSource ? { package_evaluation_source: packageEvaluationSource } : {}),
    ...(packageCandidateId ? { package_candidate_id: packageCandidateId } : {}),
    ...(packageParentCandidateId ? { package_parent_candidate_id: packageParentCandidateId } : {}),
    ...(packageCandidateGeneration != null
      ? { package_candidate_generation: packageCandidateGeneration }
      : {}),
    ...(packageCandidateAcceptanceDecision
      ? {
          package_candidate_acceptance_decision:
            packageCandidateAcceptanceDecision as DashboardActionResultSummary["package_candidate_acceptance_decision"],
        }
      : {}),
    ...(packageCandidateAcceptanceRationale
      ? { package_candidate_acceptance_rationale: packageCandidateAcceptanceRationale }
      : {}),
    ...(packageEvidence ? { package_evidence: packageEvidence } : {}),
    ...(packageEfficiency ? { package_efficiency: packageEfficiency } : {}),
    ...(packageRouting ? { package_routing: packageRouting } : {}),
    ...(packageBody ? { package_body: packageBody } : {}),
    ...(packageGrading ? { package_grading: packageGrading } : {}),
    ...(packageUnitTests ? { package_unit_tests: packageUnitTests } : {}),
    ...(packageWatch ? { package_watch: packageWatch } : {}),
  };
}

function buildPackageEvaluationSummary(
  packageEvaluation: Record<string, unknown> | null,
  options: {
    deployed: boolean | null;
    reason: string | null;
  },
): DashboardActionResultSummary | null {
  if (!packageEvaluation) return null;

  const replay = readObject(packageEvaluation["replay"]);
  const baseline = readObject(packageEvaluation["baseline"]);
  const recommendedCommand = readString(packageEvaluation["next_command"]);
  const packageEvaluationSource = readPackageEvaluationSource(
    packageEvaluation["evaluation_source"],
  );
  const packageCandidateId = readString(packageEvaluation["candidate_id"]);
  const packageParentCandidateId = readString(packageEvaluation["parent_candidate_id"]);
  const packageCandidateGeneration = readNumber(packageEvaluation["candidate_generation"]);
  const packageCandidateAcceptance = readObject(packageEvaluation["candidate_acceptance"]);
  const packageCandidateAcceptanceDecision = readString(packageCandidateAcceptance?.["decision"]);
  const packageCandidateAcceptanceRationale = readString(packageCandidateAcceptance?.["rationale"]);
  const packageEvidence = readPackageEvidenceSummary(packageEvaluation["evidence"]);
  const packageEfficiency = readPackageEfficiencySummary(packageEvaluation["efficiency"]);
  const packageRouting = readPackageReplaySummary(packageEvaluation["routing"]);
  const packageBody = readPackageBodySummary(packageEvaluation["body"]);
  const packageGrading = readPackageGradingSummary(packageEvaluation["grading"]);
  const packageUnitTests = readPackageUnitTestSummary(packageEvaluation["unit_tests"]);
  const packageWatch = readCreatePackageEvaluationWatchSummary(packageEvaluation["watch"]);

  return {
    reason: options.reason,
    improved: readBoolean(packageEvaluation["evaluation_passed"]),
    deployed: options.deployed,
    before_pass_rate: readNumber(baseline?.["baseline_pass_rate"]),
    after_pass_rate: readNumber(baseline?.["with_skill_pass_rate"]),
    net_change: readNumber(baseline?.["lift"]),
    validation_mode: readString(replay?.["validation_mode"]),
    ...(recommendedCommand ? { recommended_command: recommendedCommand } : {}),
    ...(packageEvaluationSource ? { package_evaluation_source: packageEvaluationSource } : {}),
    ...(packageCandidateId ? { package_candidate_id: packageCandidateId } : {}),
    ...(packageParentCandidateId ? { package_parent_candidate_id: packageParentCandidateId } : {}),
    ...(packageCandidateGeneration != null
      ? { package_candidate_generation: packageCandidateGeneration }
      : {}),
    ...(packageCandidateAcceptanceDecision
      ? {
          package_candidate_acceptance_decision:
            packageCandidateAcceptanceDecision as DashboardActionResultSummary["package_candidate_acceptance_decision"],
        }
      : {}),
    ...(packageCandidateAcceptanceRationale
      ? { package_candidate_acceptance_rationale: packageCandidateAcceptanceRationale }
      : {}),
    ...(packageEvidence ? { package_evidence: packageEvidence } : {}),
    ...(packageEfficiency ? { package_efficiency: packageEfficiency } : {}),
    ...(packageRouting ? { package_routing: packageRouting } : {}),
    ...(packageBody ? { package_body: packageBody } : {}),
    ...(packageGrading ? { package_grading: packageGrading } : {}),
    ...(packageUnitTests ? { package_unit_tests: packageUnitTests } : {}),
    ...(packageWatch ? { package_watch: packageWatch } : {}),
  };
}

function extractSearchRunSummary(
  parsed: Record<string, unknown>,
): DashboardSearchRunSummary | null {
  const searchId = readString(parsed["search_id"]);
  if (!searchId) return null;

  const provenance = parsed["provenance"];
  const prov =
    provenance && typeof provenance === "object" ? (provenance as Record<string, unknown>) : null;
  const surfacePlan =
    prov && typeof prov["surface_plan"] === "object"
      ? (prov["surface_plan"] as Record<string, unknown>)
      : null;

  return {
    search_id: searchId,
    parent_candidate_id: readString(parsed["parent_candidate_id"]),
    winner_candidate_id: readString(parsed["winner_candidate_id"]),
    winner_rationale: readString(parsed["winner_rationale"]),
    candidates_evaluated: readNumber(parsed["candidates_evaluated"]) ?? 0,
    frontier_size: prov ? (readNumber(prov["frontier_size"]) ?? 0) : 0,
    parent_selection_method: prov
      ? (readString(prov["parent_selection_method"]) ?? "unknown")
      : "unknown",
    ...(surfacePlan
      ? {
          surface_plan: {
            routing_count: readNumber(surfacePlan["routing_count"]) ?? 0,
            body_count: readNumber(surfacePlan["body_count"]) ?? 0,
            weakness_source: readString(surfacePlan["weakness_source"]) ?? "unknown",
            routing_weakness: readNumber(surfacePlan["routing_weakness"]),
            body_weakness: readNumber(surfacePlan["body_weakness"]),
          },
        }
      : {}),
  };
}

export function extractDashboardActionSummary(
  action: DashboardActionName,
  stdout: string,
): DashboardActionResultSummary | null {
  const parsed = extractJsonObject(stdout);
  if (!parsed) return null;

  if (action === "create-check") {
    const readiness = readObject(parsed["readiness"]);
    const specValidation = readObject(parsed["spec_validation"]);
    const ok = readBoolean(parsed["ok"]);
    const state = readString(parsed["state"]);
    const recommendedCommand = readString(readiness?.["recommended_command"]);

    return {
      reason:
        readString(readiness?.["summary"]) ??
        (ok === true
          ? "Draft package passed create check"
          : state
            ? `Draft package is in ${state.replaceAll("_", " ")} state`
            : null),
      improved: ok,
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: readString(specValidation?.["validator"]),
      ...(recommendedCommand ? { recommended_command: recommendedCommand } : {}),
    };
  }

  if (action === "replay-dry-run") {
    return {
      reason: readString(parsed["reason"]),
      improved: readBoolean(parsed["improved"]),
      deployed: readBoolean(parsed["deployed"]),
      before_pass_rate: readNumber(parsed["before_pass_rate"]) ?? readNumber(parsed["before"]),
      after_pass_rate: readNumber(parsed["after_pass_rate"]) ?? readNumber(parsed["after"]),
      net_change: readNumber(parsed["net_change"]),
      validation_mode: readString(parsed["validation_mode"]),
    };
  }

  if (action === "search-run") {
    const searchRun = extractSearchRunSummary(parsed);
    const packageSummary = buildPackageEvaluationSummary(readObject(parsed["package_evaluation"]), {
      deployed: false,
      reason: readString(parsed["winner_rationale"]),
    });
    return {
      ...(packageSummary ?? {
        reason: readString(parsed["winner_rationale"]),
        improved: readBoolean(parsed["improved"]) ?? searchRun?.winner_candidate_id != null,
        deployed: null,
        before_pass_rate: null,
        after_pass_rate: null,
        net_change: null,
        validation_mode: null,
        ...(readString(parsed["next_command"])
          ? { recommended_command: readString(parsed["next_command"]) }
          : {}),
      }),
      search_run: searchRun,
    };
  }

  if (action === "measure-baseline") {
    const packageEfficiency = readPackageEfficiencySummary(parsed["runtime_metrics"]);
    return {
      reason:
        readBoolean(parsed["adds_value"]) === false ? "Baseline gate failed" : "Baseline measured",
      improved: readBoolean(parsed["adds_value"]),
      deployed: null,
      before_pass_rate: readNumber(parsed["baseline_pass_rate"]),
      after_pass_rate: readNumber(parsed["with_skill_pass_rate"]),
      net_change: readNumber(parsed["lift"]),
      validation_mode: readString(parsed["mode"]) === "package" ? "host_replay" : null,
      ...(packageEfficiency ? { package_efficiency: packageEfficiency } : {}),
    };
  }

  if (action === "report-package") {
    const report = readObject(parsed["report"]);
    const summary = readObject(parsed["summary"]) ?? readObject(report?.["summary"]);
    const status = readString(summary?.["status"]);
    const packageSummary = buildPackageEvaluationSummary(summary, {
      deployed: null,
      reason:
        status === "replay_failed"
          ? "Package report detected replay failures"
          : status === "baseline_failed"
            ? "Package report detected a baseline regression"
            : "Package report ready",
    });
    if (packageSummary) {
      return packageSummary;
    }

    const readiness = readObject(parsed["readiness"]);
    const verified = readBoolean(parsed["verified"]);
    const readinessState =
      readString(parsed["readiness_state"]) ?? readString(readiness?.["state"]);
    const recommendedCommand =
      readString(parsed["next_command"]) ?? readString(readiness?.["next_command"]);

    return {
      reason:
        readString(readiness?.["summary"]) ??
        (readinessState
          ? `Draft package is in ${readinessState.replaceAll("_", " ")} state`
          : null),
      improved: verified ?? readBoolean(readiness?.["ok"]),
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: null,
      ...(recommendedCommand ? { recommended_command: recommendedCommand } : {}),
    };
  }

  if (action === "deploy-candidate" || action === "watch") {
    const packageEvaluation = readObject(parsed["package_evaluation"]);

    if (action === "watch") {
      const directWatchSummary = buildWatchSummary(parsed);
      if (directWatchSummary) return directWatchSummary;

      const nestedWatchResult = readObject(parsed["watch_result"]);
      const nestedWatchSummary = nestedWatchResult
        ? buildWatchSummary(
            nestedWatchResult,
            "Package evaluation passed and watch started",
            packageEvaluation,
          )
        : null;
      if (nestedWatchSummary) return nestedWatchSummary;
    }

    const status = readString(packageEvaluation?.["status"]);
    const published = readBoolean(parsed["published"]);
    const watchGatePassed =
      action === "watch"
        ? readString(parsed["alert"]) == null
        : (readBoolean(parsed["watch_gate_passed"]) ?? null);
    const baseSummary = buildPackageEvaluationSummary(packageEvaluation, {
      deployed: published,
      reason:
        status === "replay_failed"
          ? "Package replay failed"
          : status === "baseline_failed"
            ? "Package baseline failed"
            : action === "watch" && readBoolean(parsed["watch_started"])
              ? "Package evaluation passed and watch started"
              : published
                ? "Package evaluation passed"
                : null,
    });
    if (baseSummary) {
      return { ...baseSummary, watch_gate_passed: watchGatePassed };
    }
    return baseSummary;
  }

  return null;
}

function isSuccessfulReplayDryRun(summary: DashboardActionResultSummary | null): boolean {
  if (!summary) return false;

  return (
    summary.reason === "Dry run - proposal validated but not deployed" &&
    summary.improved === true &&
    summary.deployed === false
  );
}

export function resolveDashboardActionOutcome(
  input: DashboardActionOutcomeInput,
): DashboardActionOutcome {
  const summary = extractDashboardActionSummary(input.action, input.stdout);

  if (input.action === "watch" && summary?.improved === false) {
    return {
      success: false,
      summary,
      error: summary.reason ?? input.stderr ?? "Watch detected a regression",
    };
  }

  if (input.exitCode === 0) {
    return { success: true, error: null, summary };
  }

  if (input.action === "replay-dry-run" && isSuccessfulReplayDryRun(summary)) {
    return { success: true, error: null, summary };
  }

  return {
    success: false,
    summary,
    error:
      input.stderr ||
      (input.exitCode == null ? "Unknown action failure" : `Exit code ${input.exitCode}`),
  };
}
