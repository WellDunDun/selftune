/**
 * Input validation for contribution bundle submissions.
 *
 * Validates schema, field types, and size constraints at the service boundary.
 */

import type { ContributionBundle } from "../../cli/selftune/types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const MAX_QUERIES = 1000;
const MAX_EVAL_ENTRIES = 500;
const MAX_QUERY_LENGTH = 500;

export function validateBundle(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Payload must be a JSON object"] };
  }

  const bundle = data as Record<string, unknown>;

  // Required fields
  if (
    !bundle.schema_version ||
    (bundle.schema_version !== "1.0" && bundle.schema_version !== "1.1")
  ) {
    errors.push("schema_version must be '1.0' or '1.1'");
  }

  if (!bundle.contributor_id || typeof bundle.contributor_id !== "string") {
    errors.push("contributor_id is required and must be a string");
  }

  if (!bundle.created_at || typeof bundle.created_at !== "string") {
    errors.push("created_at is required and must be a string");
  }

  if (!bundle.agent_type || typeof bundle.agent_type !== "string") {
    errors.push("agent_type is required and must be a string");
  }

  if (
    !bundle.sanitization_level ||
    (bundle.sanitization_level !== "conservative" && bundle.sanitization_level !== "aggressive")
  ) {
    errors.push("sanitization_level must be 'conservative' or 'aggressive'");
  }

  // Arrays
  if (!Array.isArray(bundle.positive_queries)) {
    errors.push("positive_queries must be an array");
  } else if (bundle.positive_queries.length > MAX_QUERIES) {
    errors.push(`positive_queries exceeds max length of ${MAX_QUERIES}`);
  } else {
    for (const q of bundle.positive_queries as Array<Record<string, unknown>>) {
      if (typeof q.query !== "string") {
        errors.push("Each positive_query must have a string 'query' field");
        break;
      }
      if (q.query.length > MAX_QUERY_LENGTH) {
        errors.push(`Query exceeds max length of ${MAX_QUERY_LENGTH} characters`);
        break;
      }
    }
  }

  if (!Array.isArray(bundle.eval_entries)) {
    errors.push("eval_entries must be an array");
  } else if (bundle.eval_entries.length > MAX_EVAL_ENTRIES) {
    errors.push(`eval_entries exceeds max length of ${MAX_EVAL_ENTRIES}`);
  }

  // Session metrics
  if (!bundle.session_metrics || typeof bundle.session_metrics !== "object") {
    errors.push("session_metrics is required and must be an object");
  }

  // Optional: skill_name for 1.1
  if (bundle.schema_version === "1.1" && bundle.skill_name !== undefined) {
    if (typeof bundle.skill_name !== "string") {
      errors.push("skill_name must be a string when provided");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extract the skill name from a bundle, handling both 1.0 and 1.1 schemas.
 */
export function extractSkillName(bundle: Record<string, unknown>): string {
  if (bundle.schema_version === "1.1" && typeof bundle.skill_name === "string") {
    return bundle.skill_name;
  }
  return "selftune"; // Default for 1.0 bundles
}
