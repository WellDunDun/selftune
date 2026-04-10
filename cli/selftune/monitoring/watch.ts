/**
 * Post-deploy monitoring: compute snapshots and detect regressions (TASK-16).
 *
 * Exports:
 *  - computeMonitoringSnapshot  (pure function, deterministic)
 *  - watch                      (reads log files, computes snapshot, optionally rolls back)
 */

import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import { classifyInvocation } from "../eval/hooks-to-evals.js";
import { getLastDeployedProposal } from "../evolution/audit.js";
import { getDb } from "../localdb/db.js";
import {
  queryGradingBaseline,
  queryQueryLog,
  queryRecentGradingResults,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../localdb/queries.js";
import { updateContextAfterWatch } from "../memory/writer.js";
import type { SyncResult } from "../sync.js";
import type {
  InvocationType,
  MonitoringSnapshot,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "../utils/query-filter.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface WatchOptions {
  skillName: string;
  skillPath: string;
  windowSessions: number;
  regressionThreshold: number;
  autoRollback: boolean;
  /** Grade regression threshold (default 0.15). */
  gradeRegressionThreshold?: number;
  /** Enable grade-based regression watch (default true). */
  enableGradeWatch?: boolean;
  /** Injected log paths for testing (override defaults). */
  _telemetryLogPath?: string;
  _skillLogPath?: string;
  _queryLogPath?: string;
  _auditLogPath?: string;
  /** Injected rollback function for testing. */
  _rollbackFn?: (opts: {
    skillName: string;
    skillPath: string;
    proposalId?: string;
  }) => Promise<{ rolledBack: boolean; restoredDescription: string; reason: string }>;
  /** Source-truth refresh before reading logs. */
  syncFirst?: boolean;
  syncForce?: boolean;
  _syncFn?: typeof import("../sync.js").syncSources;
}

export interface WatchResult {
  snapshot: MonitoringSnapshot;
  alert: string | null;
  rolledBack: boolean;
  recommendation: string;
  sync_result?: SyncResult;
  gradeAlert?: string | null;
  gradeRegression?: { before: number; after: number; delta: number } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASELINE_PASS_RATE = 0.5;
const DEFAULT_REGRESSION_THRESHOLD = 0.1;
const DEFAULT_GRADE_REGRESSION_THRESHOLD = 0.15;
export const MIN_MONITORING_SKILL_CHECKS = 3;

// ---------------------------------------------------------------------------
// computeMonitoringSnapshot - pure function
// ---------------------------------------------------------------------------

/**
 * Compute a monitoring snapshot from raw log records.
 *
 * The function windows telemetry to the last `windowSessions` entries, then
 * scopes skill and actionable query records to those sessions. If telemetry is
 * empty or no records match the windowed session IDs, all provided skill/query
 * records are used directly (unfiltered by session).
 *
 * @param skillName        - The skill to monitor
 * @param telemetry        - All session telemetry records
 * @param skillRecords     - All skill usage records
 * @param queryRecords     - All query log records
 * @param windowSessions   - Max number of recent sessions to consider
 * @param baselinePassRate - The baseline pass rate for regression detection
 * @param regressionThreshold - Drop below baseline minus this triggers regression (default 0.10)
 */
export function computeMonitoringSnapshot(
  skillName: string,
  telemetry: SessionTelemetryRecord[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  windowSessions: number,
  baselinePassRate: number,
  regressionThreshold: number = DEFAULT_REGRESSION_THRESHOLD,
): MonitoringSnapshot {
  // 1. Window the telemetry to the last N sessions (by array order, assumed chronological)
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const windowedTelemetry = telemetry.slice(-windowSessions);
  const windowedSessionIds = new Set(windowedTelemetry.map((t) => t.session_id));

  // 2. Filter skill records by skill name first
  const skillNameFiltered = actionableSkillRecords.filter((r) => r.skill_name === skillName);

  // 3. Apply session ID windowing only if telemetry is present and overlaps
  const hasSessionOverlap =
    windowedSessionIds.size > 0 &&
    (skillNameFiltered.some((r) => windowedSessionIds.has(r.session_id)) ||
      actionableQueryRecords.some((r) => windowedSessionIds.has(r.session_id)));

  const filteredSkillRecords = hasSessionOverlap
    ? skillNameFiltered.filter((r) => windowedSessionIds.has(r.session_id))
    : skillNameFiltered;
  const filteredQueryRecords = hasSessionOverlap
    ? actionableQueryRecords.filter((r) => windowedSessionIds.has(r.session_id))
    : actionableQueryRecords;

  // 4. Compute pass rate from explicit skill checks, not from all queries.
  const triggeredCount = filteredSkillRecords.filter((r) => r.triggered).length;
  const totalSkillChecks = filteredSkillRecords.length;
  const passRate = totalSkillChecks === 0 ? 0 : triggeredCount / totalSkillChecks;

  // 5. Compute false negative rate from skill usage records
  const falseNegatives = filteredSkillRecords.filter((r) => !r.triggered).length;
  const falseNegativeRate = totalSkillChecks === 0 ? 0 : falseNegatives / totalSkillChecks;

  // 6. by_invocation_type: classify each skill record using classifyInvocation
  const byInvocationType: Record<InvocationType, { passed: number; total: number }> = {
    explicit: { passed: 0, total: 0 },
    implicit: { passed: 0, total: 0 },
    contextual: { passed: 0, total: 0 },
    negative: { passed: 0, total: 0 },
  };
  for (const record of filteredSkillRecords) {
    const invType = classifyInvocation(
      typeof record.query === "string" ? record.query : "",
      skillName,
    );
    byInvocationType[invType].total++;
    if (record.triggered) {
      byInvocationType[invType].passed++;
    }
  }

  // 7. Regression detection: pass_rate < baseline - threshold
  // Use rounding to avoid floating-point boundary issues (e.g. 0.8 - 0.1 = 0.7000000000000001)
  const precision = 1e10;
  const adjustedThreshold =
    Math.round((baselinePassRate - regressionThreshold) * precision) / precision;
  const roundedPassRate = Math.round(passRate * precision) / precision;
  const hasEnoughSignalForRegression =
    totalSkillChecks >= MIN_MONITORING_SKILL_CHECKS ||
    (totalSkillChecks === 0 && filteredQueryRecords.length >= MIN_MONITORING_SKILL_CHECKS);
  const regressionDetected = hasEnoughSignalForRegression && roundedPassRate < adjustedThreshold;

  return {
    timestamp: new Date().toISOString(),
    skill_name: skillName,
    window_sessions: windowSessions,
    skill_checks: totalSkillChecks,
    pass_rate: passRate,
    false_negative_rate: falseNegativeRate,
    by_invocation_type: byInvocationType,
    regression_detected: regressionDetected,
    baseline_pass_rate: baselinePassRate,
  };
}

// ---------------------------------------------------------------------------
// watch - reads logs, computes snapshot, optionally rolls back
// ---------------------------------------------------------------------------

/**
 * Run the post-deploy monitoring check for a skill.
 */
export async function watch(options: WatchOptions): Promise<WatchResult> {
  const {
    skillName,
    skillPath,
    windowSessions = 20,
    regressionThreshold = DEFAULT_REGRESSION_THRESHOLD,
    gradeRegressionThreshold = DEFAULT_GRADE_REGRESSION_THRESHOLD,
    enableGradeWatch = true,
    autoRollback = false,
    _telemetryLogPath = TELEMETRY_LOG,
    _skillLogPath = SKILL_LOG,
    _queryLogPath = QUERY_LOG,
    _auditLogPath,
    _rollbackFn,
    syncFirst = false,
    syncForce = false,
    _syncFn,
  } = options;

  let syncResult: SyncResult | undefined;
  if (syncFirst) {
    const { createDefaultSyncOptions, syncSources: realSyncSources } = await import("../sync.js");
    const syncRunner = _syncFn ?? realSyncSources;
    syncResult = syncRunner(
      createDefaultSyncOptions({
        force: syncForce,
      }),
    );
  }

  // 1. Read log files from SQLite
  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  // SQLite queries return DESC order; computeMonitoringSnapshot expects chronological (ASC)
  telemetry.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
  const queryRecords = queryQueryLog(db) as QueryLogRecord[];

  // 2. Determine baseline pass rate from last deployed audit entry
  const lastDeployed = getLastDeployedProposal(skillName, _auditLogPath);
  const baselinePassRate = lastDeployed?.eval_snapshot?.pass_rate ?? DEFAULT_BASELINE_PASS_RATE;

  // 3. Compute the monitoring snapshot (includes regression detection)
  const snapshot = computeMonitoringSnapshot(
    skillName,
    telemetry,
    skillRecords,
    queryRecords,
    windowSessions,
    baselinePassRate,
    regressionThreshold,
  );

  // 4. Build trigger alert. Grade alerts are added below before rollback
  // decisions so either signal can drive automated rollback.
  let triggerAlert: string | null = null;
  let rolledBack = false;

  if (snapshot.regression_detected) {
    triggerAlert = `regression detected for "${skillName}": pass_rate=${snapshot.pass_rate.toFixed(2)} below baseline=${baselinePassRate.toFixed(2)} minus threshold=${regressionThreshold.toFixed(2)}`;
  }

  // 5. Grade regression detection (fail-open)
  let gradeAlert: string | null = null;
  let gradeRegression: { before: number; after: number; delta: number } | null = null;

  if (enableGradeWatch) {
    try {
      const baseline = queryGradingBaseline(db, skillName, lastDeployed?.proposal_id);
      const recentResults = queryRecentGradingResults(db, skillName, 10);

      if (baseline && recentResults.length > 0) {
        // Compute the average pass rate from recent grading results
        const validResults = recentResults.filter((r) => r.pass_rate != null);
        if (validResults.length > 0) {
          const recentAvgPassRate =
            validResults.reduce((sum, r) => sum + (r.pass_rate ?? 0), 0) / validResults.length;
          const baselinePassRateGrade = baseline.pass_rate;
          const delta = baselinePassRateGrade - recentAvgPassRate;

          if (delta > gradeRegressionThreshold) {
            gradeAlert = `grade regression detected for "${skillName}": baseline_grade_pass_rate=${baselinePassRateGrade.toFixed(2)}, recent_avg=${recentAvgPassRate.toFixed(2)}, delta=${delta.toFixed(2)} exceeds threshold=${gradeRegressionThreshold.toFixed(2)}`;
            gradeRegression = {
              before: baselinePassRateGrade,
              after: recentAvgPassRate,
              delta,
            };
          }
        }
      }
    } catch (err) {
      // Fail-open: grade watch should never block trigger monitoring
      console.error(
        JSON.stringify({
          level: "debug",
          code: "grade_watch_failed",
          message: `Grade watch failed for "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
  }

  const alerts = [triggerAlert, gradeAlert].filter((value): value is string => Boolean(value));
  const alert = alerts.length > 0 ? alerts.join("\n") : null;

  if (alert && autoRollback) {
    const rollbackFn = _rollbackFn ?? (await loadRollbackFn());
    const proposalId = lastDeployed?.proposal_id;
    const rollbackResult = await rollbackFn({
      skillName,
      skillPath,
      proposalId,
    });
    rolledBack = rollbackResult.rolledBack;
  }

  let recommendation: string;
  if (alert) {
    recommendation = rolledBack
      ? `Rolled back "${skillName}" to previous version. Monitor to confirm recovery.`
      : `Consider running: selftune rollback --skill "${skillName}" --skill-path "${skillPath}"`;
  } else if (snapshot.skill_checks < MIN_MONITORING_SKILL_CHECKS) {
    recommendation =
      `Skill "${skillName}" has only ${snapshot.skill_checks} actionable check(s) in the current window. ` +
      `Need at least ${MIN_MONITORING_SKILL_CHECKS} before calling it stable.`;
  } else {
    recommendation = `Skill "${skillName}" is stable. Pass rate ${snapshot.pass_rate.toFixed(2)} is within acceptable range of baseline ${baselinePassRate.toFixed(2)}.`;
  }

  // Update evolution memory (fail-open)
  try {
    updateContextAfterWatch(skillName, snapshot);
  } catch (err) {
    // Fail-open: memory writes should never fail the main operation
    console.error(
      JSON.stringify({
        level: "debug",
        code: "memory_write_failed",
        message: `Failed to update memory after watch for "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
  }

  return {
    snapshot,
    alert,
    rolledBack,
    recommendation,
    gradeAlert,
    gradeRegression,
    ...(syncResult ? { sync_result: syncResult } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lazy rollback loader (avoids import if rollback.ts doesn't exist yet)
// ---------------------------------------------------------------------------

async function loadRollbackFn(): Promise<
  (opts: {
    skillName: string;
    skillPath: string;
    proposalId?: string;
  }) => Promise<{ rolledBack: boolean; restoredDescription: string; reason: string }>
> {
  try {
    const mod = await import("../evolution/rollback.js");
    return mod.rollback;
  } catch (error: unknown) {
    // Only suppress module-resolution failures; rethrow syntax/runtime errors
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return async () => ({
        rolledBack: false,
        restoredDescription: "",
        reason: "Rollback module not available",
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      window: { type: "string", default: "20" },
      threshold: { type: "string", default: "0.1" },
      "auto-rollback": { type: "boolean", default: false },
      "grade-threshold": { type: "string", default: "0.15" },
      "no-grade-watch": { type: "boolean", default: false },
      "sync-first": { type: "boolean", default: false },
      "sync-force": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.watch));
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    throw new CLIError(
      "--skill and --skill-path are required.",
      "MISSING_FLAG",
      "Usage: selftune watch --skill <name> --skill-path <path>",
    );
  }
  if ((values["sync-force"] ?? false) && !(values["sync-first"] ?? false)) {
    throw new CLIError(
      "--sync-force requires --sync-first.",
      "INVALID_FLAG",
      "Add --sync-first when using --sync-force.",
    );
  }

  const rawWindow = values.window ?? "20";
  if (!/^\d+$/.test(rawWindow)) {
    throw new CLIError(
      "--window must be a positive integer >= 1.",
      "INVALID_FLAG",
      "selftune watch --window 20",
    );
  }
  const windowSessions = Number.parseInt(rawWindow, 10);
  if (windowSessions < 1) {
    throw new CLIError(
      "--window must be a positive integer >= 1.",
      "INVALID_FLAG",
      "selftune watch --window 20",
    );
  }

  const rawThreshold = values.threshold ?? "0.1";
  if (!/^\d+(\.\d+)?$/.test(rawThreshold)) {
    throw new CLIError(
      "--threshold must be a finite number between 0 and 1.",
      "INVALID_FLAG",
      "selftune watch --threshold 0.1",
    );
  }
  const regressionThreshold = Number.parseFloat(rawThreshold);
  if (regressionThreshold < 0 || regressionThreshold > 1) {
    throw new CLIError(
      "--threshold must be a finite number between 0 and 1.",
      "INVALID_FLAG",
      "selftune watch --threshold 0.1",
    );
  }

  const rawGradeThreshold = values["grade-threshold"] ?? "0.15";
  if (!/^\d+(\.\d+)?$/.test(rawGradeThreshold)) {
    throw new CLIError(
      "--grade-threshold must be a finite number between 0 and 1.",
      "INVALID_FLAG",
      "selftune watch --grade-threshold 0.15",
    );
  }
  const gradeRegressionThreshold = Number.parseFloat(rawGradeThreshold);
  if (gradeRegressionThreshold < 0 || gradeRegressionThreshold > 1) {
    throw new CLIError(
      "--grade-threshold must be a finite number between 0 and 1.",
      "INVALID_FLAG",
      "selftune watch --grade-threshold 0.15",
    );
  }

  const result = await watch({
    skillName: values.skill,
    skillPath: values["skill-path"],
    windowSessions,
    regressionThreshold,
    gradeRegressionThreshold,
    enableGradeWatch: !(values["no-grade-watch"] ?? false),
    autoRollback: values["auto-rollback"] ?? false,
    syncFirst: values["sync-first"] ?? false,
    syncForce: values["sync-force"] ?? false,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.alert ? 1 : 0);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
