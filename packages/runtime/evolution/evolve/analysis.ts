import type { GradingResult } from "../../types.js";
import type { AggregateMetrics } from "../propose-description.js";

export function computeAggregateMetrics(
  gradingResults: GradingResult[] | undefined,
): AggregateMetrics | undefined {
  if (!gradingResults?.length) return undefined;

  const scores = gradingResults.map(
    (result) => result.summary.mean_score ?? result.summary.pass_rate,
  );
  const meanScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const scoreStdDev = Math.sqrt(
    scores.reduce((sum, score) => sum + (score - meanScore) ** 2, 0) / scores.length,
  );
  const failedRate =
    gradingResults.filter((result) => result.summary.failed > 0).length / gradingResults.length;
  const errors = gradingResults.map((result) => result.execution_metrics?.errors_encountered ?? 0);

  return {
    mean_score: meanScore,
    score_std_dev: scoreStdDev,
    failed_session_rate: failedRate,
    mean_errors:
      errors.reduce((sum, errorsEncountered) => sum + errorsEncountered, 0) / errors.length,
    total_graded: gradingResults.length,
  };
}
