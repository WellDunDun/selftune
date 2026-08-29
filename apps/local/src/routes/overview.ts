/**
 * Route handler: GET /api/v2/overview
 *
 * Returns SQLite-backed overview payload with skill listing and version info.
 * Supports optional cursor-based pagination via query params:
 *   ?telemetry_cursor=<json>&telemetry_limit=N&skills_cursor=<json>&skills_limit=N
 */

import type { Database } from "bun:sqlite";

import type {
  AutonomyStatus,
  AutonomyStatusLevel,
  DashboardShellResponse,
  OverviewResponse,
} from "@selftune/runtime/dashboard-contract";
import { parseCursorParam, parseIntParam } from "@selftune/runtime/dashboard-contract";
import {
  getAttentionQueue,
  getOverviewPayload,
  getOverviewPayloadPaginated,
  getPendingProposals,
  getRecentDecisions,
  getSkillTrustSummaries,
  getSkillsList,
  getTrayAttentionSummary,
} from "@selftune/runtime/localdb/queries";
import {
  buildCreatorTestingOverview,
  listSkillTestingReadiness,
} from "@selftune/runtime/testing-readiness";
import { buildTrustWatchlist } from "@selftune/runtime/trust-model";
import { loadWatchedSkills } from "@selftune/runtime/watchlist";

export function summarizeOverview(response: OverviewResponse): DashboardShellResponse {
  return {
    version: response.version,
    skills: response.skills,
    latest_evolutions: response.overview.evolution.flatMap((entry) =>
      entry.skill_name ? [{ timestamp: entry.timestamp, skill_name: entry.skill_name }] : [],
    ),
    pending_proposals: response.overview.pending_proposals.map((proposal) => ({
      proposal_id: proposal.proposal_id,
      action: proposal.action,
      ...(proposal.skill_name ? { skill_name: proposal.skill_name } : {}),
    })),
  };
}

export function summarizeTrayStatus(
  response: Pick<OverviewResponse, "autonomy_status">,
): Pick<OverviewResponse, "autonomy_status"> {
  return { autonomy_status: response.autonomy_status };
}

export function handleDashboardShell(db: Database, version: string): Response {
  const skills = getSkillsList(db, []);
  const latestEvolutions = db
    .query<{ skill_name: string; timestamp: string }, []>(
      `SELECT skill_name, MAX(timestamp) AS timestamp
       FROM evolution_audit
       WHERE skill_name IS NOT NULL
       GROUP BY skill_name
       ORDER BY timestamp DESC`,
    )
    .all();
  const pendingProposals = getPendingProposals(db).map((proposal) => ({
    proposal_id: proposal.proposal_id,
    action: proposal.action,
    ...(proposal.skill_name ? { skill_name: proposal.skill_name } : {}),
  }));
  const response: DashboardShellResponse = {
    version,
    skills,
    latest_evolutions: latestEvolutions,
    pending_proposals: pendingProposals,
  };
  return Response.json(response);
}

export function handleOverview(
  db: Database,
  version: string,
  searchParams?: URLSearchParams,
): Response {
  // -- Autonomy-first enrichment fields ----------------------------------------
  const attentionQueue = getAttentionQueue(db);
  const recentDecisions = getRecentDecisions(db);
  const trustSummaries = getSkillTrustSummaries(db);
  const testingReadiness = listSkillTestingReadiness(db);
  const skills = getSkillsList(db, testingReadiness);
  const pendingReviews = attentionQueue.filter((a) => a.category === "needs_review").length;

  const trustWatchlist = buildTrustWatchlist(trustSummaries);
  const creatorTesting = buildCreatorTestingOverview(skills);
  const autonomyStatus = buildAutonomyStatus(db, {
    skillsObserved: skills.length,
    pendingReviews,
    attentionRequired: attentionQueue.length,
    hasCritical: attentionQueue.some((item) => item.severity === "critical"),
    criticalCount: attentionQueue.filter((item) => item.severity === "critical").length,
    hasRecentDecision: recentDecisions.length > 0,
  });

  const enrichment = {
    watched_skills: loadWatchedSkills(),
    autonomy_status: autonomyStatus,
    attention_queue: attentionQueue,
    trust_watchlist: trustWatchlist,
    recent_decisions: recentDecisions,
    creator_testing: creatorTesting,
  };

  // -- Standard overview payload -----------------------------------------------
  const hasPaginationParams =
    searchParams &&
    (searchParams.has("telemetry_cursor") ||
      searchParams.has("telemetry_limit") ||
      searchParams.has("skills_cursor") ||
      searchParams.has("skills_limit"));
  const hasSkillsPagination =
    searchParams && (searchParams.has("skills_cursor") || searchParams.has("skills_limit"));

  if (!hasPaginationParams) {
    const overview = getOverviewPayload(db);
    const response: OverviewResponse = { overview, skills, version, ...enrichment };
    return Response.json(response);
  }

  // Parse pagination params
  const telemetryCursor = parseCursorParam(searchParams.get("telemetry_cursor"));
  const telemetryLimit = parseIntParam(searchParams.get("telemetry_limit"), 1000);
  const skillsCursor = parseCursorParam(searchParams.get("skills_cursor"));
  const skillsLimit = parseIntParam(searchParams.get("skills_limit"), 2000);

  const overview = getOverviewPayloadPaginated(db, {
    telemetry_cursor: telemetryCursor,
    telemetry_limit: telemetryLimit,
    skills_cursor: skillsCursor,
    skills_limit: skillsLimit,
  });

  const paginatedSkillNames = new Set(overview.skills_page.items.map((row) => row.skill_name));
  const paginatedSkills = hasSkillsPagination
    ? skills.filter((skill) => paginatedSkillNames.has(skill.skill_name))
    : skills;

  return Response.json({ overview, skills: paginatedSkills, version, ...enrichment });
}

export function handleTrayStatus(db: Database): Response {
  const attention = getTrayAttentionSummary(db);
  const autonomyStatus = buildAutonomyStatus(db, {
    ...attention,
    hasRecentDecision: getRecentDecisions(db, 1).length > 0,
  });

  return Response.json({ autonomy_status: autonomyStatus });
}

// -- Internal helpers ----------------------------------------------------------

interface AutonomyStatusInput {
  readonly skillsObserved: number;
  readonly pendingReviews: number;
  readonly attentionRequired: number;
  readonly hasCritical: boolean;
  readonly criticalCount: number;
  readonly hasRecentDecision: boolean;
}

function buildAutonomyStatus(db: Database, input: AutonomyStatusInput): AutonomyStatus {
  let lastRun: string | null = null;
  try {
    const row = db
      .query(`SELECT timestamp FROM orchestrate_runs ORDER BY timestamp DESC LIMIT 1`)
      .get() as { timestamp: string } | null;
    lastRun = row?.timestamp ?? null;
  } catch {
    // Table may not exist
  }

  // "watching" means recent autonomous activity — last run within 24 hours
  // or recent decisions within the 7-day freshness window
  const hasRecentActivity =
    (lastRun != null && Date.now() - new Date(lastRun).getTime() < 24 * 60 * 60 * 1000) ||
    input.hasRecentDecision;

  let level: AutonomyStatusLevel;
  if (input.hasCritical) {
    level = "blocked";
  } else if (input.pendingReviews > 0) {
    level = "needs_review";
  } else if (hasRecentActivity) {
    level = "watching";
  } else {
    level = "healthy";
  }

  let summary: string;
  switch (level) {
    case "healthy":
      summary = "No action needed. System is healthy.";
      break;
    case "blocked": {
      summary = `${input.criticalCount} skill${input.criticalCount !== 1 ? "s" : ""} need${input.criticalCount === 1 ? "s" : ""} urgent attention after rollback.`;
      break;
    }
    case "needs_review":
      summary = `selftune is watching ${input.skillsObserved} skill${input.skillsObserved !== 1 ? "s" : ""} and needs review on ${input.pendingReviews} proposal${input.pendingReviews !== 1 ? "s" : ""}.`;
      break;
    case "watching":
      summary = `selftune is actively watching ${input.skillsObserved} skill${input.skillsObserved !== 1 ? "s" : ""}. No action needed.`;
      break;
  }

  return {
    level,
    summary,
    last_run: lastRun,
    skills_observed: input.skillsObserved,
    pending_reviews: input.pendingReviews,
    attention_required: input.attentionRequired,
  };
}
