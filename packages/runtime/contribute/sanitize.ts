/**
 * Privacy sanitization for contribution bundles.
 *
 * Two levels:
 *   conservative (default) — redacts paths, emails, secrets, IPs, project names, session IDs
 *   aggressive — extends conservative with identifiers, quoted strings, modules, truncation
 *
 * All functions are pure (no side effects).
 */

import {
  AGGRESSIVE_MAX_QUERY_LENGTH,
  EMAIL_PATTERN,
  FILE_PATH_PATTERN,
  IDENTIFIER_PATTERN,
  IP_PATTERN,
  MODULE_PATTERN,
  PII_PATTERNS,
  SECRET_PATTERNS,
} from "../constants.js";
import { ContributionBundle } from "../types.js";
import { Schema } from "effect";

// UUID v4 pattern for session ID redaction
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Quoted string patterns for aggressive mode
const DOUBLE_QUOTED_PATTERN = /"[^"]*"/g;
const SINGLE_QUOTED_PATTERN = /'[^']*'/g;

/** Apply a set of regex patterns to text, replacing matches with a token. Clones each regex to reset lastIndex. */
function applyPatterns(text: string, patterns: readonly RegExp[], token: string): string {
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), token);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Secret-only sanitization (used by redactSecretsDeep for defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Apply only SECRET_PATTERNS redaction to a string.
 * Lighter than sanitizeConservative — no path/email/IP/UUID replacement.
 */
export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  return applyPatterns(text, SECRET_PATTERNS, "[SECRET]");
}

/**
 * Recursively traverse a value and redact secrets in all string leaves.
 * Non-string primitives, Dates, and other non-plain objects pass through unchanged.
 * Does NOT mutate the input — returns a new structure.
 */
// SAFETY-UNKNOWN: This privacy boundary intentionally accepts and returns arbitrary runtime values;
// only string leaves in arrays and plain objects are transformed.
export function redactSecretsDeep(value: unknown): unknown {
  // SAFETY-TYPEOF: This privacy boundary accepts arbitrary nested runtime values and must identify
  // string leaves for redaction without serializing Dates or non-plain objects.
  if (typeof value === "string") {
    return sanitizeSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item));
  }
  // SAFETY-TYPEOF: The recursive privacy boundary must distinguish plain object containers from
  // primitive leaves before consulting prototypes, while passing Dates and class instances through.
  if (value && typeof value === "object" && !(value instanceof Date)) {
    // Only recurse into plain objects — pass through Map, Set, RegExp, class instances, etc.
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return value;
    // SAFETY-UNKNOWN: A plain object can contain arbitrary runtime values; this local accumulator
    // preserves every enumerable key while recursively sanitizing its value.
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactSecretsDeep(entry);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Conservative sanitization
// ---------------------------------------------------------------------------

export function sanitizeConservative(text: string, projectName?: string): string {
  if (!text) return text;

  let result = text;

  // Secrets first (longest/most specific patterns)
  result = applyPatterns(result, SECRET_PATTERNS, "[SECRET]");

  // PII (phone numbers, credit cards, SSNs, IPv6, DOBs)
  result = applyPatterns(result, PII_PATTERNS, "[PII]");

  // File paths
  result = result.replace(new RegExp(FILE_PATH_PATTERN.source, FILE_PATH_PATTERN.flags), "[PATH]");

  // Emails
  result = result.replace(new RegExp(EMAIL_PATTERN.source, EMAIL_PATTERN.flags), "[EMAIL]");

  // IPs
  result = result.replace(new RegExp(IP_PATTERN.source, IP_PATTERN.flags), "[IP]");

  // Project name
  if (projectName) {
    result = result.replace(new RegExp(escapeRegExp(projectName), "g"), "[PROJECT]");
  }

  // Session IDs (UUIDs)
  result = result.replace(UUID_PATTERN, "[SESSION]");

  return result;
}

// ---------------------------------------------------------------------------
// Aggressive sanitization
// ---------------------------------------------------------------------------

export function sanitizeAggressive(text: string, projectName?: string): string {
  if (!text) return text;

  // Start with conservative
  let result = sanitizeConservative(text, projectName);

  // Module paths (import/require/from)
  result = result.replace(new RegExp(MODULE_PATTERN.source, MODULE_PATTERN.flags), (match) => {
    // Preserve the keyword, replace the path
    const keyword = match.match(/^(import|require|from)/)?.[0] ?? "";
    // Determine what follows the keyword
    if (match.includes("(")) {
      return `${keyword}([MODULE])`;
    }
    return `${keyword} [MODULE]`;
  });

  // Quoted strings
  result = result.replace(DOUBLE_QUOTED_PATTERN, "[STRING]");
  result = result.replace(SINGLE_QUOTED_PATTERN, "[STRING]");

  // Long identifiers (camelCase/PascalCase > 8 chars)
  result = result.replace(
    new RegExp(IDENTIFIER_PATTERN.source, IDENTIFIER_PATTERN.flags),
    "[IDENTIFIER]",
  );

  // Truncate
  if (result.length > AGGRESSIVE_MAX_QUERY_LENGTH) {
    result = result.slice(0, AGGRESSIVE_MAX_QUERY_LENGTH);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function sanitize(
  text: string,
  level: "conservative" | "aggressive",
  projectName?: string,
): string {
  return level === "aggressive"
    ? sanitizeAggressive(text, projectName)
    : sanitizeConservative(text, projectName);
}

// ---------------------------------------------------------------------------
// Bundle sanitization
// ---------------------------------------------------------------------------

export function sanitizeBundle(
  bundle: ContributionBundle,
  level: "conservative" | "aggressive",
  projectName?: string,
): ContributionBundle {
  const fieldSanitized: ContributionBundle = {
    ...bundle,
    sanitization_level: level,
    positive_queries: bundle.positive_queries.map((q) => ({
      ...q,
      query: sanitize(q.query, level, projectName),
    })),
    eval_entries: bundle.eval_entries.map((e) => ({
      ...e,
      query: sanitize(e.query, level, projectName),
    })),
  };
  if (bundle.unmatched_queries) {
    fieldSanitized.unmatched_queries = bundle.unmatched_queries.map((query) => ({
      ...query,
      query: sanitize(query.query, level, projectName),
    }));
  }
  if (bundle.pending_proposals) {
    fieldSanitized.pending_proposals = bundle.pending_proposals.map((proposal) => ({
      ...proposal,
      details: sanitize(proposal.details, level, projectName),
    }));
  }

  // Defense-in-depth: recursively redact any secrets that slipped through field-level sanitization
  return Schema.decodeUnknownSync(ContributionBundle)(redactSecretsDeep(fieldSanitized), {
    onExcessProperty: "preserve",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
