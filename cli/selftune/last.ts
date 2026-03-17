#!/usr/bin/env bun
/**
 * Quick insight from the most recent session.
 * Lightweight, no LLM calls.
 */

import { getDb } from "./localdb/db.js";
import { queryQueryLog, querySessionTelemetry, querySkillUsageRecords } from "./localdb/queries.js";
import type { QueryLogRecord, SessionTelemetryRecord, SkillUsageRecord } from "./types.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "./utils/query-filter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LastSessionInsight {
  sessionId: string;
  timestamp: string;
  skillsTriggered: string[];
  unmatchedQueries: string[];
  errors: number;
  toolCalls: number;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Compute insight from the most recent session.
 * Returns null when no telemetry data exists.
 */
export function computeLastInsight(
  telemetry: SessionTelemetryRecord[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
): LastSessionInsight | null {
  if (telemetry.length === 0) return null;
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);

  // Find most recent telemetry record
  const sorted = [...telemetry].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const latest = sorted[0];
  const sessionId = latest.session_id;

  // Skills triggered: unique skill names where triggered=true AND session matches
  const triggeredSkillQueries = new Set<string>();
  const skillsTriggered = [
    ...new Set(
      actionableSkillRecords
        .filter((r) => r.session_id === sessionId && r.triggered)
        .map((r) => {
          if (typeof r.query === "string") {
            triggeredSkillQueries.add(r.query.toLowerCase().trim());
          }
          return r.skill_name;
        }),
    ),
  ];

  // Unmatched queries: session queries whose text does NOT appear in any triggered skill record
  const sessionQueries = actionableQueryRecords.filter((r) => r.session_id === sessionId);
  const unmatchedQueries = sessionQueries
    .filter((q) => !triggeredSkillQueries.has(q.query.toLowerCase().trim()))
    .map((q) => q.query);

  const errors = latest.errors_encountered;
  const toolCalls = latest.total_tool_calls;

  // Contextual recommendation
  let recommendation: string;
  const unmatched = unmatchedQueries.length;
  if (unmatched > 0) {
    recommendation = `${unmatched} queries had no skill match. Run 'selftune evals --list-skills' to investigate.`;
  } else if (errors > 0) {
    recommendation = `${errors} errors encountered. Check logs for details.`;
  } else {
    recommendation = "All queries matched skills. System is operating well.";
  }

  return {
    sessionId,
    timestamp: latest.timestamp,
    skillsTriggered,
    unmatchedQueries,
    errors,
    toolCalls,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format an insight as a human-readable plain-text summary. */
export function formatInsight(insight: LastSessionInsight): string {
  const date = new Date(insight.timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const dateStr = `${month} ${day}, ${hours}:${minutes}`;

  const lines: string[] = [];
  lines.push(`Last session: ${insight.sessionId} (${dateStr})`);
  lines.push("");
  lines.push(`  Skills triggered:  ${insight.skillsTriggered.join(", ") || "none"}`);
  lines.push(`  Unmatched queries: ${insight.unmatchedQueries.length}`);
  for (const q of insight.unmatchedQueries) {
    lines.push(`    \u00B7 "${q}"`);
  }
  lines.push(`  Errors: ${insight.errors}`);
  lines.push(`  Tool calls: ${insight.toolCalls}`);
  lines.push("");
  lines.push(`  \u2192 ${insight.recommendation}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** CLI main: reads logs, prints insight. */
export function cliMain(): void {
  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
  const queryRecords = queryQueryLog(db) as QueryLogRecord[];

  const insight = computeLastInsight(telemetry, skillRecords, queryRecords);
  if (!insight) {
    console.log("No session data found.");
    process.exit(0);
  }

  console.log(formatInsight(insight));
  process.exit(0);
}
