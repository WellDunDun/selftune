/**
 * Route handler: GET /api/v2/overview
 *
 * Returns SQLite-backed overview payload with skill listing and version info.
 * Supports optional cursor-based pagination via query params:
 *   ?telemetry_cursor=<json>&telemetry_limit=N&skills_cursor=<json>&skills_limit=N
 */

import type { Database } from "bun:sqlite";

import { parseCursorParam, parseIntParam } from "../dashboard-contract.js";
import {
  getOverviewPayload,
  getOverviewPayloadPaginated,
  getSkillsList,
} from "../localdb/queries.js";

export function handleOverview(
  db: Database,
  version: string,
  searchParams?: URLSearchParams,
): Response {
  const skills = getSkillsList(db);

  // Check if any pagination params are provided
  const hasPaginationParams =
    searchParams &&
    (searchParams.has("telemetry_cursor") ||
      searchParams.has("telemetry_limit") ||
      searchParams.has("skills_cursor") ||
      searchParams.has("skills_limit"));

  if (!hasPaginationParams) {
    // Backward-compatible: return the unpaginated overview
    const overview = getOverviewPayload(db);
    return Response.json({ overview, skills, version });
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

  return Response.json({ overview, skills, version });
}
