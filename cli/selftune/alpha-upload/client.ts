/**
 * Alpha upload HTTP client.
 *
 * POSTs V2 canonical push payloads to the cloud API's POST /api/v1/push.
 * Uses native fetch (Bun built-in). Never throws -- returns a
 * PushUploadResult indicating success or failure.
 */

import type { PushUploadResult } from "../alpha-upload-contract.js";

/** Selftune version for the User-Agent header. */
const SELFTUNE_VERSION = "0.2.7";

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
      "User-Agent": `selftune/${SELFTUNE_VERSION}`,
    };

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
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
        return JSON.parse(body) as PushUploadResult;
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
