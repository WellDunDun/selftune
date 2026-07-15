/**
 * JSONL schema validator for selftune log records.
 * Validates records against REQUIRED_FIELDS from constants.
 */

import { REQUIRED_FIELDS } from "../constants.js";

export type LogType = "session_telemetry" | "skill_usage" | "all_queries";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Fields that must be strings when present. */
const STRING_FIELDS = new Set(["timestamp", "session_id", "query", "skill_name", "source"]);

/**
 * Validate a record against the schema for the given log type.
 * Checks field presence and basic type constraints.
 */
export function validateRecord(record: unknown, logType: LogType): ValidationResult {
  const errors: string[] = [];

  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    errors.push("Record must be a non-null object");
    return { valid: false, errors };
  }

  const rec = record as Record<string, unknown>;
  const requiredFields = REQUIRED_FIELDS[logType];

  if (!requiredFields) {
    errors.push(`Unknown log type: ${logType}`);
    return { valid: false, errors };
  }

  for (const field of requiredFields) {
    if (!(field in rec)) {
      errors.push(`Missing required field: ${field}`);
    } else if (STRING_FIELDS.has(field) && typeof rec[field] !== "string") {
      errors.push(`Field "${field}" must be a string, got ${typeof rec[field]}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
