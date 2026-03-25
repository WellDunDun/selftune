/**
 * Route handler: GET /api/v2/overview
 *
 * Returns SQLite-backed overview payload with skill listing and version info.
 */

import type { Database } from "bun:sqlite";

import { getOverviewPayload, getSkillsList } from "../localdb/queries.js";

export function handleOverview(db: Database, version: string): Response {
  const overview = getOverviewPayload(db);
  const skills = getSkillsList(db);
  return Response.json({ overview, skills, version });
}
