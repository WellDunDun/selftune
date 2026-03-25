/**
 * synthetic-evals.ts
 *
 * Generates eval queries from a SKILL.md using an LLM, without requiring
 * real session logs. Solves the cold-start problem for new skills that
 * have no telemetry data yet.
 */

import { readFileSync } from "node:fs";

import type { EvalEntry, InvocationType } from "../types.js";
import { callLlm, stripMarkdownFences } from "../utils/llm-call.js";
import { classifyInvocation } from "./hooks-to-evals.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyntheticEvalOptions {
  maxPositives?: number;
  maxNegatives?: number;
  modelFlag?: string;
}

interface RawSyntheticEntry {
  query: string;
  should_trigger: boolean;
  invocation_type?: string;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function buildSyntheticPrompt(
  skillContent: string,
  skillName: string,
  maxPositives: number,
  maxNegatives: number,
  realExamples?: { positive: string[]; negative: string[] },
): { system: string; user: string } {
  const system = `You are generating test queries for a coding agent skill. Given the skill description below, generate realistic user queries.

For POSITIVE queries (should trigger this skill):
- Generate a mix of:
  - Explicit: directly names the skill or uses $${skillName} syntax
  - Implicit: describes the task without naming the skill
  - Contextual: natural language with domain context, proper nouns, dates, filenames
- Vary phrasing, formality, and specificity

For NEGATIVE queries (should NOT trigger this skill):
- Queries that are topically adjacent but wrong intent
- Queries for different skills that share keywords
- Generic queries unrelated to this skill

Output as JSON array with no surrounding text:
[{"query": "...", "should_trigger": true, "invocation_type": "explicit|implicit|contextual|negative"}]`;

  let user = `Skill name: ${skillName}

Skill content:
${skillContent}

Generate exactly ${maxPositives} positive queries (should_trigger: true) and ${maxNegatives} negative queries (should_trigger: false). Return ONLY the JSON array.`;

  if (realExamples && (realExamples.positive.length > 0 || realExamples.negative.length > 0)) {
    const parts: string[] = ["\n\nReal user queries for style and phrasing reference:"];
    if (realExamples.positive.length > 0) {
      parts.push("Queries that triggered this skill:");
      parts.push(...realExamples.positive.map((q) => `  - "${q}"`));
    }
    if (realExamples.negative.length > 0) {
      parts.push("Queries that did NOT trigger (general queries):");
      parts.push(...realExamples.negative.map((q) => `  - "${q}"`));
    }
    parts.push("\nGenerate queries that match this natural phrasing style.");
    user += parts.join("\n");
  }

  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseSyntheticResponse(raw: string, skillName: string): EvalEntry[] {
  let text = raw.trim();

  // Strip markdown fences manually for array-first JSON
  // (stripMarkdownFences slices to first '{' which breaks '[' arrays)
  const fenceMatch = text.match(/^```\w*\n/);
  if (fenceMatch) {
    text = text.slice(fenceMatch[0].length);
    const closingIdx = text.lastIndexOf("```");
    if (closingIdx >= 0) {
      text = text.slice(0, closingIdx);
    }
    text = text.trim();
  }

  // Find the JSON array start
  const bracketIdx = text.indexOf("[");
  if (bracketIdx < 0) {
    // No array found — try stripMarkdownFences as fallback for edge cases
    const cleaned = stripMarkdownFences(raw);
    const retryIdx = cleaned.indexOf("[");
    if (retryIdx >= 0) {
      text = cleaned.slice(retryIdx);
    } else {
      throw new Error(`Failed to parse synthetic eval response as JSON: ${text.slice(0, 200)}`);
    }
  } else {
    text = text.slice(bracketIdx);
  }

  // Trim trailing content after the array closes
  const lastBracket = text.lastIndexOf("]");
  if (lastBracket >= 0) {
    text = text.slice(0, lastBracket + 1);
  }

  const jsonText = text;

  let entries: RawSyntheticEntry[];
  try {
    entries = JSON.parse(jsonText);
  } catch {
    throw new Error(`Failed to parse synthetic eval response as JSON: ${jsonText.slice(0, 200)}`);
  }

  if (!Array.isArray(entries)) {
    throw new Error("Synthetic eval response is not a JSON array");
  }

  const result: EvalEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.query !== "string" || typeof entry.should_trigger !== "boolean") {
      continue;
    }

    const query = entry.query.trim();
    if (!query) continue;

    // For positives, use classifyInvocation to verify/override the LLM's type
    let invocationType: InvocationType;
    if (entry.should_trigger) {
      invocationType = classifyInvocation(query, skillName);
    } else {
      invocationType = "negative";
    }

    result.push({
      query,
      should_trigger: entry.should_trigger,
      invocation_type: invocationType,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateSyntheticEvals(
  skillPath: string,
  skillName: string,
  agent: string,
  options: SyntheticEvalOptions = {},
): Promise<EvalEntry[]> {
  const maxPositives = options.maxPositives ?? 15;
  const maxNegatives = options.maxNegatives ?? 10;

  const skillContent = readFileSync(skillPath, "utf-8");

  // Load real query examples from the database for few-shot style guidance.
  // Uses dynamic imports since SQLite may not be available in all contexts.
  let realExamples: { positive: string[]; negative: string[] } | undefined;
  try {
    const { getDb } = await import("../localdb/db.js");
    const { querySkillUsageRecords, queryQueryLog } = await import("../localdb/queries.js");
    const { isHighConfidencePositiveSkillRecord } =
      await import("../utils/skill-usage-confidence.js");

    const db = getDb();

    // Positives: high-confidence triggered records for this skill
    const skillRecords = querySkillUsageRecords(db);
    const positive = skillRecords
      .filter((r) => isHighConfidencePositiveSkillRecord(r, skillName))
      .map((r) => r.query)
      .filter((q): q is string => typeof q === "string" && q.length > 0)
      .slice(0, 5);

    // Negatives: from all_queries, excluding known positives
    const posSet = new Set(positive.map((q: string) => q.toLowerCase()));
    const allQueries = queryQueryLog(db);
    const negative = allQueries
      .map((r) => r.query)
      .filter(
        (q): q is string => typeof q === "string" && q.length > 0 && !posSet.has(q.toLowerCase()),
      )
      .slice(0, 5);

    if (positive.length > 0) {
      realExamples = { positive, negative };
    }
  } catch {
    // fail-open: synthetic gen works without real examples
  }

  const { system, user } = buildSyntheticPrompt(
    skillContent,
    skillName,
    maxPositives,
    maxNegatives,
    realExamples,
  );

  const raw = await callLlm(system, user, agent, options.modelFlag);
  return parseSyntheticResponse(raw, skillName);
}
