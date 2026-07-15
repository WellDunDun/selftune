/**
 * refine-body.ts
 *
 * Takes failure feedback from a validation pass and asks the teacher LLM
 * to revise specific sections of a body proposal.
 */

import type { BodyEvolutionProposal, BodyValidationResult } from "../types.js";
import { type EffortLevel, callLlm, stripMarkdownFences } from "../utils/llm-call.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** System prompt for the body refiner (teacher) LLM. */
export const BODY_REFINER_SYSTEM = `You are an expert skill document refiner for an AI agent routing system.

You are given a proposed SKILL.md body that failed one or more validation gates.
Your task is to revise the body to address the specific failures while preserving
the parts that passed validation.

Rules:
- Address each failure reason specifically.
- Preserve structural elements: ## Workflow Routing table, ## sections.
- Keep the routing table as a valid markdown table with | Trigger | Workflow | columns.
- Do not make unnecessary changes to parts that passed validation.
- Output ONLY valid JSON with exactly these fields:
  - "refined_body" (string): the revised skill body (markdown, everything below the title)
  - "changes_made" (string): summary of what was changed
  - "confidence" (number): 0.0-1.0 how confident you are this addresses the failures

Do NOT include any text outside the JSON object.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/** Build the refinement prompt from validation feedback. */
export function buildRefinementPrompt(
  proposedBody: string,
  validationResult: BodyValidationResult,
  skillName: string,
  regressionQueries?: string[],
): string {
  const failedGates = validationResult.gate_results
    .filter((g) => !g.passed)
    .map((g) => `  - ${g.gate}: ${g.reason}`)
    .join("\n");

  const regressionSection =
    regressionQueries && regressionQueries.length > 0
      ? `\n\nRegression Queries (these worked before but broke after):\n${regressionQueries.map((q) => `  - "${q}"`).join("\n")}`
      : "";

  return `Skill Name: ${skillName}

Current Proposed Body:
${proposedBody}

Failed Validation Gates:
${failedGates}
${regressionSection}

Revise the proposed body to address the failed validation gates. Preserve what works, fix what doesn't. Output ONLY a JSON object with "refined_body", "changes_made", and "confidence" fields.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/** Parse LLM response text into structured refinement data. */
export function parseRefinementResponse(raw: string): {
  refined_body: string;
  changes_made: string;
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

  if (typeof obj.refined_body !== "string") {
    throw new Error("Missing or invalid 'refined_body' field in LLM response");
  }
  if (typeof obj.changes_made !== "string") {
    throw new Error("Missing or invalid 'changes_made' field in LLM response");
  }
  if (typeof obj.confidence !== "number") {
    throw new Error("Missing or invalid 'confidence' field in LLM response");
  }

  const confidence = Math.max(0.0, Math.min(1.0, obj.confidence));

  return {
    refined_body: obj.refined_body,
    changes_made: obj.changes_made,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Refinement function
// ---------------------------------------------------------------------------

/** Refine a body proposal based on validation feedback. */
export async function refineBodyProposal(
  proposal: BodyEvolutionProposal,
  validationResult: BodyValidationResult,
  agent: string,
  modelFlag?: string,
  effort?: EffortLevel,
): Promise<BodyEvolutionProposal> {
  const prompt = buildRefinementPrompt(
    proposal.proposed_body,
    validationResult,
    proposal.skill_name,
    validationResult.regressions,
  );

  const rawResponse = await callLlm(BODY_REFINER_SYSTEM, prompt, agent, modelFlag, effort);
  const { refined_body, changes_made, confidence } = parseRefinementResponse(rawResponse);

  return {
    ...proposal,
    proposal_id: `${proposal.proposal_id}-refined-${Date.now()}`,
    proposed_body: refined_body,
    rationale: `${proposal.rationale}\n\nRefinement: ${changes_made}`,
    confidence,
    created_at: new Date().toISOString(),
    status: "pending",
  };
}
