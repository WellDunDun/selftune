import {
  CANONICAL_CAPTURE_MODES,
  CANONICAL_COMPLETION_STATUSES,
  CANONICAL_INVOCATION_MODES,
  CANONICAL_PLATFORMS,
  CANONICAL_PROMPT_KINDS,
  CANONICAL_RECORD_KINDS,
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_SOURCE_SESSION_KINDS,
  type CanonicalRawSourceRef,
  type CanonicalRecord,
} from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every(isFiniteNumber);
}

function hasSessionScope(value: Record<string, unknown>): boolean {
  return (
    includesValue(CANONICAL_SOURCE_SESSION_KINDS, value.source_session_kind) &&
    hasString(value, "session_id")
  );
}

export function isCanonicalRawSourceRef(value: unknown): value is CanonicalRawSourceRef {
  return isObject(value);
}

export function isCanonicalRecord(value: unknown): value is CanonicalRecord {
  if (!isObject(value)) return false;
  if (value.schema_version !== CANONICAL_SCHEMA_VERSION) return false;
  if (!includesValue(CANONICAL_RECORD_KINDS, value.record_kind)) return false;
  if (!includesValue(CANONICAL_PLATFORMS, value.platform)) return false;
  if (!includesValue(CANONICAL_CAPTURE_MODES, value.capture_mode)) return false;
  if (!hasString(value, "normalizer_version")) return false;
  if (!hasString(value, "normalized_at")) return false;
  if (!isCanonicalRawSourceRef(value.raw_source_ref)) return false;

  switch (value.record_kind) {
    case "session":
      return (
        hasSessionScope(value) &&
        (value.completion_status === undefined ||
          includesValue(CANONICAL_COMPLETION_STATUSES, value.completion_status))
      );
    case "prompt":
      return (
        hasSessionScope(value) &&
        hasString(value, "prompt_id") &&
        hasString(value, "occurred_at") &&
        hasString(value, "prompt_text") &&
        includesValue(CANONICAL_PROMPT_KINDS, value.prompt_kind) &&
        typeof value.is_actionable === "boolean"
      );
    case "skill_invocation":
      return (
        hasSessionScope(value) &&
        hasString(value, "skill_invocation_id") &&
        hasString(value, "occurred_at") &&
        (value.matched_prompt_id === undefined || hasString(value, "matched_prompt_id")) &&
        hasString(value, "skill_name") &&
        includesValue(CANONICAL_INVOCATION_MODES, value.invocation_mode) &&
        typeof value.triggered === "boolean" &&
        isFiniteNumber(value.confidence)
      );
    case "execution_fact":
      return (
        hasSessionScope(value) &&
        hasString(value, "occurred_at") &&
        isNumberRecord(value.tool_calls_json) &&
        isFiniteNumber(value.total_tool_calls) &&
        isStringArray(value.bash_commands_redacted) &&
        isFiniteNumber(value.assistant_turns) &&
        isFiniteNumber(value.errors_encountered) &&
        (value.completion_status === undefined ||
          includesValue(CANONICAL_COMPLETION_STATUSES, value.completion_status))
      );
    case "normalization_run":
      return (
        hasString(value, "run_id") &&
        hasString(value, "run_at") &&
        isFiniteNumber(value.raw_records_seen) &&
        isFiniteNumber(value.canonical_records_written) &&
        typeof value.repair_applied === "boolean"
      );
    default:
      return false;
  }
}
