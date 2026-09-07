import type { DashboardOperationError } from "./dashboard-operations.js";

export function dashboardCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PATCH, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

export function withDashboardCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(dashboardCorsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function dashboardOperationErrorResponse(error: DashboardOperationError): Response {
  const detail = { code: error.code, message: error.message, retryable: error.retryable };
  const guidance = error.suggestion ? { ...detail, suggestion: error.suggestion } : detail;
  const failures = error.failures ? { ...guidance, failures: error.failures } : guidance;
  const progress = error.progress ? { ...failures, progress: error.progress } : failures;
  return Response.json(
    { error: progress },
    { status: error.status, headers: dashboardCorsHeaders() },
  );
}

export function sameOriginFailure(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  message = "A same-origin dashboard request is required.",
): Response | null {
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins.has(origin)) return null;
  return Response.json(
    { error: { code: "AUTH_MISSING", message } },
    { status: 403, headers: dashboardCorsHeaders() },
  );
}
