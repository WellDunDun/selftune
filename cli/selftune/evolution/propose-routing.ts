/**
 * propose-routing.ts
 *
 * Generates improved routing table proposals using LLM analysis of failure
 * patterns. Targets the `## Workflow Routing` section of a SKILL.md file.
 */

import type { BodyEvolutionProposal, EvolutionTarget, FailurePattern } from "../types.js";
import { type EffortLevel, callLlm, stripMarkdownFences } from "../utils/llm-call.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** System prompt for the routing table proposer LLM. */
export const ROUTING_PROPOSER_SYSTEM = `You are a workflow routing optimizer for an AI agent skill system.

Your task is to analyze the current routing table and its failure patterns,
then propose an improved routing table that would correctly route missed queries
while preserving correct routing for existing queries.

Rules:
- The routing table must be a valid markdown table with | Trigger | Workflow | columns.
- Each row maps a trigger pattern to the workflow it should activate.
- Cover the semantic space of the missed queries without being too broad.
- Maintain the original intent and scope of the skill routing.
- Output ONLY valid JSON with exactly these fields:
  - "proposed_routing" (string): the improved routing table in markdown format
  - "rationale" (string): explanation of what changed and why
  - "confidence" (number): 0.0-1.0 how confident you are this improves routing

Do NOT include any text outside the JSON object.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/** Build the user prompt for routing table proposal. */
export function buildRoutingProposalPrompt(
  currentRouting: string,
  fullSkillContent: string,
  failurePatterns: FailurePattern[],
  missedQueries: string[],
  skillName: string,
): string {
  const patternLines = failurePatterns.map((p) => {
    const queries = p.missed_queries.map((q) => `    - "${q}"`).join("\n");
    return `  Pattern ${p.pattern_id} (frequency: ${p.frequency}, type: ${p.invocation_type}):\n${queries}`;
  });

  const missedLines = missedQueries.map((q) => `  - "${q}"`).join("\n");

  // Build failure feedback section if any patterns have feedback
  const feedbackLines: string[] = [];
  for (const p of failurePatterns) {
    if (p.feedback && p.feedback.length > 0) {
      for (const fb of p.feedback) {
        feedbackLines.push(`  Query: "${fb.query}"`);
        feedbackLines.push(`    Failure reason: ${fb.failure_reason}`);
        feedbackLines.push(`    Improvement hint: ${fb.improvement_hint}`);
      }
    }
  }
  const feedbackSection =
    feedbackLines.length > 0 ? `\n\nStructured Failure Analysis:\n${feedbackLines.join("\n")}` : "";

  return `Skill Name: ${skillName}

Current Routing Table:
${currentRouting}

Full Skill Content:
${fullSkillContent}

Failure Patterns:
${patternLines.join("\n\n")}

All Missed Queries:
${missedLines}${feedbackSection}

Propose an improved routing table for the "${skillName}" skill that would correctly route the missed queries listed above. Output ONLY a JSON object with "proposed_routing", "rationale", and "confidence" fields.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/** Parse LLM response text into structured routing proposal data. */
export function parseRoutingProposalResponse(raw: string): {
  proposed_routing: string;
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

  if (typeof obj.proposed_routing !== "string") {
    throw new Error("Missing or invalid 'proposed_routing' field in LLM response");
  }
  if (typeof obj.rationale !== "string") {
    throw new Error("Missing or invalid 'rationale' field in LLM response");
  }
  if (typeof obj.confidence !== "number") {
    throw new Error("Missing or invalid 'confidence' field in LLM response");
  }

  const confidence = Math.max(0.0, Math.min(1.0, obj.confidence));

  return {
    proposed_routing: obj.proposed_routing,
    rationale: obj.rationale,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Proposal generator
// ---------------------------------------------------------------------------

/** Generate a routing table evolution proposal using LLM. */
export async function generateRoutingProposal(
  currentRouting: string,
  fullSkillContent: string,
  failurePatterns: FailurePattern[],
  missedQueries: string[],
  skillName: string,
  skillPath: string,
  agent: string,
  modelFlag?: string,
  effort?: EffortLevel,
): Promise<BodyEvolutionProposal> {
  const prompt = buildRoutingProposalPrompt(
    currentRouting,
    fullSkillContent,
    failurePatterns,
    missedQueries,
    skillName,
  );
  const rawResponse = await callLlm(ROUTING_PROPOSER_SYSTEM, prompt, agent, modelFlag, effort);
  const { proposed_routing, rationale, confidence } = parseRoutingProposalResponse(rawResponse);

  return {
    proposal_id: `evo-routing-${skillName}-${Date.now()}`,
    skill_name: skillName,
    skill_path: skillPath,
    original_body: currentRouting,
    proposed_body: proposed_routing,
    rationale,
    target: "routing" as EvolutionTarget,
    failure_patterns: failurePatterns.map((p) => p.pattern_id),
    confidence,
    created_at: new Date().toISOString(),
    status: "pending",
  };
}
