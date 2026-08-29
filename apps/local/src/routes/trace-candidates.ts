import { dashboardCorsHeaders, sameOriginFailure } from "../dashboard-http.js";

const MAX_TRACE_CANDIDATE_BYTES = 8 * 1024;

export interface TraceCandidateRoutes {
  readonly handle: (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ) => Promise<Response | null>;
}

export interface TraceCandidateRouteOptions {
  readonly prepare: (input: unknown) => Promise<unknown>;
  readonly evaluate?: (input: unknown) => Promise<unknown>;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRACE_CANDIDATE_BYTES) {
    throw new RangeError("Trace candidate request is too large.");
  }
  if (!request.body) throw new TypeError("Trace candidate request is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > MAX_TRACE_CANDIDATE_BYTES) {
      await reader.cancel();
      throw new RangeError("Trace candidate request is too large.");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

export function createTraceCandidateRoutes(
  options: TraceCandidateRouteOptions,
): TraceCandidateRoutes {
  return {
    handle: async (request, url, allowedOrigins) => {
      const action =
        url.pathname === "/api/v2/trace-candidates/prepare"
          ? "prepare"
          : url.pathname === "/api/v2/trace-candidates/evaluate"
            ? "evaluate"
            : null;
      if (action === null || request.method !== "POST") {
        return null;
      }
      const unauthorized = sameOriginFailure(request, allowedOrigins);
      if (unauthorized) return unauthorized;
      if (action === "evaluate" && !options.evaluate) {
        return Response.json(
          {
            error: {
              code: "HISTORICAL_REPLAY_UNAVAILABLE",
              message: "No managed replay harness is registered for historical evaluation.",
            },
          },
          { status: 503, headers: dashboardCorsHeaders() },
        );
      }
      try {
        const input = await readBoundedJson(request);
        const result =
          action === "prepare" ? await options.prepare(input) : await options.evaluate!(input);
        return Response.json(result, {
          headers: dashboardCorsHeaders(),
        });
      } catch (error) {
        const tooLarge = error instanceof RangeError;
        return Response.json(
          {
            error: {
              code: tooLarge ? "TRACE_CANDIDATE_TOO_LARGE" : "INVALID_TRACE_CANDIDATE_REQUEST",
              message: tooLarge
                ? "Trace candidate preparation requests cannot exceed 8 KiB."
                : error instanceof Error
                  ? error.message
                  : "Could not prepare candidate.",
            },
          },
          { status: tooLarge ? 413 : 400, headers: dashboardCorsHeaders() },
        );
      }
    },
  };
}
