import type { AlphaUploadEnvelope } from "./types";

const VALID_PAYLOAD_TYPES = new Set(["sessions", "invocations", "evolution"]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate an incoming AlphaUploadEnvelope.
 *
 * Checks structural requirements only — no D1 access needed.
 * Returns a list of human-readable error strings for the agent.
 */
export function validateEnvelope(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (input == null || typeof input !== "object") {
    return { valid: false, errors: ["Request body must be a JSON object"] };
  }

  const envelope = input as Record<string, unknown>;

  // schema_version
  if (envelope.schema_version !== "alpha-1.0") {
    errors.push(
      `schema_version must be "alpha-1.0", got "${envelope.schema_version}"`
    );
  }

  // user_id
  if (typeof envelope.user_id !== "string" || envelope.user_id.length === 0) {
    errors.push("user_id is required and must be a non-empty string");
  }

  // uploaded_at
  if (
    typeof envelope.uploaded_at !== "string" ||
    envelope.uploaded_at.length === 0
  ) {
    errors.push("uploaded_at is required and must be a non-empty ISO 8601 string");
  }

  // payload_type
  if (
    typeof envelope.payload_type !== "string" ||
    !VALID_PAYLOAD_TYPES.has(envelope.payload_type)
  ) {
    errors.push(
      `payload_type must be one of: sessions, invocations, evolution. Got "${envelope.payload_type}"`
    );
  }

  // payload array
  if (!Array.isArray(envelope.payload) || envelope.payload.length === 0) {
    errors.push("payload must be a non-empty array");
  }

  return { valid: errors.length === 0, errors };
}
