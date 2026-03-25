/**
 * propose-body.ts
 *
 * Generates full body proposals for SKILL.md files using a teacher LLM.
 * The teacher analyzes current content, failure patterns, and missed queries
 * to produce an improved skill body.
 */

import type { BodyEvolutionProposal, EvolutionTarget, FailurePattern } from "../types.js";
import { type EffortLevel, callLlm, stripMarkdownFences } from "../utils/llm-call.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** System prompt for the body generator (teacher) LLM. */
export const BODY_GENERATOR_SYSTEM = `You are an expert skill document author for an AI agent routing system.

Your task is to generate an improved SKILL.md body that better covers the semantic
space of queries that the skill should handle. The body includes everything after
the title line: the description, workflow routing table, instructions, examples, etc.

Rules:
- Preserve the overall structure: description paragraph, ## Workflow Routing table, and other ## sections.
- The ## Workflow Routing table must be a valid markdown table with | Trigger | Workflow | columns.
- Cover the semantic space of the missed queries without being too broad.
- Maintain the original intent and scope of the skill.
- Be specific and actionable in instructions.
- Output ONLY valid JSON with exactly these fields:
  - "proposed_body" (string): the complete improved skill body (markdown, everything below the title)
  - "rationale" (string): explanation of what changed and why
  - "confidence" (number): 0.0-1.0 how confident you are this improves the skill

Do NOT include any text outside the JSON object.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/** Execution telemetry context for body evolution proposals. */
export interface ExecutionContext {
  avgToolCalls: number;
  avgErrors: number;
  avgTurns: number;
  commonTools: string[];
  failureTools: string[];
}

/** Build the user prompt for full body generation. */
export function buildBodyGenerationPrompt(
  currentContent: string,
  failurePatterns: FailurePattern[],
  missedQueries: string[],
  skillName: string,
  fewShotExamples?: string[],
  executionContext?: ExecutionContext,
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

  // Build execution telemetry section if provided
  const executionSection = executionContext
    ? `\n\nExecution Profile (from recent sessions using this skill):\n  Average tool calls per session: ${executionContext.avgToolCalls.toFixed(1)}\n  Average errors per session: ${executionContext.avgErrors.toFixed(1)}\n  Average assistant turns: ${executionContext.avgTurns.toFixed(1)}\n  Most-used tools in successful sessions: ${executionContext.commonTools.join(", ") || "none"}\n  Tools correlated with failures: ${executionContext.failureTools.join(", ") || "none"}`
    : "";

  // Build few-shot examples section if provided
  const fewShotSection =
    fewShotExamples && fewShotExamples.length > 0
      ? `\n\nReference Examples (other well-written skills):\n${fewShotExamples.map((ex, i) => `--- Example ${i + 1} ---\n${ex}`).join("\n\n")}`
      : "";

  return `Skill Name: ${skillName}

Current Skill Content:
${currentContent}

Failure Patterns:
${patternLines.join("\n\n")}

All Missed Queries:
${missedLines}${feedbackSection}${executionSection}${fewShotSection}

Generate an improved full body for the "${skillName}" skill that would correctly handle the missed queries listed above. The body should include everything below the # Title line: description, ## Workflow Routing table, and any other sections. Output ONLY a JSON object with "proposed_body", "rationale", and "confidence" fields.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/** Parse LLM response text into structured body proposal data. */
export function parseBodyProposalResponse(raw: string): {
  proposed_body: string;
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

  if (typeof obj.proposed_body !== "string") {
    throw new Error("Missing or invalid 'proposed_body' field in LLM response");
  }
  if (typeof obj.rationale !== "string") {
    throw new Error("Missing or invalid 'rationale' field in LLM response");
  }
  if (typeof obj.confidence !== "number") {
    throw new Error("Missing or invalid 'confidence' field in LLM response");
  }

  const confidence = Math.max(0.0, Math.min(1.0, obj.confidence));

  return {
    proposed_body: obj.proposed_body,
    rationale: obj.rationale,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Proposal generator
// ---------------------------------------------------------------------------

/** Generate a full body evolution proposal using teacher LLM. */
export async function generateBodyProposal(
  currentContent: string,
  failurePatterns: FailurePattern[],
  missedQueries: string[],
  skillName: string,
  skillPath: string,
  agent: string,
  modelFlag?: string,
  fewShotExamples?: string[],
  executionContext?: ExecutionContext,
  effort?: EffortLevel,
): Promise<BodyEvolutionProposal> {
  const prompt = buildBodyGenerationPrompt(
    currentContent,
    failurePatterns,
    missedQueries,
    skillName,
    fewShotExamples,
    executionContext,
  );
  const rawResponse = await callLlm(BODY_GENERATOR_SYSTEM, prompt, agent, modelFlag, effort);
  const { proposed_body, rationale, confidence } = parseBodyProposalResponse(rawResponse);

  return {
    proposal_id: `evo-body-${skillName}-${Date.now()}`,
    skill_name: skillName,
    skill_path: skillPath,
    original_body: currentContent,
    proposed_body,
    rationale,
    target: "body" as EvolutionTarget,
    failure_patterns: failurePatterns.map((p) => p.pattern_id),
    confidence,
    created_at: new Date().toISOString(),
    status: "pending",
  };
}
