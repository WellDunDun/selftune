/**
 * Shared trigger-check utilities.
 *
 * Extracted from validate-proposal.ts so other modules (e.g. body validation,
 * routing validation) can reuse the same prompt-building and response-parsing
 * logic without depending on the evolution layer.
 */

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** Build the trigger check prompt for the LLM. */
export function buildTriggerCheckPrompt(description: string, query: string): string {
  return [
    "Given this skill description, would the following user query trigger this skill?",
    "Respond YES or NO only.",
    "",
    "Skill description:",
    description,
    "",
    "User query:",
    query,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Parse YES/NO from LLM response. */
export function parseTriggerResponse(response: string): boolean {
  const normalized = response.trim().toUpperCase();
  if (normalized.startsWith("YES")) return true;
  if (normalized.startsWith("NO")) return false;
  return false; // conservative default
}

// ---------------------------------------------------------------------------
// Batch prompt building
// ---------------------------------------------------------------------------

/** Build a batch trigger check prompt for multiple queries at once. */
export function buildBatchTriggerCheckPrompt(description: string, queries: string[]): string {
  const numbered = queries.map((q, i) => `${i + 1}. "${q}"`).join("\n");
  return [
    "Given this skill description, would each query trigger this skill?",
    "Respond with the query number followed by YES or NO, one per line.",
    "",
    "Skill description:",
    description,
    "",
    "Queries:",
    numbered,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Batch response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a batch YES/NO response. Returns a boolean array aligned to the
 * original query order. Defaults to false for unparseable or missing lines.
 */
export function parseBatchTriggerResponse(response: string, queryCount: number): boolean[] {
  const results: boolean[] = Array.from({ length: queryCount }, () => false);
  const lines = response.trim().split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to extract a number prefix: "1. YES", "1: YES", "1 YES", "1) YES"
    const match = trimmed.match(/^(\d+)[.):\s]+\s*(.*)/);
    if (!match) continue;

    const idx = parseInt(match[1], 10) - 1; // 1-based to 0-based
    if (idx < 0 || idx >= queryCount) continue;

    const answer = match[2].trim().toUpperCase();
    if (answer.startsWith("YES")) {
      results[idx] = true;
    }
    // NO or anything else stays false (the default)
  }

  return results;
}
