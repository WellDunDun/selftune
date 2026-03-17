/**
 * selftune status — Skill health summary CLI command.
 *
 * Exports:
 *  - computeStatus()  (pure function, deterministic)
 *  - formatStatus()   (colored terminal output)
 *  - cliMain()        (reads logs, runs doctor, prints output)
 */

import { computeMonitoringSnapshot, MIN_MONITORING_SKILL_CHECKS } from "./monitoring/watch.js";
import { getDb } from "./localdb/db.js";
import { queryEvolutionAudit, queryQueryLog, querySessionTelemetry, querySkillUsageRecords } from "./localdb/queries.js";
import { doctor } from "./observability.js";
import type {
  DoctorResult,
  EvolutionAuditEntry,
  MonitoringSnapshot,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "./utils/query-filter.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SkillStatus {
  name: string;
  passRate: number | null;
  trend: "up" | "down" | "stable" | "unknown";
  missedQueries: number;
  status: "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED" | "UNKNOWN";
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

export const DEFAULT_WINDOW_SESSIONS = 20;
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
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  // Derive unique skill names from skill records
  const skillNames = [...new Set(actionableSkillRecords.map((r) => r.skill_name))];

  // Build per-skill status
  const skills: SkillStatus[] = skillNames.map((skillName) => {
    const skillSpecificRecords = actionableSkillRecords.filter((r) => r.skill_name === skillName);

    // Get baseline from last deployed proposal
    const lastDeployed = getLastDeployedProposalFromEntries(auditEntries, skillName);
    const baselinePassRate = lastDeployed?.eval_snapshot?.pass_rate ?? DEFAULT_BASELINE_PASS_RATE;

    // Compute monitoring snapshot
    const snapshot = computeMonitoringSnapshot(
      skillName,
      telemetry,
      actionableSkillRecords,
      actionableQueryRecords,
      DEFAULT_WINDOW_SESSIONS,
      baselinePassRate,
    );

    // A skill has data when it has explicit check records, regardless of whether any passed.
    // Using triggered-only rows would incorrectly hide meaningful all-false samples.
    const hasData = skillSpecificRecords.length > 0;
    const hasEnoughSamples = snapshot.skill_checks >= MIN_MONITORING_SKILL_CHECKS;

    // Compute pass rate (null only if this skill has no graded checks at all)
    const passRate = hasData ? snapshot.pass_rate : null;

    // Determine trend: compare first-half vs second-half pass rates
    const trend = computeTrend(skillSpecificRecords);

    // Count missed queries for this skill (queries where skill was checked but not triggered)
    const missedQueries = skillSpecificRecords.filter((r) => !r.triggered).length;

    // Determine status (5-state)
    let status: "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED" | "UNKNOWN";
    if (!hasData || passRate === null || !hasEnoughSamples) {
      // Skill exists in logs but has too little data for a meaningful health label
      status = skillSpecificRecords.length > 0 ? "UNGRADED" : "UNKNOWN";
    } else if (snapshot.regression_detected || passRate < 0.4) {
      status = "CRITICAL";
    } else if (passRate < 0.7) {
      status = "WARNING";
    } else {
      status = "HEALTHY";
    }

    return { name: skillName, passRate, trend, missedQueries, status, snapshot };
  });

  // Sort: CRITICAL first, then WARNING, then HEALTHY, then UNKNOWN
  const statusOrder: Record<string, number> = {
    CRITICAL: 0,
    WARNING: 1,
    HEALTHY: 2,
    UNGRADED: 3,
    UNKNOWN: 4,
  };
  skills.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  // Unmatched queries: queries whose text appears in zero triggered skill_usage_log entries
  const triggeredQueryTexts = new Set(
    actionableSkillRecords
      .filter((r) => r.triggered && typeof r.query === "string")
      .map((r) => r.query.toLowerCase().trim()),
  );
  const unmatchedQueries = actionableQueryRecords.filter(
    (q) => !triggeredQueryTexts.has(q.query.toLowerCase().trim()),
  ).length;

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
  // Use word-boundary regex to avoid substring false positives (e.g. "api" matching "rapid-api").
  // Note: skillName originates from internal JSONL logs, not user input, so ReDoS risk is minimal.
  const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const deployed = entries.filter((e) => e.action === "deployed" && pattern.test(e.details ?? ""));
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
  const red = noColor ? (s: string) => s : (s: string) => colorize(s, "#cc4444");
  const amber = noColor ? (s: string) => s : (s: string) => colorize(s, "#c49133");

  const lines: string[] = [];
  lines.push("selftune status");
  lines.push("\u2550".repeat(15));
  lines.push("");

  // Skills table
  const skillCount = result.skills.length;
  lines.push(
    `Skills (${skillCount})${" ".repeat(36 - `Skills (${skillCount})`.length)}Recent data`,
  );
  lines.push("  Name            Pass Rate  Trend  Missed  Status");

  for (const skill of result.skills) {
    const name = skill.name.slice(0, 16).padEnd(16);
    const passRate =
      skill.passRate !== null
        ? `${Math.round(skill.passRate * 100)}%`.padEnd(11)
        : "\u2014".padEnd(11);
    const trend = TREND_SYMBOLS[skill.trend].padEnd(7);
    const missed = String(skill.missedQueries).padEnd(8);
    const statusText =
      skill.status === "CRITICAL"
        ? red(skill.status)
        : skill.status === "WARNING"
          ? amber(skill.status)
          : skill.status === "HEALTHY"
            ? green(skill.status)
            : skill.status === "UNGRADED"
              ? amber(skill.status)
              : amber(skill.status);
    lines.push(`  ${name}${passRate}${trend}${missed}${statusText}`);
  }

  // Onboarding hint for ungraded skills
  const ungradedSkills = result.skills.filter((s) => s.status === "UNGRADED");
  if (ungradedSkills.length > 0) {
    lines.push("");
    lines.push(`  Hint: Run \`selftune grade --skill <name>\` to establish baselines`);
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
  // Expand 3-digit hex (#rgb) to 6-digit (#rrggbb)
  const color =
    hex.length === 4 && hex.startsWith("#")
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// cliMain — reads logs, runs doctor, prints output
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const db = getDb();
  try {
    const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
    const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
    const queryRecords = queryQueryLog(db) as QueryLogRecord[];
    const auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];
    const doctorResult = await doctor();

    const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
    const output = formatStatus(result);
    console.log(output);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`selftune status failed: ${message}`);
    process.exit(1);
  }
}
