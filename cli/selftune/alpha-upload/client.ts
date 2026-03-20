/**
 * Alpha upload HTTP client.
 *
 * POSTs V2 canonical push payloads to the cloud API's POST /api/v1/push.
 * Uses native fetch (Bun built-in). Never throws -- returns a
 * PushUploadResult indicating success or failure.
 */

import type { PushUploadResult } from "../alpha-upload-contract.js";
import { getSelftuneVersion } from "../utils/selftune-meta.js";

function isPushUploadResult(value: unknown): value is PushUploadResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.success === "boolean" &&
    Array.isArray(record.errors) &&
    record.errors.every((entry) => typeof entry === "string") &&
    (record.push_id === undefined || typeof record.push_id === "string") &&
    (record._status === undefined || typeof record._status === "number")
  );
}

function isAcceptedPushResponse(
  value: unknown,
): value is { status: "accepted"; push_id: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.status === "accepted" && typeof record.push_id === "string";
}

/**
 * Upload a single V2 push payload to the given endpoint.
 *
 * Returns a typed result. Never throws -- network errors and HTTP
 * failures are captured in the result.
 */
export async function uploadPushPayload(
  payload: Record<string, unknown>,
  endpoint: string,
  apiKey?: string,
): Promise<PushUploadResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `selftune/${getSelftuneVersion()}`,
    };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) {
      // Read body as text first — Bun consumes the stream on .json(),
      // so a failed .json() followed by .text() would throw.
      const body = await response.text();
      if (body.length === 0) {
        return {
          success: true,
          push_id: (payload as { push_id?: string }).push_id,
          errors: [],
        };
      }
      try {
        const parsed: unknown = JSON.parse(body);
        if (isPushUploadResult(parsed)) {
          return parsed;
        }
        if (isAcceptedPushResponse(parsed)) {
          return {
            success: true,
            push_id: parsed.push_id,
            errors: [],
            _status: response.status,
          };
        }
        return {
          success: false,
          errors: ["Invalid JSON response shape for PushUploadResult"],
          _status: response.status,
        };
      } catch {
        return {
          success: false,
          errors: [`Unexpected non-JSON response body: ${body.slice(0, 200)}`],
          _status: response.status,
        };
      }
    }

    // Non-2xx response -- read error text for diagnostics
    const errorText = await response.text().catch(() => "unknown error");
    return {
      success: false,
      errors: [`HTTP ${response.status}: ${errorText.slice(0, 200)}`],
      _status: response.status,
    };
  } catch (err) {
    // Network-level failure (DNS, timeout, connection refused, etc.)
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [message],
      _status: 0,
    };
  }
}
