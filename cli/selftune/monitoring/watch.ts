/**
 * Post-deploy monitoring: compute snapshots and detect regressions (TASK-16).
 *
 * Exports:
 *  - computeMonitoringSnapshot  (pure function, deterministic)
 *  - watch                      (reads log files, computes snapshot, optionally rolls back)
 */

import { parseArgs } from "node:util";

import { QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import { getLastDeployedProposal } from "../evolution/audit.js";
import { updateContextAfterWatch } from "../memory/writer.js";
import type {
  InvocationType,
  MonitoringSnapshot,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { readJsonl } from "../utils/jsonl.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface WatchOptions {
  skillName: string;
  skillPath: string;
  windowSessions: number;
  regressionThreshold: number;
  autoRollback: boolean;
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
}

export interface WatchResult {
  snapshot: MonitoringSnapshot;
  alert: string | null;
  rolledBack: boolean;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASELINE_PASS_RATE = 0.5;
const DEFAULT_REGRESSION_THRESHOLD = 0.1;

// ---------------------------------------------------------------------------
// computeMonitoringSnapshot - pure function
// ---------------------------------------------------------------------------

/**
 * Compute a monitoring snapshot from raw log records.
 *
 * The function windows telemetry to the last `windowSessions` entries, then
 * scopes skill and query records to those sessions. If telemetry is empty or
 * no records match the windowed session IDs, all provided skill/query records
 * are used directly (unfiltered by session).
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
  const windowedTelemetry = telemetry.slice(-windowSessions);
  const windowedSessionIds = new Set(windowedTelemetry.map((t) => t.session_id));

  // 2. Filter skill records by skill name first
  const skillNameFiltered = skillRecords.filter((r) => r.skill_name === skillName);

  // 3. Apply session ID windowing only if telemetry is present and overlaps
  const hasSessionOverlap =
    windowedSessionIds.size > 0 &&
    (skillNameFiltered.some((r) => windowedSessionIds.has(r.session_id)) ||
      queryRecords.some((r) => windowedSessionIds.has(r.session_id)));

  const filteredSkillRecords = hasSessionOverlap
    ? skillNameFiltered.filter((r) => windowedSessionIds.has(r.session_id))
    : skillNameFiltered;

  const filteredQueryRecords = hasSessionOverlap
    ? queryRecords.filter((r) => windowedSessionIds.has(r.session_id))
    : queryRecords;

  // 4. Compute pass rate: triggered_count / total_query_count
  const triggeredCount = filteredSkillRecords.filter((r) => r.triggered).length;
  const totalQueries = filteredQueryRecords.length;
  const passRate = totalQueries === 0 ? 1.0 : triggeredCount / totalQueries;

  // 5. Compute false negative rate from skill usage records
  const totalSkillChecks = filteredSkillRecords.length;
  const falseNegatives = filteredSkillRecords.filter((r) => !r.triggered).length;
  const falseNegativeRate = totalSkillChecks === 0 ? 0 : falseNegatives / totalSkillChecks;

  // 6. by_invocation_type: MVP classifies everything as "implicit"
  const byInvocationType: Record<InvocationType, { passed: number; total: number }> = {
    explicit: { passed: 0, total: 0 },
    implicit: { passed: triggeredCount, total: totalSkillChecks },
    contextual: { passed: 0, total: 0 },
    negative: { passed: 0, total: 0 },
  };

  // 7. Regression detection: pass_rate < baseline - threshold
  // Use rounding to avoid floating-point boundary issues (e.g. 0.8 - 0.1 = 0.7000000000000001)
  const precision = 1e10;
  const adjustedThreshold =
    Math.round((baselinePassRate - regressionThreshold) * precision) / precision;
  const roundedPassRate = Math.round(passRate * precision) / precision;
  const regressionDetected = roundedPassRate < adjustedThreshold;

  return {
    timestamp: new Date().toISOString(),
    skill_name: skillName,
    window_sessions: windowSessions,
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
    autoRollback = false,
    _telemetryLogPath = TELEMETRY_LOG,
    _skillLogPath = SKILL_LOG,
    _queryLogPath = QUERY_LOG,
    _auditLogPath,
    _rollbackFn,
  } = options;

  // 1. Read log files
  const telemetry = readJsonl<SessionTelemetryRecord>(_telemetryLogPath);
  const skillRecords = readJsonl<SkillUsageRecord>(_skillLogPath);
  const queryRecords = readJsonl<QueryLogRecord>(_queryLogPath);

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

  // 4. Build alert and recommendation
  let alert: string | null = null;
  let rolledBack = false;
  let recommendation: string;

  if (snapshot.regression_detected) {
    alert = `regression detected for "${skillName}": pass_rate=${snapshot.pass_rate.toFixed(2)} below baseline=${baselinePassRate.toFixed(2)} minus threshold=${regressionThreshold.toFixed(2)}`;

    // 5. Auto-rollback if enabled
    if (autoRollback) {
      const rollbackFn = _rollbackFn ?? (await loadRollbackFn());
      const proposalId = lastDeployed?.proposal_id;
      const rollbackResult = await rollbackFn({
        skillName,
        skillPath,
        proposalId,
      });
      rolledBack = rollbackResult.rolledBack;
    }

    recommendation = rolledBack
      ? `Rolled back "${skillName}" to previous version. Monitor to confirm recovery.`
      : `Consider running: selftune rollback --skill "${skillName}" --skill-path "${skillPath}"`;
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
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune watch — Monitor post-deploy skill health

Usage:
  selftune watch --skill <name> --skill-path <path> [options]

Options:
  --skill             Skill name (required)
  --skill-path        Path to SKILL.md (required)
  --window            Number of recent sessions to consider (default: 20)
  --threshold         Regression threshold below baseline (default: 0.1)
  --auto-rollback     Automatically rollback on regression detection
  --help              Show this help message`);
    process.exit(0);
  }

  if (!values.skill || !values["skill-path"]) {
    console.error("[ERROR] --skill and --skill-path are required");
    process.exit(1);
  }

  const rawWindow = values.window ?? "20";
  if (!/^\d+$/.test(rawWindow)) {
    console.error("[ERROR] --window must be a positive integer >= 1");
    process.exit(1);
  }
  const windowSessions = Number.parseInt(rawWindow, 10);
  if (windowSessions < 1) {
    console.error("[ERROR] --window must be a positive integer >= 1");
    process.exit(1);
  }

  const rawThreshold = values.threshold ?? "0.1";
  if (!/^\d+(\.\d+)?$/.test(rawThreshold)) {
    console.error("[ERROR] --threshold must be a finite number between 0 and 1");
    process.exit(1);
  }
  const regressionThreshold = Number.parseFloat(rawThreshold);
  if (regressionThreshold < 0 || regressionThreshold > 1) {
    console.error("[ERROR] --threshold must be a finite number between 0 and 1");
    process.exit(1);
  }

  const result = await watch({
    skillName: values.skill,
    skillPath: values["skill-path"],
    windowSessions,
    regressionThreshold,
    autoRollback: values["auto-rollback"] ?? false,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.alert ? 1 : 0);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(`[FATAL] ${err}`);
    process.exit(1);
  });
}
