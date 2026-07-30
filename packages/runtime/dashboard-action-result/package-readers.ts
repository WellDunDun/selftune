import type {
  CreatePackageBodySummary,
  CreatePackageEvaluationEfficiencySummary,
  CreatePackageEvaluationEvidenceSample,
  CreatePackageEvaluationEvidenceSummary,
  CreatePackageEvaluationGradingSummary,
  CreatePackageEvaluationSource,
  CreatePackageEvaluationUnitTestSummary,
  CreatePackageReplaySummary,
  RuntimeReplayAggregateMetrics,
} from "../types.js";

export function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function readEvidenceSample(value: unknown): CreatePackageEvaluationEvidenceSample | null {
  const sample = readObject(value);
  const query = readString(sample?.["query"]);
  if (!query) return null;

  return {
    query,
    evidence: readString(sample?.["evidence"]),
  };
}

export function readEvidenceSamples(value: unknown): CreatePackageEvaluationEvidenceSample[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((sample) => readEvidenceSample(sample))
    .filter((sample): sample is CreatePackageEvaluationEvidenceSample => sample != null);
}

export function readRuntimeReplayAggregateMetrics(
  value: unknown,
): RuntimeReplayAggregateMetrics | null {
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

export function readPackageEvidenceSummary(
  value: unknown,
): CreatePackageEvaluationEvidenceSummary | null {
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

export function readPackageEfficiencySummary(
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

export function readPackageEvaluationSource(value: unknown): CreatePackageEvaluationSource | null {
  const source = readString(value);
  if (source !== "fresh" && source !== "artifact_cache" && source !== "candidate_cache") {
    return null;
  }
  return source;
}

export function readPackageReplaySummary(value: unknown): CreatePackageReplaySummary | null {
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

export function readPackageBodySummary(value: unknown): CreatePackageBodySummary | null {
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

export function readPackageGradingSummary(
  value: unknown,
): CreatePackageEvaluationGradingSummary | null {
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

export function readPackageUnitTestSummary(
  value: unknown,
): CreatePackageEvaluationUnitTestSummary | null {
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
