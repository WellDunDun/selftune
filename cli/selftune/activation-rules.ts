/**
 * Default activation rules for the auto-activate hook.
 *
 * Each rule evaluates session context and returns a suggestion string
 * (or null if the rule doesn't fire). Rules must be pure functions
 * that read from the filesystem — no network calls, no imports from
 * evolution/monitoring/grading layers.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVOLUTION_AUDIT_LOG, QUERY_LOG } from "./constants.js";
import { getDb } from "./localdb/db.js";
import { queryEvolutionAudit, queryQueryLog, querySkillUsageRecords } from "./localdb/queries.js";
import type { ActivationContext, ActivationRule } from "./types.js";
import { readJsonl } from "./utils/jsonl.js";

// ---------------------------------------------------------------------------
// Rule: post-session diagnostic
// ---------------------------------------------------------------------------

const postSessionDiagnostic: ActivationRule = {
  id: "post-session-diagnostic",
  description: "Suggest `selftune last` when session has >2 unmatched queries",
  evaluate(ctx: ActivationContext): string | null {
    // Count queries for this session
    let queries: Array<{ session_id: string; query: string }>;
    if (ctx.query_log_path === QUERY_LOG) {
      const db = getDb();
      queries = queryQueryLog(db) as Array<{ session_id: string; query: string }>;
    } else {
      queries = readJsonl<{ session_id: string; query: string }>(ctx.query_log_path);
    }
    const sessionQueries = queries.filter((q) => q.session_id === ctx.session_id);

    if (sessionQueries.length === 0) return null;

    // Count skill usages for this session (skill log is in the same dir as query log)
    const skillLogPath = join(dirname(ctx.query_log_path), "skill_usage_log.jsonl");
    let skillUsages: Array<{ session_id: string }>;
    if (ctx.query_log_path === QUERY_LOG) {
      const db = getDb();
      skillUsages = (querySkillUsageRecords(db) as Array<{ session_id: string }>).filter(
        (s) => s.session_id === ctx.session_id,
      );
    } else {
      skillUsages = existsSync(skillLogPath)
        ? readJsonl<{ session_id: string }>(skillLogPath).filter(
            (s) => s.session_id === ctx.session_id,
          )
        : [];
    }

    const unmatchedCount = sessionQueries.length - skillUsages.length;

    if (unmatchedCount > 2) {
      return `Run \`selftune last\` — ${unmatchedCount} unmatched queries detected in this session.`;
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Rule: grading threshold breach
// ---------------------------------------------------------------------------

const gradingThresholdBreach: ActivationRule = {
  id: "grading-threshold-breach",
  description: "Suggest `selftune evolve` when session pass rate < 0.6",
  evaluate(ctx: ActivationContext): string | null {
    // Look for grading results in the selftune dir
    const gradingDir = join(ctx.selftune_dir, "grading");
    if (!existsSync(gradingDir)) return null;

    try {
      const files = readdirSync(gradingDir).filter(
        (f) => f.startsWith("result-") && f.endsWith(".json"),
      );

      for (const file of files) {
        const content = readFileSync(join(gradingDir, file), "utf-8");
        const result = JSON.parse(content) as {
          session_id: string;
          summary?: { pass_rate: number };
        };

        if (result.session_id === ctx.session_id && result.summary) {
          if (result.summary.pass_rate < 0.6) {
            return `Run \`selftune evolve\` — session pass rate is ${(result.summary.pass_rate * 100).toFixed(0)}% (below 60% threshold).`;
          }
        }
      }
    } catch {
      // fail-open
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Rule: stale evolution
// ---------------------------------------------------------------------------

const staleEvolution: ActivationRule = {
  id: "stale-evolution",
  description:
    "Suggest `selftune evolve` when no evolution in >7 days and pending false negatives exist",
  evaluate(ctx: ActivationContext): string | null {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // Check last evolution timestamp
    let auditEntries: Array<{ timestamp: string; action: string }>;
    if (ctx.evolution_audit_log_path === EVOLUTION_AUDIT_LOG) {
      const db = getDb();
      auditEntries = queryEvolutionAudit(db) as Array<{ timestamp: string; action: string }>;
    } else {
      auditEntries = readJsonl<{ timestamp: string; action: string }>(ctx.evolution_audit_log_path);
    }

    if (auditEntries.length === 0) {
      // No evolution has ever run — check for false negatives
      return checkFalseNegatives(ctx)
        ? "Run `selftune evolve` — no evolution history found and pending false negatives exist."
        : null;
    }

    const lastEntry = auditEntries[auditEntries.length - 1];
    const lastTimestamp = new Date(lastEntry.timestamp).getTime();
    const ageMs = Date.now() - lastTimestamp;

    if (ageMs > SEVEN_DAYS_MS && checkFalseNegatives(ctx)) {
      return `Run \`selftune evolve\` — no evolution in >7 days and pending false negatives detected.`;
    }

    return null;
  },
};

function checkFalseNegatives(ctx: ActivationContext): boolean {
  const fnPath = join(ctx.selftune_dir, "false-negatives", "pending.json");
  if (!existsSync(fnPath)) return false;

  try {
    const data = JSON.parse(readFileSync(fnPath, "utf-8"));
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rule: regression detected
// ---------------------------------------------------------------------------

const regressionDetected: ActivationRule = {
  id: "regression-detected",
  description: "Suggest `selftune rollback` when watch snapshot shows regression",
  evaluate(ctx: ActivationContext): string | null {
    const snapshotPath = join(ctx.selftune_dir, "monitoring", "latest-snapshot.json");
    if (!existsSync(snapshotPath)) return null;

    try {
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
        regression_detected: boolean;
        skill_name?: string;
        pass_rate?: number;
      };

      if (snapshot.regression_detected) {
        const skillInfo = snapshot.skill_name ? ` for skill "${snapshot.skill_name}"` : "";
        return `Run \`selftune rollback\` — regression detected${skillInfo}.`;
      }
    } catch {
      // fail-open
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Exported defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: ActivationRule[] = [
  postSessionDiagnostic,
  gradingThresholdBreach,
  staleEvolution,
  regressionDetected,
];
