import type {
  CloudEvaluationTarget,
  CloudEvaluationTargetBlocker,
} from "@selftune/runtime/evolution/cloud-evaluation-target-client";
import type { CloudEvaluationSubmissionReceipt } from "@selftune/runtime/evolution/cloud-evaluation-submission-client";

import { dashboardCorsHeaders, sameOriginFailure } from "../dashboard-http.js";

const MAX_REQUEST_BYTES = 8 * 1024;
const draftIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface EvaluationDraftTargetResponse {
  readonly draft_id: string;
  readonly lifecycle: "prepared" | "submitted" | "stale";
  readonly run_id: string | null;
  readonly targets: readonly CloudEvaluationTarget[];
  readonly blockers: readonly CloudEvaluationTargetBlocker[];
}

export interface EvaluationDraftSubmissionRoutes {
  readonly handle: (
    request: Request,
    url: URL,
    allowedOrigins: ReadonlySet<string>,
  ) => Promise<Response | null>;
}

export interface EvaluationDraftSubmissionRouteOptions {
  readonly discover: (draftId: string) => Promise<EvaluationDraftTargetResponse>;
  readonly submit: (draftId: string, target: unknown) => Promise<CloudEvaluationSubmissionReceipt>;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: dashboardCorsHeaders() });
}

async function boundedJson(request: Request): Promise<unknown> {
  const length = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new RangeError("too large");
  if (!request.body) throw new TypeError("A target selection is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("too large");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

export function createEvaluationDraftSubmissionRoutes(
  options: EvaluationDraftSubmissionRouteOptions,
): EvaluationDraftSubmissionRoutes {
  return {
    async handle(request, url, allowedOrigins) {
      const match = /^\/api\/v2\/trace-candidates\/([^/]+)\/(targets|submit)$/.exec(url.pathname);
      if (!match) return null;
      const unauthorized = sameOriginFailure(request, allowedOrigins);
      if (unauthorized) return unauthorized;
      const [, encodedDraftId, action] = match;
      let draftId: string;
      try {
        draftId = decodeURIComponent(encodedDraftId);
      } catch {
        return errorResponse(
          400,
          "INVALID_EVALUATION_DRAFT",
          "The evaluation draft id is invalid.",
        );
      }
      if (!draftIdPattern.test(draftId)) {
        return errorResponse(
          400,
          "INVALID_EVALUATION_DRAFT",
          "The evaluation draft id is invalid.",
        );
      }
      if (action === "targets") {
        if (request.method !== "GET") return null;
        try {
          return Response.json(await options.discover(draftId), {
            headers: dashboardCorsHeaders(),
          });
        } catch (error) {
          return errorResponse(
            409,
            "EVALUATION_DRAFT_UNAVAILABLE",
            error instanceof Error ? error.message : "The evaluation draft is unavailable.",
          );
        }
      }
      if (request.method !== "POST") return null;
      try {
        const body = await boundedJson(request);
        return Response.json(await options.submit(draftId, body), {
          status: 202,
          headers: dashboardCorsHeaders(),
        });
      } catch (error) {
        if (error instanceof RangeError) {
          return errorResponse(
            413,
            "EVALUATION_DRAFT_REQUEST_TOO_LARGE",
            "Evaluation target selection cannot exceed 8 KiB.",
          );
        }
        return errorResponse(
          409,
          "EVALUATION_DRAFT_SUBMISSION_REJECTED",
          error instanceof Error ? error.message : "The evaluation draft could not be submitted.",
        );
      }
    },
  };
}
