/**
 * validate-body.ts
 *
 * 3-gate validation for full body evolution proposals:
 *   Gate 1 (structural): Pure code — YAML frontmatter, # Title, ## Workflow Routing preserved
 *   Gate 2 (trigger accuracy): Student model YES/NO per eval entry
 *   Gate 3 (quality): Student model rates body clarity/completeness 0.0-1.0
 */

import type { BodyEvolutionProposal, BodyValidationResult, EvalEntry } from "../types.js";
import { callLlm, stripMarkdownFences } from "../utils/llm-call.js";
import { buildTriggerCheckPrompt, parseTriggerResponse } from "../utils/trigger-check.js";

// ---------------------------------------------------------------------------
// Gate 1: Structural validation (pure code, no LLM)
// ---------------------------------------------------------------------------

/**
 * Check that a proposed body preserves required structural elements.
 * Verifies:
 *  - Contains a ## Workflow Routing section
 *  - Routing table has valid markdown table syntax
 *  - Body is non-empty
 */
export function validateBodyStructure(proposedBody: string): { valid: boolean; reason: string } {
  if (!proposedBody || proposedBody.trim().length === 0) {
    return { valid: false, reason: "Proposed body is empty" };
  }

  // Check for ## Workflow Routing section
  if (!proposedBody.includes("## Workflow Routing")) {
    return { valid: false, reason: "Missing required '## Workflow Routing' section" };
  }

  // Extract the routing section and check for table syntax
  const routingIdx = proposedBody.indexOf("## Workflow Routing");
  const afterRouting = proposedBody.slice(routingIdx + "## Workflow Routing".length);
  // Find end of section (next ## heading or EOF)
  const nextSectionMatch = afterRouting.match(/\n## /);
  const routingContent = nextSectionMatch
    ? afterRouting.slice(0, nextSectionMatch.index)
    : afterRouting;

  // Check for pipe-delimited table rows
  const tableLines = routingContent
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && l.trim().endsWith("|"));
  if (tableLines.length < 2) {
    return {
      valid: false,
      reason:
        "Workflow Routing section lacks a valid markdown table (need header + separator + rows)",
    };
  }

  return { valid: true, reason: "Structural validation passed" };
}

// ---------------------------------------------------------------------------
// Gate 2: Trigger accuracy (student model YES/NO)
// ---------------------------------------------------------------------------

/**
 * Run trigger checks on the eval set using the proposed body content.
 * Returns before/after pass rates.
 */
export async function validateBodyTriggerAccuracy(
  originalBody: string,
  proposedBody: string,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
): Promise<{
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  regressions: string[];
}> {
  if (evalSet.length === 0) {
    return { before_pass_rate: 0, after_pass_rate: 0, improved: false, regressions: [] };
  }

  const systemPrompt = "You are an evaluation assistant. Answer only YES or NO.";
  let beforePassed = 0;
  let afterPassed = 0;
  const regressions: string[] = [];

  for (const entry of evalSet) {
    // Check with original body
    const beforePrompt = buildTriggerCheckPrompt(originalBody, entry.query);
    const beforeRaw = await callLlm(systemPrompt, beforePrompt, agent, modelFlag);
    const beforeTriggered = parseTriggerResponse(beforeRaw);
    const beforePass =
      (entry.should_trigger && beforeTriggered) || (!entry.should_trigger && !beforeTriggered);

    // Check with proposed body
    const afterPrompt = buildTriggerCheckPrompt(proposedBody, entry.query);
    const afterRaw = await callLlm(systemPrompt, afterPrompt, agent, modelFlag);
    const afterTriggered = parseTriggerResponse(afterRaw);
    const afterPass =
      (entry.should_trigger && afterTriggered) || (!entry.should_trigger && !afterTriggered);

    if (beforePass) beforePassed++;
    if (afterPass) afterPassed++;

    // Track regressions
    if (beforePass && !afterPass) {
      regressions.push(entry.query);
    }
  }

  const total = evalSet.length;
  const beforePassRate = beforePassed / total;
  const afterPassRate = afterPassed / total;

  return {
    before_pass_rate: beforePassRate,
    after_pass_rate: afterPassRate,
    improved: afterPassRate > beforePassRate,
    regressions,
  };
}

// ---------------------------------------------------------------------------
// Gate 3: Quality assessment (student model 0.0-1.0)
// ---------------------------------------------------------------------------

/** System prompt for quality assessment. */
const QUALITY_ASSESSMENT_SYSTEM = `You are a skill document quality assessor for an AI agent system.

Rate the quality of the provided skill document body on these dimensions:
- Clarity: Is the description clear and unambiguous?
- Completeness: Does it cover the expected use cases?
- Structure: Is it well-organized with proper sections?
- Routing accuracy: Does the routing table seem comprehensive?

Output ONLY valid JSON with exactly these fields:
  - "score" (number): Overall quality score 0.0-1.0
  - "reason" (string): Brief explanation of the score

Do NOT include any text outside the JSON object.`;

/** Assess the quality of a proposed body via student model. */
export async function assessBodyQuality(
  proposedBody: string,
  skillName: string,
  agent: string,
  modelFlag?: string,
): Promise<{ score: number; reason: string }> {
  const userPrompt = `Skill Name: ${skillName}

Proposed Skill Body:
${proposedBody}

Rate the quality of this skill document body. Output ONLY a JSON object with "score" (0.0-1.0) and "reason" fields.`;

  const rawResponse = await callLlm(QUALITY_ASSESSMENT_SYSTEM, userPrompt, agent, modelFlag);
  const cleaned = stripMarkdownFences(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // If parsing fails, return a conservative default
    return { score: 0.5, reason: "Failed to parse quality assessment response" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { score: 0.5, reason: "Quality assessment response is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  const score = typeof obj.score === "number" ? Math.max(0.0, Math.min(1.0, obj.score)) : 0.5;
  const reason = typeof obj.reason === "string" ? obj.reason : "No reason provided";

  return { score, reason };
}

// ---------------------------------------------------------------------------
// Full 3-gate body validation
// ---------------------------------------------------------------------------

/** Minimum quality score to pass Gate 3. */
const QUALITY_THRESHOLD = 0.6;

/** Validate a body proposal through all 3 gates. */
export async function validateBodyProposal(
  proposal: BodyEvolutionProposal,
  evalSet: EvalEntry[],
  agent: string,
  modelFlag?: string,
  qualityThreshold = QUALITY_THRESHOLD,
): Promise<BodyValidationResult> {
  const gateResults: Array<{ gate: string; passed: boolean; reason: string }> = [];

  // Gate 1: Structural validation (pure code)
  const structural = validateBodyStructure(proposal.proposed_body);
  gateResults.push({
    gate: "structural",
    passed: structural.valid,
    reason: structural.reason,
  });

  if (!structural.valid) {
    return {
      proposal_id: proposal.proposal_id,
      gates_passed: 0,
      gates_total: 3,
      gate_results: gateResults,
      improved: false,
      regressions: [],
    };
  }

  // Gate 2: Trigger accuracy (student model)
  const accuracy = await validateBodyTriggerAccuracy(
    proposal.original_body,
    proposal.proposed_body,
    evalSet,
    agent,
    modelFlag,
  );
  gateResults.push({
    gate: "trigger_accuracy",
    passed: accuracy.improved,
    reason: accuracy.improved
      ? `Improved: ${(accuracy.before_pass_rate * 100).toFixed(1)}% -> ${(accuracy.after_pass_rate * 100).toFixed(1)}%`
      : `Not improved: ${(accuracy.before_pass_rate * 100).toFixed(1)}% -> ${(accuracy.after_pass_rate * 100).toFixed(1)}%`,
  });

  // Gate 3: Quality assessment (student model)
  const quality = await assessBodyQuality(
    proposal.proposed_body,
    proposal.skill_name,
    agent,
    modelFlag,
  );
  gateResults.push({
    gate: "quality",
    passed: quality.score >= qualityThreshold,
    reason: `Quality score: ${quality.score.toFixed(2)} (threshold: ${qualityThreshold}) — ${quality.reason}`,
  });

  const gatesPassed = gateResults.filter((g) => g.passed).length;

  return {
    proposal_id: proposal.proposal_id,
    gates_passed: gatesPassed,
    gates_total: 3,
    gate_results: gateResults,
    improved: gatesPassed === 3,
    regressions: accuracy.regressions,
  };
}
