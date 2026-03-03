/**
 * GET /health -- Deployment health check endpoint.
 */

import type { Store } from "../storage/store.js";

export function handleHealthRoute(store: Store): Response {
  try {
    // Simple DB check -- get skill count
    const skills = store.getAllSkillNames();
    return Response.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      skills_tracked: skills.length,
    });
  } catch (err) {
    return Response.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
