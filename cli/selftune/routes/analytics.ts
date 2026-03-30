/**
 * Route handler: GET /api/v2/analytics
 *
 * Returns performance analytics payload from SQLite.
 */

import type { Database } from "bun:sqlite";

import { getAnalyticsPayload } from "../localdb/queries.js";

export function handleAnalytics(db: Database): Response {
  const analytics = getAnalyticsPayload(db);
  return Response.json(analytics);
}
