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
