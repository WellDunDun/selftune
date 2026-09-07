import type { Database } from "bun:sqlite";

import type { SyncResult } from "@selftune/source-management/sync";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { classifyInvocation } from "../../eval/hooks-to-evals.js";
import {
  queryEvolutionAudit,
  queryGradingBaseline,
  queryQueryLog,
  queryRecentGradingResults,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../../localdb/queries.js";
import { readCanonicalPackageEvaluationArtifact } from "../../testing-readiness.js";
import type {
  CreatePackageEvaluationWatchEfficiencyRegressionSummary,
  InvocationType,
  MonitoringSnapshot,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../types.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "../../utils/query-filter.js";

const DEFAULT_BASELINE_PASS_RATE = 0.5;
const DEFAULT_REGRESSION_THRESHOLD = 0.1;
const DEFAULT_GRADE_REGRESSION_THRESHOLD = 0.15;
const DEFAULT_EFFICIENCY_REGRESSION_THRESHOLD = 0.25;
const decodeBaseline = Schema.decodeUnknownOption(Schema.Struct({ pass_rate: Schema.Number }));
export const MIN_MONITORING_SKILL_CHECKS = 3;

export interface WatchEvaluationOptions {
  readonly skillName: string;
  readonly skillPath: string;
  readonly windowSessions?: number;
  readonly regressionThreshold?: number;
  readonly gradeRegressionThreshold?: number;
  readonly enableGradeWatch?: boolean;
  readonly efficiencyRegressionThreshold?: number;
  readonly enableEfficiencyWatch?: boolean;
  /** Retained for callers that still provide the retired JSONL audit path. */
  readonly auditLogPath?: string;
}

export interface WatchDiagnostic {
  readonly code: "grade_watch_failed";
  readonly message: string;
}

export interface WatchEvaluationDependencies {
  readonly db: Database;
  readonly readPackageEvaluationArtifact: typeof readCanonicalPackageEvaluationArtifact;
  readonly onDiagnostic: (diagnostic: WatchDiagnostic) => void;
}

export interface WatchEvaluationResult {
  readonly skillPath: string;
  readonly snapshot: MonitoringSnapshot;
  readonly alert: string | null;
  readonly proposalId?: string;
  readonly gradeAlert: string | null;
  readonly gradeRegression: { before: number; after: number; delta: number } | null;
  readonly efficiencyAlert: string | null;
  readonly efficiencyRegression: CreatePackageEvaluationWatchEfficiencyRegressionSummary | null;
}

export interface WatchResult {
  snapshot: MonitoringSnapshot;
  alert: string | null;
  rolledBack: boolean;
  recommendation: string;
  recommended_command?: string | null;
  sync_result?: SyncResult;
  gradeAlert?: string | null;
  gradeRegression?: { before: number; after: number; delta: number } | null;
  efficiencyAlert?: string | null;
  efficiencyRegression?: CreatePackageEvaluationWatchEfficiencyRegressionSummary | null;
}

export function makeWatchEvaluationDependencies(
  db: Database,
  onDiagnostic: (diagnostic: WatchDiagnostic) => void = () => {},
): WatchEvaluationDependencies {
  return {
    db,
    readPackageEvaluationArtifact: readCanonicalPackageEvaluationArtifact,
    onDiagnostic,
  };
}

type MonitoringWindow = {
  telemetry: SessionTelemetryRecord[];
  skillRecords: SkillUsageRecord[];
  queryRecords: QueryLogRecord[];
};

function selectMonitoringWindow(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  windowSessions: number,
): MonitoringWindow {
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const windowedTelemetry = telemetry.slice(-windowSessions);
  const windowedSessionIds = new Set(windowedTelemetry.map((record) => record.session_id));

  const skillNameFiltered = actionableSkillRecords.filter(
    (record) => record.skill_name === skillName,
  );
  const hasSessionOverlap =
    windowedSessionIds.size > 0 &&
    (skillNameFiltered.some((record) => windowedSessionIds.has(record.session_id)) ||
      actionableQueryRecords.some((record) => windowedSessionIds.has(record.session_id)));

  return {
    telemetry: hasSessionOverlap
      ? windowedTelemetry.filter((record) => windowedSessionIds.has(record.session_id))
      : telemetry,
    skillRecords: hasSessionOverlap
      ? skillNameFiltered.filter((record) => windowedSessionIds.has(record.session_id))
      : skillNameFiltered,
    queryRecords: hasSessionOverlap
      ? actionableQueryRecords.filter((record) => windowedSessionIds.has(record.session_id))
      : actionableQueryRecords,
  };
}

function averageNullable(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value) => value != null);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function divideNullable(
  total: number | null | undefined,
  count: number | null | undefined,
): number | null {
  if (total == null || count == null || count <= 0) return null;
  return total / count;
}

function computeDeltaRatio(observed: number | null, baseline: number | null): number | null {
  if (observed == null || baseline == null || baseline <= 0) return null;
  return (observed - baseline) / baseline;
}

function buildEfficiencyRegression(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  skillRecords: SkillUsageRecord[],
  efficiencyRegressionThreshold: number,
  dependencies: WatchEvaluationDependencies,
): Pick<WatchEvaluationResult, "efficiencyAlert" | "efficiencyRegression"> {
  const baselineEfficiency =
    dependencies.readPackageEvaluationArtifact(skillName)?.summary.efficiency?.with_skill;
  if (!baselineEfficiency) {
    return { efficiencyAlert: null, efficiencyRegression: null };
  }

  const triggeredSessionIds = new Set(
    skillRecords.filter((record) => record.triggered).map((record) => record.session_id),
  );
  if (triggeredSessionIds.size < MIN_MONITORING_SKILL_CHECKS) {
    return { efficiencyAlert: null, efficiencyRegression: null };
  }

  const observedTelemetry = telemetry.filter((record) =>
    triggeredSessionIds.has(record.session_id),
  );
  if (observedTelemetry.length < MIN_MONITORING_SKILL_CHECKS) {
    return { efficiencyAlert: null, efficiencyRegression: null };
  }

  const efficiencyRegression: CreatePackageEvaluationWatchEfficiencyRegressionSummary = {
    sample_size: observedTelemetry.length,
    baseline_avg_duration_ms: baselineEfficiency.avg_duration_ms,
    observed_avg_duration_ms: averageNullable(
      observedTelemetry.map((record) => record.duration_ms ?? null),
    ),
    duration_delta_ratio: null,
    baseline_avg_input_tokens: divideNullable(
      baselineEfficiency.total_input_tokens,
      baselineEfficiency.eval_runs,
    ),
    observed_avg_input_tokens: averageNullable(
      observedTelemetry.map((record) => record.input_tokens ?? null),
    ),
    input_tokens_delta_ratio: null,
    baseline_avg_output_tokens: divideNullable(
      baselineEfficiency.total_output_tokens,
      baselineEfficiency.eval_runs,
    ),
    observed_avg_output_tokens: averageNullable(
      observedTelemetry.map((record) => record.output_tokens ?? null),
    ),
    output_tokens_delta_ratio: null,
    baseline_avg_turns: divideNullable(
      baselineEfficiency.total_turns,
      baselineEfficiency.eval_runs,
    ),
    observed_avg_turns: averageNullable(
      observedTelemetry.map((record) => record.assistant_turns ?? null),
    ),
    turns_delta_ratio: null,
  };

  efficiencyRegression.duration_delta_ratio = computeDeltaRatio(
    efficiencyRegression.observed_avg_duration_ms,
    efficiencyRegression.baseline_avg_duration_ms,
  );
  efficiencyRegression.input_tokens_delta_ratio = computeDeltaRatio(
    efficiencyRegression.observed_avg_input_tokens,
    efficiencyRegression.baseline_avg_input_tokens,
  );
  efficiencyRegression.output_tokens_delta_ratio = computeDeltaRatio(
    efficiencyRegression.observed_avg_output_tokens,
    efficiencyRegression.baseline_avg_output_tokens,
  );
  efficiencyRegression.turns_delta_ratio = computeDeltaRatio(
    efficiencyRegression.observed_avg_turns,
    efficiencyRegression.baseline_avg_turns,
  );

  const regressions: string[] = [];
  const pushRegression = (label: string, ratio: number | null) => {
    if (ratio != null && ratio > efficiencyRegressionThreshold) {
      regressions.push(`${label} +${(ratio * 100).toFixed(1)}%`);
    }
  };
  pushRegression("duration", efficiencyRegression.duration_delta_ratio);
  pushRegression("input_tokens", efficiencyRegression.input_tokens_delta_ratio);
  pushRegression("output_tokens", efficiencyRegression.output_tokens_delta_ratio);
  pushRegression("turns", efficiencyRegression.turns_delta_ratio);

  return {
    efficiencyAlert:
      regressions.length > 0
        ? `efficiency regression detected for "${skillName}": ${regressions.join(", ")} exceeds threshold=${(efficiencyRegressionThreshold * 100).toFixed(1)}%`
        : null,
    efficiencyRegression,
  };
}

/** Compute a monitoring snapshot from caller-supplied records. */
export function computeMonitoringSnapshot(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  windowSessions: number,
  baselinePassRate: number,
  regressionThreshold: number = DEFAULT_REGRESSION_THRESHOLD,
): MonitoringSnapshot {
  const { skillRecords: filteredSkillRecords, queryRecords: filteredQueryRecords } =
    selectMonitoringWindow(skillName, telemetry, skillRecords, queryRecords, windowSessions);

  const triggeredCount = filteredSkillRecords.filter((record) => record.triggered).length;
  const totalSkillChecks = filteredSkillRecords.length;
  const passRate = totalSkillChecks === 0 ? 0 : triggeredCount / totalSkillChecks;
  const falseNegatives = filteredSkillRecords.filter((record) => !record.triggered).length;
  const falseNegativeRate = totalSkillChecks === 0 ? 0 : falseNegatives / totalSkillChecks;

  const byInvocationType: Record<InvocationType, { passed: number; total: number }> = {
    explicit: { passed: 0, total: 0 },
    implicit: { passed: 0, total: 0 },
    contextual: { passed: 0, total: 0 },
    negative: { passed: 0, total: 0 },
  };
  for (const record of filteredSkillRecords) {
    const invocationType = classifyInvocation(record.query, skillName);
    byInvocationType[invocationType].total++;
    if (record.triggered) byInvocationType[invocationType].passed++;
  }

  const precision = 1e10;
  const adjustedThreshold =
    Math.round((baselinePassRate - regressionThreshold) * precision) / precision;
  const roundedPassRate = Math.round(passRate * precision) / precision;
  const hasEnoughSignalForRegression =
    totalSkillChecks >= MIN_MONITORING_SKILL_CHECKS ||
    (totalSkillChecks === 0 && filteredQueryRecords.length >= MIN_MONITORING_SKILL_CHECKS);

  return {
    timestamp: new Date().toISOString(),
    skill_name: skillName,
    window_sessions: windowSessions,
    skill_checks: totalSkillChecks,
    pass_rate: passRate,
    false_negative_rate: falseNegativeRate,
    by_invocation_type: byInvocationType,
    regression_detected: hasEnoughSignalForRegression && roundedPassRate < adjustedThreshold,
    baseline_pass_rate: baselinePassRate,
  };
}

function latestDeployedProposal(db: Database, skillName: string) {
  const directEntries = queryEvolutionAudit(db, skillName);
  const entries =
    directEntries.length > 0
      ? directEntries
      : queryEvolutionAudit(db).filter((entry) =>
          entry.details.toLowerCase().includes(skillName.toLowerCase()),
        );
  return entries.find((entry) => entry.action === "deployed");
}

/**
 * Evaluate watch signals using an explicit database and explicit side-effect
 * readers. Sync, rollback, memory persistence, and terminal rendering belong to
 * the caller.
 */
export function evaluateWatch(
  options: WatchEvaluationOptions,
  dependencies: WatchEvaluationDependencies,
): WatchEvaluationResult {
  const {
    skillName,
    skillPath,
    windowSessions = 20,
    regressionThreshold = DEFAULT_REGRESSION_THRESHOLD,
    gradeRegressionThreshold = DEFAULT_GRADE_REGRESSION_THRESHOLD,
    enableGradeWatch = true,
    efficiencyRegressionThreshold = DEFAULT_EFFICIENCY_REGRESSION_THRESHOLD,
    enableEfficiencyWatch = true,
  } = options;

  const telemetry = querySessionTelemetry(dependencies.db);
  telemetry.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const skillRecords = querySkillUsageRecords(dependencies.db);
  const queryRecords = queryQueryLog(dependencies.db);
  const lastDeployed = latestDeployedProposal(dependencies.db, skillName);
  const baselinePassRate = decodeBaseline(lastDeployed?.eval_snapshot).pipe(
    Option.map((baseline) => baseline.pass_rate),
    Option.getOrElse(() => DEFAULT_BASELINE_PASS_RATE),
  );

  const snapshot = computeMonitoringSnapshot(
    skillName,
    telemetry,
    skillRecords,
    queryRecords,
    windowSessions,
    baselinePassRate,
    regressionThreshold,
  );
  const monitoringWindow = selectMonitoringWindow(
    skillName,
    telemetry,
    skillRecords,
    queryRecords,
    windowSessions,
  );

  const triggerAlert = snapshot.regression_detected
    ? `regression detected for "${skillName}": pass_rate=${snapshot.pass_rate.toFixed(2)} below baseline=${baselinePassRate.toFixed(2)} minus threshold=${regressionThreshold.toFixed(2)}`
    : null;

  let gradeAlert: string | null = null;
  let gradeRegression: { before: number; after: number; delta: number } | null = null;
  if (enableGradeWatch) {
    try {
      const baseline = queryGradingBaseline(dependencies.db, skillName, lastDeployed?.proposal_id);
      const recentResults = queryRecentGradingResults(dependencies.db, skillName, 10);
      if (baseline && recentResults.length > 0) {
        const validResults = recentResults.filter((result) => result.pass_rate != null);
        if (validResults.length > 0) {
          const recentAvgPassRate =
            validResults.reduce((sum, result) => sum + (result.pass_rate ?? 0), 0) /
            validResults.length;
          const delta = baseline.pass_rate - recentAvgPassRate;
          if (delta > gradeRegressionThreshold) {
            gradeAlert = `grade regression detected for "${skillName}": baseline_grade_pass_rate=${baseline.pass_rate.toFixed(2)}, recent_avg=${recentAvgPassRate.toFixed(2)}, delta=${delta.toFixed(2)} exceeds threshold=${gradeRegressionThreshold.toFixed(2)}`;
            gradeRegression = {
              before: baseline.pass_rate,
              after: recentAvgPassRate,
              delta,
            };
          }
        }
      }
    } catch (error) {
      dependencies.onDiagnostic({
        code: "grade_watch_failed",
        message: `Grade watch failed for "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const efficiency = enableEfficiencyWatch
    ? buildEfficiencyRegression(
        skillName,
        monitoringWindow.telemetry,
        monitoringWindow.skillRecords,
        efficiencyRegressionThreshold,
        dependencies,
      )
    : { efficiencyAlert: null, efficiencyRegression: null };
  const alerts = [triggerAlert, gradeAlert, efficiency.efficiencyAlert].filter(
    (value): value is string => Boolean(value),
  );

  const evaluation: WatchEvaluationResult = {
    skillPath,
    snapshot,
    alert: alerts.length > 0 ? alerts.join("\n") : null,
    gradeAlert,
    gradeRegression,
    efficiencyAlert: efficiency.efficiencyAlert,
    efficiencyRegression: efficiency.efficiencyRegression,
  };
  return lastDeployed ? { ...evaluation, proposalId: lastDeployed.proposal_id } : evaluation;
}

export function buildWatchResult(
  evaluation: WatchEvaluationResult,
  rolledBack: boolean,
  syncResult?: SyncResult,
): WatchResult {
  let recommendation: string;
  let recommendedCommand: string | null = null;
  if (evaluation.alert) {
    recommendedCommand = rolledBack
      ? null
      : `selftune rollback --skill ${evaluation.snapshot.skill_name} --skill-path ${evaluation.skillPath}`;
    recommendation = rolledBack
      ? `Rolled back "${evaluation.snapshot.skill_name}" to previous version. Monitor to confirm recovery.`
      : `Consider running: ${recommendedCommand}`;
  } else if (evaluation.snapshot.skill_checks < MIN_MONITORING_SKILL_CHECKS) {
    recommendation =
      `Skill "${evaluation.snapshot.skill_name}" has only ${evaluation.snapshot.skill_checks} actionable check(s) in the current window. ` +
      `Need at least ${MIN_MONITORING_SKILL_CHECKS} before calling it stable.`;
  } else {
    recommendation = `Skill "${evaluation.snapshot.skill_name}" is stable. Pass rate ${evaluation.snapshot.pass_rate.toFixed(2)} is within acceptable range of baseline ${evaluation.snapshot.baseline_pass_rate.toFixed(2)}.`;
  }

  const result: WatchResult = {
    snapshot: evaluation.snapshot,
    alert: evaluation.alert,
    rolledBack,
    recommendation,
    recommended_command: recommendedCommand,
    gradeAlert: evaluation.gradeAlert,
    gradeRegression: evaluation.gradeRegression,
  };
  if (evaluation.efficiencyAlert || evaluation.efficiencyRegression) {
    result.efficiencyAlert = evaluation.efficiencyAlert;
    result.efficiencyRegression = evaluation.efficiencyRegression;
  }
  if (syncResult) result.sync_result = syncResult;
  return result;
}
