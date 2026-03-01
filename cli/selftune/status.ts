/**
 * selftune status — Skill health summary CLI command.
 *
 * Exports:
 *  - computeStatus()  (pure function, deterministic)
 *  - formatStatus()   (colored terminal output)
 *  - cliMain()        (reads logs, runs doctor, prints output)
 */

import { EVOLUTION_AUDIT_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "./constants.js";
import { getLastDeployedProposal } from "./evolution/audit.js";
import { computeMonitoringSnapshot } from "./monitoring/watch.js";
import { doctor } from "./observability.js";
import type {
  DoctorResult,
  EvolutionAuditEntry,
  MonitoringSnapshot,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { readJsonl } from "./utils/jsonl.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SkillStatus {
  name: string;
  passRate: number | null;
  trend: "up" | "down" | "stable" | "unknown";
  missedQueries: number;
  status: "HEALTHY" | "REGRESSED" | "NO DATA";
  snapshot: MonitoringSnapshot | null;
}

export interface StatusResult {
  skills: SkillStatus[];
  unmatchedQueries: number;
  pendingProposals: number;
  lastSession: string | null;
  system: {
    healthy: boolean;
    pass: number;
    fail: number;
    warn: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_SESSIONS = 20;
const DEFAULT_BASELINE_PASS_RATE = 0.5;

// ---------------------------------------------------------------------------
// computeStatus — pure function
// ---------------------------------------------------------------------------

export function computeStatus(
  telemetry: SessionTelemetryRecord[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  auditEntries: EvolutionAuditEntry[],
  doctorResult: DoctorResult,
): StatusResult {
  // Derive unique skill names from skill records
  const skillNames = [...new Set(skillRecords.map((r) => r.skill_name))];

  // Build per-skill status
  const skills: SkillStatus[] = skillNames.map((skillName) => {
    const skillSpecificRecords = skillRecords.filter((r) => r.skill_name === skillName);
    const triggeredRecords = skillSpecificRecords.filter((r) => r.triggered);

    // Get baseline from last deployed proposal
    const lastDeployed = getLastDeployedProposalFromEntries(auditEntries, skillName);
    const baselinePassRate = lastDeployed?.eval_snapshot?.pass_rate ?? DEFAULT_BASELINE_PASS_RATE;

    // Compute monitoring snapshot
    const snapshot = computeMonitoringSnapshot(
      skillName,
      telemetry,
      skillRecords,
      queryRecords,
      DEFAULT_WINDOW_SESSIONS,
      baselinePassRate,
    );

    // Determine if there's any meaningful data
    const totalQueries = queryRecords.length;
    const hasData = triggeredRecords.length > 0 || totalQueries > 0;

    // Compute pass rate (null if no data)
    let passRate: number | null = null;
    if (hasData && totalQueries > 0) {
      passRate = snapshot.pass_rate;
    }

    // Determine trend: compare first-half vs second-half pass rates
    const trend = computeTrend(skillSpecificRecords);

    // Count missed queries for this skill (queries where skill was checked but not triggered)
    const missedQueries = skillSpecificRecords.filter((r) => !r.triggered).length;

    // Determine status
    let status: "HEALTHY" | "REGRESSED" | "NO DATA";
    if (!hasData || passRate === null) {
      status = "NO DATA";
    } else if (snapshot.regression_detected) {
      status = "REGRESSED";
    } else {
      status = "HEALTHY";
    }

    return { name: skillName, passRate, trend, missedQueries, status, snapshot };
  });

  // Sort: REGRESSED first, then HEALTHY, then NO DATA
  const statusOrder = { REGRESSED: 0, HEALTHY: 1, "NO DATA": 2 };
  skills.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  // Unmatched queries: queries whose text appears in zero triggered skill_usage_log entries
  const triggeredQueryTexts = new Set(skillRecords.filter((r) => r.triggered).map((r) => r.query));
  const unmatchedQueries = queryRecords.filter((q) => !triggeredQueryTexts.has(q.query)).length;

  // Pending proposals: audit entries with action=created/validated that have
  // no later deployed/rejected/rolled_back for same proposal_id
  const terminalActions = new Set(["deployed", "rejected", "rolled_back"]);
  const proposalIds = [...new Set(auditEntries.map((e) => e.proposal_id))];
  const pendingProposals = proposalIds.filter((pid) => {
    const entries = auditEntries.filter((e) => e.proposal_id === pid);
    const hasTerminal = entries.some((e) => terminalActions.has(e.action));
    const hasCreatedOrValidated = entries.some(
      (e) => e.action === "created" || e.action === "validated",
    );
    return hasCreatedOrValidated && !hasTerminal;
  }).length;

  // Last session timestamp
  let lastSession: string | null = null;
  if (telemetry.length > 0) {
    lastSession = telemetry.reduce(
      (latest, t) => (t.timestamp > latest ? t.timestamp : latest),
      telemetry[0].timestamp,
    );
  }

  // System health from doctor result
  const system = {
    healthy: doctorResult.healthy,
    pass: doctorResult.summary.pass,
    fail: doctorResult.summary.fail,
    warn: doctorResult.summary.warn,
  };

  return { skills, unmatchedQueries, pendingProposals, lastSession, system };
}

// ---------------------------------------------------------------------------
// Trend computation
// ---------------------------------------------------------------------------

function computeTrend(skillRecords: SkillUsageRecord[]): "up" | "down" | "stable" | "unknown" {
  if (skillRecords.length < 2) return "unknown";

  // Sort by timestamp
  const sorted = [...skillRecords].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const mid = Math.floor(sorted.length / 2);

  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);

  const firstRate =
    firstHalf.length > 0 ? firstHalf.filter((r) => r.triggered).length / firstHalf.length : 0;
  const secondRate =
    secondHalf.length > 0 ? secondHalf.filter((r) => r.triggered).length / secondHalf.length : 0;

  if (secondRate > firstRate) return "up";
  if (secondRate < firstRate) return "down";
  return "stable";
}

// ---------------------------------------------------------------------------
// Helper: get last deployed proposal from in-memory audit entries
// ---------------------------------------------------------------------------

function getLastDeployedProposalFromEntries(
  entries: EvolutionAuditEntry[],
  skillName: string,
): EvolutionAuditEntry | null {
  const needle = skillName.toLowerCase();
  const deployed = entries.filter(
    (e) => e.action === "deployed" && (e.details ?? "").toLowerCase().includes(needle),
  );
  return deployed.length > 0 ? deployed[deployed.length - 1] : null;
}

// ---------------------------------------------------------------------------
// formatStatus — colored terminal output
// ---------------------------------------------------------------------------

const TREND_SYMBOLS: Record<string, string> = {
  up: "\u2191",
  down: "\u2193",
  stable: "\u2192",
  unknown: "?",
};

export function formatStatus(result: StatusResult): string {
  const noColor = !!process.env.NO_COLOR;

  const green = noColor ? (s: string) => s : (s: string) => colorize(s, "#788c5d");
  const red = noColor ? (s: string) => s : (s: string) => colorize(s, "#c44");
  const amber = noColor ? (s: string) => s : (s: string) => colorize(s, "#c49133");

  const lines: string[] = [];
  lines.push("selftune status");
  lines.push("\u2550".repeat(15));
  lines.push("");

  // Skills table
  const skillCount = result.skills.length;
  lines.push(
    `Skills (${skillCount})${" ".repeat(36 - `Skills (${skillCount})`.length)}Last 7 days`,
  );
  lines.push("  Name            Pass Rate  Trend  Missed  Status");

  for (const skill of result.skills) {
    const name = skill.name.padEnd(16);
    const passRate =
      skill.passRate !== null
        ? `${Math.round(skill.passRate * 100)}%`.padEnd(11)
        : "\u2014".padEnd(11);
    const trend = TREND_SYMBOLS[skill.trend].padEnd(7);
    const missed = String(skill.missedQueries).padEnd(8);
    const statusText =
      skill.status === "REGRESSED"
        ? red(skill.status)
        : skill.status === "HEALTHY"
          ? green(skill.status)
          : amber(skill.status);
    lines.push(`  ${name}${passRate}${trend}${missed}${statusText}`);
  }

  lines.push("");

  // Summary stats
  lines.push(`Unmatched queries:  ${result.unmatchedQueries}`);
  lines.push(`Pending proposals:  ${result.pendingProposals}`);

  // Last session
  if (result.lastSession) {
    const d = new Date(result.lastSession);
    const formatted = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    lines.push(`Last session:       ${formatted}, ${time}`);
  } else {
    lines.push("Last session:       \u2014");
  }

  // System health
  const { pass, fail, warn, healthy } = result.system;
  const healthLabel = healthy ? green("HEALTHY") : red("UNHEALTHY");
  lines.push(`System:             ${healthLabel} (${pass} pass, ${fail} fail, ${warn} warn)`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Terminal color helper using ANSI escapes
// ---------------------------------------------------------------------------

function colorize(text: string, hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3).padEnd(2, "0"), 16);
  const g = Number.parseInt(hex.slice(3, 5).padEnd(2, "0"), 16);
  const b = Number.parseInt(hex.slice(5, 7).padEnd(2, "0"), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// cliMain — reads logs, runs doctor, prints output
// ---------------------------------------------------------------------------

export function cliMain(): void {
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skillRecords = readJsonl<SkillUsageRecord>(SKILL_LOG);
  const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
  const auditEntries = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
  const doctorResult = doctor();

  const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
  const output = formatStatus(result);
  console.log(output);
}
