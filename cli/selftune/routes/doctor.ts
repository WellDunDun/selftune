/**
 * Route handler: GET /api/v2/doctor
 *
 * Returns system health diagnostics (config, logs, hooks, evolution).
 */

import { doctor } from "../observability.js";

export async function handleDoctor(): Promise<Response> {
  const result = await doctor();
  return Response.json(result);
}
