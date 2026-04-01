/**
 * Route handler: GET /api/v2/overview
 *
 * Returns SQLite-backed overview payload with skill listing and version info.
 * Supports optional cursor-based pagination via query params:
 *   ?telemetry_cursor=<json>&telemetry_limit=N&skills_cursor=<json>&skills_limit=N
 */

import type { Database } from "bun:sqlite";

import type {
  AttentionItem,
  AutonomousDecision,
  AutonomyStatus,
  AutonomyStatusLevel,
  OverviewResponse,
} from "../dashboard-contract.js";
import { parseCursorParam, parseIntParam } from "../dashboard-contract.js";
import {
  getAttentionQueue,
  getOverviewPayload,
  getOverviewPayloadPaginated,
  getRecentDecisions,
  getSkillTrustSummaries,
  getSkillsList,
} from "../localdb/queries.js";
import { buildTrustWatchlist } from "../trust-model.js";
import { loadWatchedSkills } from "../watchlist.js";

export function handleOverview(
  db: Database,
  version: string,
  searchParams?: URLSearchParams,
): Response {
  const skills = getSkillsList(db);

  // -- Autonomy-first enrichment fields ----------------------------------------
  const attentionQueue = getAttentionQueue(db);
  const recentDecisions = getRecentDecisions(db);
  const trustSummaries = getSkillTrustSummaries(db);
  const pendingReviews = attentionQueue.filter((a) => a.category === "needs_review").length;

  const trustWatchlist = buildTrustWatchlist(trustSummaries);
  const autonomyStatus = buildAutonomyStatus(
    db,
    attentionQueue,
    recentDecisions,
    skills.length,
    pendingReviews,
  );

  const enrichment = {
    watched_skills: loadWatchedSkills(),
    autonomy_status: autonomyStatus,
    attention_queue: attentionQueue,
    trust_watchlist: trustWatchlist,
    recent_decisions: recentDecisions,
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

// -- Internal helpers ----------------------------------------------------------

function buildAutonomyStatus(
  db: Database,
  attentionQueue: AttentionItem[],
  recentDecisions: AutonomousDecision[],
  skillsObserved: number,
  pendingReviews: number,
): AutonomyStatus {
  let lastRun: string | null = null;
  try {
    const row = db
      .query(`SELECT timestamp FROM orchestrate_runs ORDER BY timestamp DESC LIMIT 1`)
      .get() as { timestamp: string } | null;
    lastRun = row?.timestamp ?? null;
  } catch {
    // Table may not exist
  }

  const hasCritical = attentionQueue.some((a) => a.severity === "critical");

  // "watching" means recent autonomous activity — last run within 24 hours
  // or recent decisions within the 7-day freshness window
  const hasRecentActivity =
    (lastRun != null && Date.now() - new Date(lastRun).getTime() < 24 * 60 * 60 * 1000) ||
    recentDecisions.length > 0;

  let level: AutonomyStatusLevel;
  if (hasCritical) {
    level = "blocked";
  } else if (pendingReviews > 0) {
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
      const critCount = attentionQueue.filter((a) => a.severity === "critical").length;
      summary = `${critCount} skill${critCount !== 1 ? "s" : ""} need${critCount === 1 ? "s" : ""} urgent attention after rollback.`;
      break;
    }
    case "needs_review":
      summary = `selftune is watching ${skillsObserved} skill${skillsObserved !== 1 ? "s" : ""} and needs review on ${pendingReviews} proposal${pendingReviews !== 1 ? "s" : ""}.`;
      break;
    case "watching":
      summary = `selftune is actively watching ${skillsObserved} skill${skillsObserved !== 1 ? "s" : ""}. No action needed.`;
      break;
  }

  return {
    level,
    summary,
    last_run: lastRun,
    skills_observed: skillsObserved,
    pending_reviews: pendingReviews,
    attention_required: attentionQueue.length,
  };
}
