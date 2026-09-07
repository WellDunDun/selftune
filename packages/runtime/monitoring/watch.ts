/**
 * Post-deploy monitoring: compute snapshots and detect regressions (TASK-16).
 *
 * Exports:
 *  - computeMonitoringSnapshot  (pure function, deterministic)
 *  - watch                      (reads log files, computes snapshot, optionally rolls back)
 */

import { getDb } from "../localdb/db.js";
import { updateContextAfterWatch } from "../memory/writer.js";
import type { SourceSyncRunner, SyncResult } from "@selftune/source-management/sync";
import { CLIError } from "../utils/cli-error.js";
import {
  buildWatchResult,
  computeMonitoringSnapshot,
  evaluateWatch,
  makeWatchEvaluationDependencies,
  MIN_MONITORING_SKILL_CHECKS,
} from "./watch/evaluation.js";
import type { WatchResult } from "./watch/evaluation.js";

export {
  buildWatchResult,
  computeMonitoringSnapshot,
  evaluateWatch,
  makeWatchEvaluationDependencies,
  MIN_MONITORING_SKILL_CHECKS,
};
export type {
  WatchDiagnostic,
  WatchEvaluationDependencies,
  WatchEvaluationOptions,
  WatchEvaluationResult,
  WatchResult,
} from "./watch/evaluation.js";

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
  /** Relative regression threshold for observed efficiency (default 0.25). */
  efficiencyRegressionThreshold?: number;
  /** Enable efficiency-based regression watch (default true). */
  enableEfficiencyWatch?: boolean;
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
  _syncFn?: SourceSyncRunner;
  /** Explicit memory directory for tests and embedded hosts. */
  _memoryDir?: string;
}

// ---------------------------------------------------------------------------
// Watch trust scoring — aggregates watch signals into a 0-1 trust score
// ---------------------------------------------------------------------------

/**
 * Compute a trust score (0-1) from a WatchResult.
 *
 * A skill with no regressions and sufficient checks scores 1.0.
 * Active alerts reduce trust proportional to severity:
 *  - Trigger regression: -0.5
 *  - Grade regression: -0.3 (scaled by delta magnitude)
 *  - Insufficient data: caps at 0.5
 */
export function computeWatchTrustScore(watchResult: WatchResult): number {
  const { snapshot, alert, gradeRegression } = watchResult;

  // Not enough data to form a trust opinion — cap at 0.5
  if (snapshot.skill_checks < MIN_MONITORING_SKILL_CHECKS) {
    return 0.5;
  }

  let score = 1.0;

  // Trigger pass rate regression: major trust penalty
  if (snapshot.regression_detected) {
    score -= 0.5;
  }

  // Grade regression: penalty scaled by delta (max 0.3)
  if (gradeRegression) {
    const gradePenalty = Math.min(gradeRegression.delta * 2, 0.3);
    score -= gradePenalty;
  }

  // Any active alert without specific regression (catch-all)
  if (alert && !snapshot.regression_detected && !gradeRegression) {
    score -= 0.2;
  }

  // Rolled back: significant trust hit
  if (watchResult.rolledBack) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

function writeWatchDiagnostic(diagnostic: {
  readonly code: string;
  readonly message: string;
}): void {
  process.stderr.write(`${JSON.stringify({ level: "debug", ...diagnostic })}\n`);
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
    regressionThreshold = 0.1,
    gradeRegressionThreshold = 0.15,
    enableGradeWatch = true,
    efficiencyRegressionThreshold = 0.25,
    enableEfficiencyWatch = true,
    autoRollback = false,
    _auditLogPath,
    _rollbackFn,
    _memoryDir,
    syncFirst = false,
    syncForce = false,
    _syncFn,
  } = options;

  let syncResult: SyncResult | undefined;
  if (syncFirst) {
    if (!_syncFn) {
      throw new CLIError(
        "Source sync is not configured for this runtime.",
        "OPERATION_FAILED",
        "Run this command through the SelfTune CLI composition root.",
      );
    }
    syncResult = await _syncFn({ force: syncForce });
  }

  const db = getDb();
  const evaluation = evaluateWatch(
    {
      skillName,
      skillPath,
      windowSessions,
      regressionThreshold,
      gradeRegressionThreshold,
      enableGradeWatch,
      efficiencyRegressionThreshold,
      enableEfficiencyWatch,
      auditLogPath: _auditLogPath,
    },
    makeWatchEvaluationDependencies(db, (diagnostic) => {
      writeWatchDiagnostic(diagnostic);
    }),
  );

  let rolledBack = false;
  if (evaluation.alert && autoRollback) {
    const rollbackFn = _rollbackFn ?? (await loadRollbackFn());
    const rollbackResult = await rollbackFn({
      skillName,
      skillPath,
      proposalId: evaluation.proposalId,
    });
    rolledBack = rollbackResult.rolledBack;
  }

  // Update evolution memory (fail-open)
  try {
    updateContextAfterWatch(skillName, evaluation.snapshot, _memoryDir);
  } catch (cause) {
    // Fail-open: memory writes should never fail the main operation
    writeWatchDiagnostic({
      code: "memory_write_failed",
      message: `Failed to update memory after watch for "${skillName}": ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  return buildWatchResult(evaluation, rolledBack, syncResult);
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
  } catch (cause: unknown) {
    // Only suppress module-resolution failures; rethrow syntax/runtime errors
    // SAFETY-TYPEOF: Dynamic import failures are an external runtime boundary; inspect only the optional Node error code needed to classify module resolution.
    const code =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return async () => ({
        rolledBack: false,
        restoredDescription: "",
        reason: "Rollback module not available",
      });
    }
    throw cause;
  }
}
