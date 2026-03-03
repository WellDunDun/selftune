/**
 * Bundle assembly for contribution export.
 *
 * Pure function: reads logs, filters, aggregates, and returns a ContributionBundle.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EVOLUTION_AUDIT_LOG,
  QUERY_LOG,
  SELFTUNE_CONFIG_DIR,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "../constants.js";
import { buildEvalSet, classifyInvocation } from "../eval/hooks-to-evals.js";
import type {
  ContributionBundle,
  ContributionEvolutionSummary,
  ContributionGradingSummary,
  ContributionQuery,
  ContributionSessionMetrics,
  EvolutionAuditEntry,
  GradingResult,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { readJsonl } from "../utils/jsonl.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterSince<T extends { timestamp: string }>(records: T[], since?: Date): T[] {
  if (!since) return records;
  return records.filter((r) => new Date(r.timestamp) >= since);
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function getAgentType(): string {
  try {
    const configPath = join(SELFTUNE_CONFIG_DIR, "config.json");
    if (!existsSync(configPath)) return "unknown";
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.agent_type ?? "unknown";
  } catch {
    return "unknown";
  }
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ---------------------------------------------------------------------------
// Grading summary
// ---------------------------------------------------------------------------

function buildGradingSummary(skillName: string): ContributionGradingSummary | null {
  const gradingDir = join(homedir(), ".selftune", "grading");
  if (!existsSync(gradingDir)) return null;

  try {
    const files = readdirSync(gradingDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;

    let totalSessions = 0;
    let gradedSessions = 0;
    let passRateSum = 0;
    let expectationCount = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(gradingDir, file), "utf-8")) as GradingResult;
        if (data.skill_name !== skillName) continue;
        totalSessions++;
        if (data.summary) {
          gradedSessions++;
          passRateSum += data.summary.pass_rate ?? 0;
          expectationCount += data.summary.total ?? 0;
        }
      } catch {
        // skip malformed grading files
      }
    }

    if (gradedSessions === 0) return null;

    return {
      total_sessions: totalSessions,
      graded_sessions: gradedSessions,
      average_pass_rate: passRateSum / gradedSessions,
      expectation_count: expectationCount,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Evolution summary
// ---------------------------------------------------------------------------

function buildEvolutionSummary(
  records: EvolutionAuditEntry[],
): ContributionEvolutionSummary | null {
  if (records.length === 0) return null;

  const proposals = new Set<string>();
  let deployed = 0;
  let rolledBack = 0;
  const improvements: number[] = [];

  for (const r of records) {
    proposals.add(r.proposal_id);
    if (r.action === "deployed") {
      deployed++;
      if (r.eval_snapshot?.pass_rate != null) {
        improvements.push(r.eval_snapshot.pass_rate);
      }
    }
    if (r.action === "rolled_back") {
      rolledBack++;
    }
  }

  return {
    total_proposals: proposals.size,
    deployed_proposals: deployed,
    rolled_back_proposals: rolledBack,
    average_improvement: improvements.length > 0 ? avg(improvements) : 0,
  };
}

// ---------------------------------------------------------------------------
// Session metrics
// ---------------------------------------------------------------------------

function buildSessionMetrics(records: SessionTelemetryRecord[]): ContributionSessionMetrics {
  if (records.length === 0) {
    return {
      total_sessions: 0,
      avg_assistant_turns: 0,
      avg_tool_calls: 0,
      avg_errors: 0,
      top_tools: [],
    };
  }

  const toolCounts = new Map<string, number>();
  for (const r of records) {
    for (const [tool, count] of Object.entries(r.tool_calls ?? {})) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + count);
    }
  }

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, count]) => ({ tool, count }));

  return {
    total_sessions: records.length,
    avg_assistant_turns: Math.round(avg(records.map((r) => r.assistant_turns ?? 0))),
    avg_tool_calls: Math.round(avg(records.map((r) => r.total_tool_calls ?? 0))),
    avg_errors: Number(avg(records.map((r) => r.errors_encountered ?? 0)).toFixed(2)),
    top_tools: topTools,
  };
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

export function assembleBundle(options: {
  skillName: string;
  since?: Date;
  sanitizationLevel: "conservative" | "aggressive";
  queryLogPath?: string;
  skillLogPath?: string;
  telemetryLogPath?: string;
  evolutionAuditLogPath?: string;
}): ContributionBundle {
  const {
    skillName,
    since,
    sanitizationLevel,
    queryLogPath = QUERY_LOG,
    skillLogPath = SKILL_LOG,
    telemetryLogPath = TELEMETRY_LOG,
    evolutionAuditLogPath = EVOLUTION_AUDIT_LOG,
  } = options;

  // Read all logs
  const allSkillRecords = readJsonl<SkillUsageRecord>(skillLogPath);
  const allQueryRecords = readJsonl<QueryLogRecord>(queryLogPath);
  const allTelemetryRecords = readJsonl<SessionTelemetryRecord>(telemetryLogPath);
  const allEvolutionRecords = readJsonl<EvolutionAuditEntry>(evolutionAuditLogPath);

  // Filter by skill and since
  const skillRecords = filterSince(
    allSkillRecords.filter((r) => r.skill_name === skillName),
    since,
  );
  const queryRecords = filterSince(allQueryRecords, since);
  const telemetryRecords = filterSince(
    allTelemetryRecords.filter((r) => (r.skills_triggered ?? []).includes(skillName)),
    since,
  );
  // TODO: Filter evolution records by skillName once EvolutionAuditEntry gains a skill_name field.
  // Currently includes all skills' proposals. Schema change requires human review (escalation-policy.md).
  const evolutionRecords = filterSince(allEvolutionRecords, since);

  // Build positive queries
  const seenQueries = new Set<string>();
  const positiveQueries: ContributionQuery[] = [];
  for (const r of skillRecords) {
    const q = (r.query ?? "").trim();
    if (!q || seenQueries.has(q)) continue;
    seenQueries.add(q);
    positiveQueries.push({
      query: q,
      invocation_type: classifyInvocation(q, skillName),
      source: r.source ?? "skill_log",
    });
  }

  // Build eval entries
  const evalEntries = buildEvalSet(skillRecords, queryRecords, skillName, 50, true, 42, true).map(
    (e) => ({
      query: e.query,
      should_trigger: e.should_trigger,
      invocation_type: e.invocation_type,
    }),
  );

  // Build grading summary
  const gradingSummary = buildGradingSummary(skillName);

  // Build evolution summary
  const evolutionSummary = buildEvolutionSummary(evolutionRecords);

  // Build session metrics
  const sessionMetrics = buildSessionMetrics(telemetryRecords);

  return {
    schema_version: "1.1",
    skill_name: skillName,
    contributor_id: randomUUID(),
    created_at: new Date().toISOString(),
    selftune_version: getVersion(),
    agent_type: getAgentType(),
    sanitization_level: sanitizationLevel,
    positive_queries: positiveQueries,
    eval_entries: evalEntries,
    grading_summary: gradingSummary,
    evolution_summary: evolutionSummary,
    session_metrics: sessionMetrics,
  };
}
