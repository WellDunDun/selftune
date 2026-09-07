import { dashboardCorsHeaders, sameOriginFailure } from "../dashboard-http.js";
import { Option, Schema } from "effect";
import { CorrectionReviewRequest } from "../correction-review-request.js";
import type { recordLocalCorrectionReviewDecision } from "../correction-review-service.js";
import {
  ExplicitCorrectionStudyRequest,
  type CorrectionStudyServiceResponse,
} from "../correction-study-service.js";
import type { listCorrectionReviews } from "../correction-review-projection.js";
import type { CorrectionSignalPage } from "@selftune/runtime/correction-study/signal-discovery";

const MAX_CORRECTION_STUDY_REQUEST_BYTES = 8 * 1024;
const correctionEpisodeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CorrectionStudyRoutes {
  readonly handle: (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ) => Promise<Response | null>;
}

/**
 * A transport-safe error returned by the correction-study domain boundary.
 * The route preserves its code and status rather than deriving either from a
 * message, so callers can make stable retry and presentation decisions.
 */
export class CorrectionStudyServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "CorrectionStudyServiceError";
  }
}

export interface CorrectionStudyRouteOptions {
  /**
   * Captures one explicit correction episode. The domain owns idempotency;
   * transport deliberately forwards the decoded payload unchanged.
   */
  readonly captureExplicitCorrection: (
    input: ExplicitCorrectionStudyRequest,
  ) => Promise<CorrectionStudyServiceResponse>;
  readonly lookup: (episodeId: string) => Promise<CorrectionStudyServiceResponse>;
  readonly discoverSignals?: (input: {
    readonly limit: number;
    readonly cursor: string | null;
  }) => Promise<CorrectionSignalPage>;
  readonly recordReviewDecision?: (
    input: CorrectionReviewRequest,
  ) => Promise<ReturnType<typeof recordLocalCorrectionReviewDecision>>;
  readonly listReviews?: (
    limit: number,
  ) => Promise<{ readonly items: ReturnType<typeof listCorrectionReviews> }>;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: dashboardCorsHeaders() });
}

async function boundedText(request: Request): Promise<string> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CORRECTION_STUDY_REQUEST_BYTES) {
    throw new RangeError("too large");
  }
  if (!request.body) throw new TypeError("An explicit correction payload is required.");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let body = "";
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- stream chunks are inherently sequential.
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > MAX_CORRECTION_STUDY_REQUEST_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- cancellation belongs to the current read.
      await reader.cancel();
      throw new RangeError("too large");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

function serviceErrorResponse(
  cause: unknown,
  fallbackStatus: number,
  fallbackCode: string,
  fallbackMessage: string,
): Response {
  if (cause instanceof CorrectionStudyServiceError) {
    const status = cause.status >= 400 && cause.status <= 599 ? cause.status : 409;
    return errorResponse(status, cause.code, cause.message);
  }
  return errorResponse(fallbackStatus, fallbackCode, fallbackMessage);
}

function decodeEpisodeId(encodedEpisodeId: string): string | null {
  try {
    const episodeId = decodeURIComponent(encodedEpisodeId);
    return correctionEpisodeIdPattern.test(episodeId) ? episodeId : null;
  } catch {
    return null;
  }
}

function signalQuery(url: URL): { readonly limit: number; readonly cursor: string | null } | null {
  const requestedLimit = url.searchParams.get("limit");
  const limit = requestedLimit === null ? 25 : Number(requestedLimit);
  const cursor = url.searchParams.get("cursor");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 128 ||
    (cursor !== null && cursor.length > 1024)
  ) {
    return null;
  }
  return { limit, cursor };
}

export function createCorrectionStudyRoutes(
  options: CorrectionStudyRouteOptions,
): CorrectionStudyRoutes {
  return {
    async handle(request, url, allowedOrigins) {
      if (url.pathname === "/api/v2/correction-studies/signals" && request.method === "GET") {
        const unauthorized = sameOriginFailure(request, allowedOrigins);
        if (unauthorized) return unauthorized;
        const input = signalQuery(url);
        if (!input) {
          return errorResponse(
            400,
            "INVALID_CORRECTION_SIGNAL_QUERY",
            "Signal discovery requires a limit from 1 to 128 and a bounded cursor.",
          );
        }
        if (!options.discoverSignals) {
          return errorResponse(
            503,
            "CORRECTION_SIGNAL_DISCOVERY_UNAVAILABLE",
            "Correction signal discovery is unavailable.",
          );
        }
        try {
          return Response.json(await options.discoverSignals(input), {
            headers: dashboardCorsHeaders(),
          });
        } catch (error) {
          return serviceErrorResponse(
            error,
            503,
            "CORRECTION_SIGNAL_DISCOVERY_UNAVAILABLE",
            "Correction signal discovery is unavailable.",
          );
        }
      }

      if (url.pathname === "/api/v2/correction-studies/reviews" && request.method === "GET") {
        if (request.headers.has("origin")) {
          const unauthorized = sameOriginFailure(request, allowedOrigins);
          if (unauthorized) return unauthorized;
        }
        const input = signalQuery(url);
        if (!input)
          return errorResponse(
            400,
            "INVALID_CORRECTION_REVIEW_QUERY",
            "Review listing requires a limit from 1 to 128 and a bounded cursor.",
          );
        if (!options.listReviews)
          return errorResponse(
            503,
            "CORRECTION_REVIEW_UNAVAILABLE",
            "Correction review is unavailable.",
          );
        try {
          return Response.json(await options.listReviews(input.limit), {
            headers: dashboardCorsHeaders(),
          });
        } catch (cause) {
          return serviceErrorResponse(
            cause,
            503,
            "CORRECTION_REVIEW_UNAVAILABLE",
            "Correction review is unavailable.",
          );
        }
      }

      if (
        url.pathname === "/api/v2/correction-studies/review-decisions" &&
        request.method === "POST"
      ) {
        const unauthorized = sameOriginFailure(request, allowedOrigins);
        if (unauthorized) return unauthorized;
        if (!options.recordReviewDecision) {
          return errorResponse(
            503,
            "CORRECTION_REVIEW_UNAVAILABLE",
            "Correction review is unavailable.",
          );
        }
        try {
          const payload: unknown = JSON.parse(await boundedText(request));
          const input = Schema.decodeUnknownOption(CorrectionReviewRequest)(payload);
          if (Option.isNone(input)) {
            return errorResponse(
              400,
              "INVALID_CORRECTION_REVIEW",
              "A review must name a candidate, action, reason, and immutable manifest.",
            );
          }
          return Response.json(await options.recordReviewDecision(input.value), {
            headers: dashboardCorsHeaders(),
          });
        } catch (error) {
          if (error instanceof RangeError) {
            return errorResponse(
              413,
              "CORRECTION_REVIEW_REQUEST_TOO_LARGE",
              "Review requests cannot exceed 8 KiB.",
            );
          }
          if (error instanceof SyntaxError || error instanceof TypeError) {
            return errorResponse(
              400,
              "INVALID_CORRECTION_REVIEW_REQUEST",
              "The review payload must be valid JSON.",
            );
          }
          return serviceErrorResponse(
            error,
            409,
            "CORRECTION_REVIEW_FAILED",
            "The review decision could not be recorded.",
          );
        }
      }

      if (
        url.pathname === "/api/v2/correction-studies/explicit-corrections" &&
        request.method === "POST"
      ) {
        const unauthorized = sameOriginFailure(request, allowedOrigins);
        if (unauthorized) return unauthorized;
        try {
          const payload: unknown = JSON.parse(await boundedText(request));
          const input = Schema.decodeUnknownOption(ExplicitCorrectionStudyRequest)(payload);
          if (Option.isNone(input)) {
            return errorResponse(
              400,
              "INVALID_CORRECTION_STUDY_REQUEST",
              "The explicit correction payload must match the correction study contract.",
            );
          }
          return Response.json(await options.captureExplicitCorrection(input.value), {
            status: 200,
            headers: dashboardCorsHeaders(),
          });
        } catch (error) {
          if (error instanceof RangeError) {
            return errorResponse(
              413,
              "CORRECTION_STUDY_REQUEST_TOO_LARGE",
              "Explicit correction capture requests cannot exceed 8 KiB.",
            );
          }
          if (error instanceof SyntaxError || error instanceof TypeError) {
            return errorResponse(
              400,
              "INVALID_CORRECTION_STUDY_REQUEST",
              "The explicit correction payload must be valid JSON.",
            );
          }
          return serviceErrorResponse(
            error,
            409,
            "CORRECTION_STUDY_CAPTURE_FAILED",
            "The explicit correction could not be captured.",
          );
        }
      }

      const match = /^\/api\/v2\/correction-studies(?:\/(.*))?$/.exec(url.pathname);
      if (!match || request.method !== "GET") return null;
      const unauthorized = sameOriginFailure(request, allowedOrigins);
      if (unauthorized) return unauthorized;
      const episodeId = decodeEpisodeId(match[1] ?? "");
      if (!episodeId) {
        return errorResponse(
          400,
          "INVALID_CORRECTION_EPISODE",
          "The correction episode id is invalid.",
        );
      }
      try {
        return Response.json(await options.lookup(episodeId), {
          headers: dashboardCorsHeaders(),
        });
      } catch (error) {
        return serviceErrorResponse(
          error,
          503,
          "CORRECTION_STUDY_LOOKUP_FAILED",
          "The correction study is unavailable.",
        );
      }
    },
  };
}
