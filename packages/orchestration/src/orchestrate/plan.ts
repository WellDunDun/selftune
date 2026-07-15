import type { CandidateContext, SkillAction } from "../orchestrate.js";
import type { SkillStatus } from "@selftune/runtime/status";
import type { EvolutionAuditEntry } from "@selftune/runtime/types";

/**
 * Determines whether a skill should use package search instead of standard
 * evolution. Returns true when the skill has package-level evidence:
 * a frontier candidate exists or a canonical evaluation record is present.
 *
 * This gates the package-search path so only skills with sufficient
 * package-level signal enter the bounded search flow.
 */
export function shouldSelectPackageSearch(skill: SkillStatus, context: CandidateContext): boolean {
  // Package search requires that the candidate context carries a
  // packageFrontierSkills set (populated from package-candidate-state).
  // When present and the skill is listed, we route through package search.
  if (!context.packageFrontierSkills) return false;
  return context.packageFrontierSkills.has(skill.name);
}

/** Candidate selection criteria. */
const CANDIDATE_STATUSES = new Set(["CRITICAL", "WARNING", "UNGRADED"]);

/** Minimum skill_checks before autonomous evolution is allowed. */
export const MIN_CANDIDATE_EVIDENCE = 3;

/** Default cooldown hours after a deploy before re-evolving the same skill. */
export const DEFAULT_COOLDOWN_HOURS = 24;

function candidatePriority(skill: SkillStatus, signalCount = 0): number {
  const statusWeight = skill.status === "CRITICAL" ? 300 : skill.status === "WARNING" ? 200 : 100;
  const missedWeight = Math.min(skill.missedQueries, 50);
  const passPenalty = skill.passRate === null ? 0 : Math.round((1 - skill.passRate) * 100);
  const trendBoost = skill.trend === "down" ? 30 : 0;
  const signalBoost = Math.min(signalCount * 150, 450);
  return statusWeight + missedWeight + passPenalty + trendBoost + signalBoost;
}

export function findRecentlyDeployedSkills(
  auditEntries: EvolutionAuditEntry[],
  windowHours: number,
): Set<string> {
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
  const names = new Set<string>();
  for (const entry of auditEntries) {
    const deployedAtMs = Date.parse(entry.timestamp);
    if (
      entry.action === "deployed" &&
      entry.skill_name &&
      Number.isFinite(deployedAtMs) &&
      deployedAtMs >= cutoffMs
    ) {
      names.add(entry.skill_name);
    }
  }
  return names;
}

export function selectCandidates(skills: SkillStatus[], options: CandidateContext): SkillAction[] {
  const actions: SkillAction[] = [];
  const orderedSkills = [...skills].sort((a, b) => {
    const aSignals = options.signaledSkills?.get(a.name.toLowerCase()) ?? 0;
    const bSignals = options.signaledSkills?.get(b.name.toLowerCase()) ?? 0;
    return candidatePriority(b, bSignals) - candidatePriority(a, aSignals);
  });

  const cooldownHours = options.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const recentlyDeployed = findRecentlyDeployedSkills(options.auditEntries ?? [], cooldownHours);

  for (const skill of orderedSkills) {
    const signalCount = options.signaledSkills?.get(skill.name.toLowerCase()) ?? 0;

    if (options.skillFilter && skill.name !== options.skillFilter) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `filtered out (--skill ${options.skillFilter})`,
      });
      continue;
    }

    if (!CANDIDATE_STATUSES.has(skill.status)) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `status=${skill.status} — no action needed`,
      });
      continue;
    }

    if (recentlyDeployed.has(skill.name)) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `recently evolved (cooldown ${cooldownHours}h) — let it bake`,
      });
      continue;
    }

    const skillChecks = skill.snapshot?.skill_checks ?? 0;
    if (skillChecks < MIN_CANDIDATE_EVIDENCE && skill.status !== "UNGRADED" && signalCount === 0) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `insufficient evidence (${skillChecks}/${MIN_CANDIDATE_EVIDENCE} checks) — need more data`,
      });
      continue;
    }

    if (skill.status === "UNGRADED" && skill.missedQueries === 0 && signalCount === 0) {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: "UNGRADED with 0 missed queries — insufficient signal",
      });
      continue;
    }

    if (skill.status === "WARNING" && skill.missedQueries === 0 && skill.trend !== "down") {
      actions.push({
        skill: skill.name,
        action: "skip",
        reason: `WARNING but no missed queries and trend=${skill.trend} — weak signal`,
      });
      continue;
    }

    const action = shouldSelectPackageSearch(skill, options) ? "package-search" : "evolve";
    actions.push({
      skill: skill.name,
      action,
      reason: `status=${skill.status}, passRate=${skill.passRate !== null ? `${(skill.passRate * 100).toFixed(0)}%` : "—"}, missed=${skill.missedQueries}, trend=${skill.trend}`,
    });
  }

  let activeCount = 0;
  for (const action of actions) {
    if (action.action === "evolve" || action.action === "package-search") {
      activeCount++;
      if (activeCount > options.maxSkills) {
        action.action = "skip";
        action.reason = `capped by --max-skills ${options.maxSkills}`;
      }
    }
  }

  return actions;
}
