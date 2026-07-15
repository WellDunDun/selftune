/**
 * Route handler: GET /api/v2/doctor
 *
 * Returns system health diagnostics (config, logs, hooks, evolution).
 */

import { doctor } from "@selftune/runtime/observability";

export async function handleDoctor(): Promise<Response> {
  const result = await doctor();
  return Response.json(result);
}
