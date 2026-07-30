import type { DashboardOperationError } from "./dashboard-operations.js";

export function dashboardCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        retryable: error.retryable,
        ...(error.failures ? { failures: error.failures } : {}),
        ...(error.progress ? { progress: error.progress } : {}),
      },
    },
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
