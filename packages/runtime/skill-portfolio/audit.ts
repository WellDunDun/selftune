import { isAbsolute, relative, resolve, sep } from "node:path";

import { getDb } from "@selftune/local-store";

import type {
  PortfolioAuditEntry,
  PortfolioAuditResult,
  PortfolioClassification,
  PortfolioRecommendation,
} from "../dashboard-contract.js";
import { analyzeSkillFamilyOverlap } from "../eval/family-overlap.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
  queryTrustedSkillObservationRows,
  type TrustedSkillObservationRow,
} from "../localdb/queries.js";
import type { QueryLogRecord, SessionTelemetryRecord, SkillUsageRecord } from "../types.js";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "../utils/skill-discovery.js";
export const DEFAULT_MIN_SESSIONS = 20;
export const DEFAULT_INACTIVE_DAYS = 30;
export const DEFAULT_MIN_CHECKS = 10;
export const DEFAULT_ROUTING_MISS_RATE = 0.85;

interface BuildAuditOptions {
  now?: Date;
  minSessions?: number;
  inactiveDays?: number;
  minChecks?: number;
  routingMissRate?: number;
  consolidationSkillNames?: ReadonlySet<string>;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function daysBetween(later: Date, earlierIso: string): number {
  const earlier = new Date(earlierIso);
  if (Number.isNaN(earlier.getTime())) return 0;
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86_400_000));
}

function sessionsAfter(sessions: SessionTelemetryRecord[], timestamp: string): number {
  return new Set(
    sessions
      .filter((session) => session.timestamp > timestamp)
      .map((session) => session.session_id),
  ).size;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function sessionsEligibleForSkill(
  installed: InstalledSkillPackage,
  sessions: SessionTelemetryRecord[],
): SessionTelemetryRecord[] {
  if (installed.skill_scope !== "project" || !installed.skill_project_root) return sessions;
  return sessions.filter(
    (session) => session.cwd && isWithinPath(installed.skill_project_root!, session.cwd),
  );
}

function classifyEntry(options: {
  installed: InstalledSkillPackage;
  observations: TrustedSkillObservationRow[];
  sessions: SessionTelemetryRecord[];
  now: Date;
  minSessions: number;
  inactiveDays: number;
  minChecks: number;
  routingMissRate: number;
  consolidationCandidate: boolean;
}): PortfolioAuditEntry {
  const { installed, observations, sessions, now } = options;
  const triggered = observations.filter((row) => row.triggered === 1);
  const lastSeenAt =
    observations
      .map((row) => row.occurred_at)
      .filter((value): value is string => value != null)
      .toSorted((left, right) => right.localeCompare(left))[0] ?? null;
  const lastInvokedAt =
    triggered
      .map((row) => row.occurred_at)
      .filter((value): value is string => value != null)
      .toSorted((left, right) => right.localeCompare(left))[0] ?? null;
  const evidenceStart = lastInvokedAt ?? installed.modified_at;
  const eligibleSessions = sessionsEligibleForSkill(installed, sessions);
  const sessionsSinceInvocation = sessionsAfter(eligibleSessions, evidenceStart);
  const inactiveDays = daysBetween(now, evidenceStart);
  const missRate = observations.length > 0 ? 1 - triggered.length / observations.length : null;
  const protectedSkill =
    normalizedName(installed.name) === "selftune" ||
    installed.skill_scope === "system" ||
    installed.skill_scope === "admin";

  let classification: PortfolioClassification;
  let recommendation: PortfolioRecommendation;
  let reason: string;

  if (protectedSkill) {
    classification = "protected";
    recommendation = "keep";
    reason = "SelfTune and system/admin-managed skills are excluded from portfolio mutation.";
  } else if (
    observations.length >= options.minChecks &&
    (missRate ?? 0) >= options.routingMissRate
  ) {
    classification = "routing_problem";
    recommendation = "repair_routing";
    reason = `${observations.length - triggered.length} of ${observations.length} trusted contextual checks missed invocation; repair routing before considering removal.`;
  } else if (options.consolidationCandidate) {
    classification = "consolidation_candidate";
    recommendation = "review_consolidation";
    reason =
      "Sibling skill evidence suggests overlapping entry points; test a parent workflow before removing any package.";
  } else if (
    inactiveDays >= options.inactiveDays &&
    sessionsSinceInvocation >= options.minSessions
  ) {
    classification = "inactive_candidate";
    recommendation = "review_quarantine";
    reason = lastInvokedAt
      ? `No trusted invocation for ${inactiveDays} days across ${sessionsSinceInvocation} subsequent sessions; review rare-use obligations before quarantine.`
      : `No trusted invocation has ever been recorded in ${inactiveDays} days across ${sessionsSinceInvocation} sessions since the package was modified; review rare-use obligations before quarantine.`;
  } else if (observations.length === 0) {
    classification = "unobserved";
    recommendation = "measure";
    reason =
      "No trustworthy usage evidence exists; absence of observations is not evidence that the skill is unused.";
  } else if (observations.length < options.minChecks) {
    classification = "under_observed";
    recommendation = "measure";
    reason = `Only ${observations.length} trusted checks are available; collect at least ${options.minChecks} before a portfolio decision.`;
  } else {
    classification = "active";
    recommendation = "keep";
    reason = "Recent trusted invocation evidence supports keeping the skill active.";
  }

  return {
    skill_name: installed.name,
    skill_path: installed.skill_path,
    package_path: installed.package_path,
    scope: installed.skill_scope,
    classification,
    recommendation,
    reason,
    evidence: {
      trusted_checks: observations.length,
      triggered_count: triggered.length,
      miss_rate: missRate,
      last_seen_at: lastSeenAt,
      last_invoked_at: lastInvokedAt,
      sessions_since_invocation: sessionsSinceInvocation,
      inactive_days: inactiveDays,
      package_modified_at: installed.modified_at,
    },
  };
}

export function buildPortfolioAudit(
  installedSkills: InstalledSkillPackage[],
  observations: TrustedSkillObservationRow[],
  sessions: SessionTelemetryRecord[],
  options: BuildAuditOptions = {},
): PortfolioAuditResult {
  const now = options.now ?? new Date();
  const minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS;
  const inactiveDays = options.inactiveDays ?? DEFAULT_INACTIVE_DAYS;
  const minChecks = options.minChecks ?? DEFAULT_MIN_CHECKS;
  const routingMissRate = options.routingMissRate ?? DEFAULT_ROUTING_MISS_RATE;
  const installedNameCounts = new Map<string, number>();
  for (const installed of installedSkills) {
    const name = normalizedName(installed.name);
    installedNameCounts.set(name, (installedNameCounts.get(name) ?? 0) + 1);
  }

  const observationMap = new Map<string, TrustedSkillObservationRow[]>();
  for (const observation of observations) {
    const name = normalizedName(observation.skill_name);
    const existing = observationMap.get(name);
    if (existing) existing.push(observation);
    else observationMap.set(name, [observation]);
  }

  const skills = installedSkills.map((installed) => {
    const name = normalizedName(installed.name);
    const installedPath = resolve(installed.skill_path);
    const matchingObservations = (observationMap.get(name) ?? []).filter((observation) => {
      if (observation.skill_path) return resolve(observation.skill_path) === installedPath;
      return installedNameCounts.get(name) === 1;
    });
    return classifyEntry({
      installed,
      observations: matchingObservations,
      sessions,
      now,
      minSessions,
      inactiveDays,
      minChecks,
      routingMissRate,
      consolidationCandidate:
        options.consolidationSkillNames?.has(normalizedName(installed.name)) ?? false,
    });
  });
  const counts: Record<PortfolioClassification, number> = {
    protected: 0,
    unobserved: 0,
    under_observed: 0,
    routing_problem: 0,
    active: 0,
    inactive_candidate: 0,
    consolidation_candidate: 0,
  };
  for (const skill of skills) counts[skill.classification]++;

  return {
    generated_at: now.toISOString(),
    thresholds: {
      min_sessions: minSessions,
      inactive_days: inactiveDays,
      min_checks: minChecks,
      routing_miss_rate: routingMissRate,
    },
    session_count: new Set(sessions.map((session) => session.session_id)).size,
    installed_count: skills.length,
    counts,
    skills,
  };
}

function inferFamilyPrefix(skillName: string): string | null {
  const hyphenIndex = skillName.indexOf("-");
  return hyphenIndex > 0 ? skillName.slice(0, hyphenIndex + 1) : null;
}

export function detectConsolidationCandidates(
  installedSkills: InstalledSkillPackage[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  searchDirs: string[],
): Set<string> {
  const families = new Map<string, Set<string>>();
  for (const skill of installedSkills) {
    const prefix = inferFamilyPrefix(skill.name);
    if (!prefix) continue;
    const members = families.get(prefix) ?? new Set<string>();
    members.add(skill.name);
    families.set(prefix, members);
  }

  const candidates = new Set<string>();
  for (const [prefix, memberSet] of families) {
    const members = [...memberSet].toSorted();
    if (members.length < 2) continue;
    const report = analyzeSkillFamilyOverlap(members, skillRecords, queryRecords, {
      familyPrefix: prefix,
      searchDirs,
    });
    if (!report.consolidation_candidate && !report.cold_start_suspicion?.candidate) continue;
    for (const member of members) candidates.add(normalizedName(member));
  }
  return candidates;
}

export function loadPortfolioAudit(
  searchDirs: string[] = getDefaultSkillSearchDirs(),
): PortfolioAuditResult {
  const db = getDb();
  const installed = findInstalledSkillPackages(searchDirs);
  const consolidations = detectConsolidationCandidates(
    installed,
    querySkillUsageRecords(db),
    queryQueryLog(db),
    searchDirs,
  );
  return buildPortfolioAudit(
    installed,
    queryTrustedSkillObservationRows(db),
    querySessionTelemetry(db) as SessionTelemetryRecord[],
    { consolidationSkillNames: consolidations },
  );
}
