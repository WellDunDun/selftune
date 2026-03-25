/**
 * Route handler: GET /api/v2/orchestrate-runs
 *
 * Returns recent orchestrate run reports from SQLite.
 */

import type { Database } from "bun:sqlite";

import { getOrchestrateRuns } from "../localdb/queries.js";

export function handleOrchestrateRuns(db: Database, limit: number): Response {
  const runs = getOrchestrateRuns(db, limit);
  return Response.json({ runs });
}
