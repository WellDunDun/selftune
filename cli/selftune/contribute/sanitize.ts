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
  SECRET_PATTERNS,
} from "../constants.js";
import type { ContributionBundle } from "../types.js";

// UUID v4 pattern for session ID redaction
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Quoted string patterns for aggressive mode
const DOUBLE_QUOTED_PATTERN = /"[^"]*"/g;
const SINGLE_QUOTED_PATTERN = /'[^']*'/g;

// ---------------------------------------------------------------------------
// Conservative sanitization
// ---------------------------------------------------------------------------

export function sanitizeConservative(text: string, projectName?: string): string {
  if (!text) return text;

  let result = text;

  // Secrets first (longest/most specific patterns)
  for (const pattern of SECRET_PATTERNS) {
    // Clone regex to reset lastIndex
    result = result.replace(new RegExp(pattern.source, pattern.flags), "[SECRET]");
  }

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
  return {
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
    ...(bundle.unmatched_queries
      ? {
          unmatched_queries: bundle.unmatched_queries.map((q) => ({
            ...q,
            query: sanitize(q.query, level, projectName),
          })),
        }
      : {}),
    ...(bundle.pending_proposals
      ? {
          pending_proposals: bundle.pending_proposals.map((p) => ({
            ...p,
            details: sanitize(p.details, level, projectName),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
