/**
 * propose-description.ts
 *
 * Generates improved skill description proposals using LLM analysis of failure
 * patterns. Takes the current description, identified failure patterns, and
 * missed queries, then produces a structured EvolutionProposal with an
 * improved description, rationale, and confidence score.
 */

import type { EvolutionProposal, FailurePattern } from "../types.js";
import { callLlm, stripMarkdownFences } from "../utils/llm-call.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** System prompt for the proposal generator LLM. */
export const PROPOSER_SYSTEM = `You are a skill description optimizer for an AI agent routing system.

Your task is to analyze the current skill description and its failure patterns,
then propose an improved description that would catch the missed queries while
preserving correct routing for existing queries.

Rules:
- The description must be concise and specific.
- It must cover the semantic space of the missed queries without being too broad.
- Maintain the original intent and scope of the skill.
- Output ONLY valid JSON with exactly these fields:
  - "proposed_description" (string): the improved skill description
  - "rationale" (string): explanation of what changed and why
  - "confidence" (number): 0.0-1.0 how confident you are this improves routing

Do NOT include any text outside the JSON object.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/** Build the user prompt for the LLM with context about failures. */
export function buildProposalPrompt(
  currentDescription: string,
  failurePatterns: FailurePattern[],
  missedQueries: string[],
  skillName: string,
): string {
  const patternLines = failurePatterns.map((p) => {
    const queries = p.missed_queries.map((q) => `    - "${q}"`).join("\n");
    return `  Pattern ${p.pattern_id} (frequency: ${p.frequency}, type: ${p.invocation_type}):\n${queries}`;
  });

  const missedLines = missedQueries.map((q) => `  - "${q}"`).join("\n");

  return `Skill Name: ${skillName}

Current Description:
${currentDescription}

Failure Patterns:
${patternLines.join("\n\n")}

All Missed Queries:
${missedLines}

Propose an improved description for the "${skillName}" skill that would correctly route the missed queries listed above. Output ONLY a JSON object with "proposed_description", "rationale", and "confidence" fields.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/** Parse LLM response text into structured proposal data. */
export function parseProposalResponse(raw: string): {
  proposed_description: string;
  rationale: string;
  confidence: number;
} {
  const cleaned = stripMarkdownFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("LLM response is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.proposed_description !== "string") {
    throw new Error("Missing or invalid 'proposed_description' field in LLM response");
  }
  if (typeof obj.rationale !== "string") {
    throw new Error("Missing or invalid 'rationale' field in LLM response");
  }
  if (typeof obj.confidence !== "number") {
    throw new Error("Missing or invalid 'confidence' field in LLM response");
  }

  // Clamp confidence to 0.0-1.0
  const confidence = Math.max(0.0, Math.min(1.0, obj.confidence));

  return {
    proposed_description: obj.proposed_description,
    rationale: obj.rationale,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Proposal generator
// ---------------------------------------------------------------------------

/** Generate a complete evolution proposal using LLM. */
export async function generateProposal(
  currentDescription: string,
  failurePatterns: FailurePattern[],
  missedQueries: string[],
  skillName: string,
  skillPath: string,
  agent: string,
): Promise<EvolutionProposal> {
  const prompt = buildProposalPrompt(currentDescription, failurePatterns, missedQueries, skillName);
  const rawResponse = await callLlm(PROPOSER_SYSTEM, prompt, agent);
  const { proposed_description, rationale, confidence } = parseProposalResponse(rawResponse);

  return {
    proposal_id: `evo-${skillName}-${Date.now()}`,
    skill_name: skillName,
    skill_path: skillPath,
    original_description: currentDescription,
    proposed_description,
    rationale,
    failure_patterns: failurePatterns.map((p) => p.pattern_id),
    eval_results: {
      before: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
      after: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
    },
    confidence,
    created_at: new Date().toISOString(),
    status: "pending",
  };
}
