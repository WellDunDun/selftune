import { Schema } from "effect";
import type { CliJsonOutput } from "../utils/json-output.js";
import type { DashboardActionResultSummary } from "../dashboard-contract.js";
import type { CreatePackageEvaluationWatchSummary, MonitoringSnapshot } from "../types.js";
import {
  readBoolean,
  readCandidateAcceptanceDecision,
  readNumber,
  readObject,
  readPackageBodySummary,
  readPackageEfficiencySummary,
  readPackageEvaluationSource,
  readPackageEvidenceSummary,
  readPackageGradingSummary,
  readPackageReplaySummary,
  readPackageUnitTestSummary,
  readString,
} from "./package-readers.js";

function readInvocationTotals(
  value: typeof Schema.Json.Type | undefined,
): MonitoringSnapshot["by_invocation_type"]["explicit"] | null {
  const entry = readObject(value);
  const passed = readNumber(entry?.["passed"]);
  const total = readNumber(entry?.["total"]);
  if (passed == null || total == null) return null;

  return { passed, total };
}

function readMonitoringSnapshot(
  value: typeof Schema.Json.Type | undefined,
): MonitoringSnapshot | null {
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
  value: typeof Schema.Json.Type | undefined,
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
  value: typeof Schema.Json.Type | undefined,
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
  value: typeof Schema.Json.Type | undefined,
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
    efficiency_alert:
      (readString(summary["efficiency_alert"]) ?? readString(summary["efficiencyAlert"]))
        ? (readString(summary["efficiency_alert"]) ?? readString(summary["efficiencyAlert"]))
        : undefined,
    efficiency_regression:
      (readEfficiencyRegression(summary["efficiency_regression"]) ??
      readEfficiencyRegression(summary["efficiencyRegression"]))
        ? (readEfficiencyRegression(summary["efficiency_regression"]) ??
          readEfficiencyRegression(summary["efficiencyRegression"]))
        : undefined,
  };
}

function subtractRates(current: number | null, baseline: number | null): number | null {
  if (current == null || baseline == null) return null;
  return Number.parseFloat((current - baseline).toFixed(4));
}

export function buildWatchSummary(
  watchResult: CliJsonOutput,
  fallbackReason: string | null = null,
  packageEvaluation: CliJsonOutput | null = null,
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
  const packageCandidateAcceptanceDecision = readCandidateAcceptanceDecision(
    packageCandidateAcceptance?.["decision"],
  );
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
    recommended_command:
      (recommendedCommand ?? readString(packageEvaluation?.["next_command"]))
        ? (recommendedCommand ?? readString(packageEvaluation?.["next_command"]))
        : undefined,
    package_evaluation_source: packageEvaluationSource ?? undefined,
    package_candidate_id: packageCandidateId ?? undefined,
    package_parent_candidate_id: packageParentCandidateId ?? undefined,
    package_candidate_generation: packageCandidateGeneration ?? undefined,
    package_candidate_acceptance_decision: packageCandidateAcceptanceDecision ?? undefined,
    package_candidate_acceptance_rationale: packageCandidateAcceptanceRationale ?? undefined,
    package_evidence: packageEvidence ?? undefined,
    package_efficiency: packageEfficiency ?? undefined,
    package_routing: packageRouting ?? undefined,
    package_body: packageBody ?? undefined,
    package_grading: packageGrading ?? undefined,
    package_unit_tests: packageUnitTests ?? undefined,
    package_watch: packageWatch ?? undefined,
  };
}
