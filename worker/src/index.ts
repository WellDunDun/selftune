/**
 * Alpha upload Worker — Cloudflare Worker entry point.
 *
 * Accepts AlphaUploadEnvelope POSTs, validates, and writes to D1.
 * Scaffold only — authentication and rate limiting are deferred.
 */

import type { Env, AlphaUploadResult } from "./types";
import { validateEnvelope } from "./validate";
import { ingestEnvelope } from "./ingest";

function jsonResponse(body: AlphaUploadResult, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only POST to /upload
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST" || url.pathname !== "/upload") {
      return jsonResponse(
        {
          success: false,
          accepted: 0,
          rejected: 0,
          errors: ["Only POST /upload is supported"],
        },
        405
      );
    }

    // Parse body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        {
          success: false,
          accepted: 0,
          rejected: 0,
          errors: ["Request body must be valid JSON"],
        },
        400
      );
    }

    // Validate envelope
    const validation = validateEnvelope(body);
    if (!validation.valid) {
      return jsonResponse(
        {
          success: false,
          accepted: 0,
          rejected: 0,
          errors: validation.errors,
        },
        400
      );
    }

    // Ingest into D1
    const result = await ingestEnvelope(env.ALPHA_DB, body as any);
    const status = result.success ? 200 : 500;

    return jsonResponse(result, status);
  },
} satisfies ExportedHandler<Env>;
