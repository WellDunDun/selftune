/**
 * synthetic-evals.ts
 *
 * Generates eval queries from a SKILL.md using an LLM, without requiring
 * real session logs. Solves the cold-start problem for new skills that
 * have no telemetry data yet.
 */

import { readFileSync } from "node:fs";

import type { EvalEntry, InvocationType, SkillUsageRecord } from "../types.js";
import { callLlm, stripMarkdownFences } from "../utils/llm-call.js";
import { findInstalledSkillNames } from "../utils/skill-discovery.js";
import { classifyInvocation } from "./invocation-classifier.js";

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

interface SyntheticPromptRealExamples {
  positive: string[];
  negative: string[];
}

interface PromptFamilyTargets {
  explicitCount: number;
  implicitCount: number;
  contextualCount: number;
  siblingNegativeCount: number;
  adjacentNegativeCount: number;
  unrelatedNegativeCount: number;
}

function getSyntheticSkillSearchDirs(): string[] {
  const cwd = process.cwd();
  const homeDir = process.env.HOME ?? "";
  const codexHome = process.env.CODEX_HOME ?? `${homeDir}/.codex`;
  return [
    `${cwd}/.agents/skills`,
    `${cwd}/.claude/skills`,
    `${homeDir}/.agents/skills`,
    `${homeDir}/.claude/skills`,
    `${codexHome}/skills`,
  ];
}

function inferSiblingSkills(
  skillName: string,
  searchDirs: string[] = getSyntheticSkillSearchDirs(),
): string[] {
  const normalized = skillName.trim().toLowerCase();
  if (!normalized) return [];

  const familyPrefix = normalized.includes("-") ? normalized.split("-")[0] : "";
  const installedNames = [...findInstalledSkillNames(searchDirs)];

  const sameFamily = installedNames
    .filter((name) => name.toLowerCase() !== normalized)
    .filter((name) => familyPrefix && name.toLowerCase().startsWith(`${familyPrefix}-`))
    .sort((a, b) => a.localeCompare(b));

  if (sameFamily.length >= 5) return sameFamily.slice(0, 5);

  const adjacent = installedNames
    .filter((name) => name.toLowerCase() !== normalized)
    .filter((name) => !sameFamily.includes(name))
    .sort((a, b) => a.localeCompare(b));

  return [...sameFamily, ...adjacent].slice(0, 5);
}

function buildPromptFamilyTargets(
  maxPositives: number,
  maxNegatives: number,
  hasSiblingSkills: boolean,
): PromptFamilyTargets {
  const explicitCount = Math.max(1, Math.round(maxPositives * 0.2));
  const contextualCount = Math.max(1, Math.round(maxPositives * 0.4));
  const implicitCount = Math.max(1, maxPositives - explicitCount - contextualCount);

  const siblingNegativeCount =
    hasSiblingSkills && maxNegatives > 0 ? Math.max(1, Math.round(maxNegatives * 0.4)) : 0;
  const adjacentNegativeCount = Math.max(
    1,
    maxNegatives - siblingNegativeCount - Math.max(1, Math.round(maxNegatives * 0.2)),
  );
  const unrelatedNegativeCount = Math.max(
    1,
    maxNegatives - siblingNegativeCount - adjacentNegativeCount,
  );

  return {
    explicitCount,
    implicitCount,
    contextualCount,
    siblingNegativeCount,
    adjacentNegativeCount,
    unrelatedNegativeCount,
  };
}

function normalizeEvalQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeEvalEntries(entries: EvalEntry[]): EvalEntry[] {
  const seen = new Set<string>();
  const deduped: EvalEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.should_trigger ? "p" : "n"}:${normalizeEvalQuery(entry.query)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function takeEntries(entries: EvalEntry[], count: number): EvalEntry[] {
  if (count <= 0) return [];
  return entries.slice(0, count);
}

export function selectBalancedEvalEntries(
  entries: EvalEntry[],
  maxPositives: number,
  maxNegatives: number,
  siblingSkills: string[] | boolean,
): EvalEntry[] {
  const normalizedSiblingSkills = Array.isArray(siblingSkills)
    ? siblingSkills.map((skill) => skill.trim().toLowerCase()).filter(Boolean)
    : [];
  const hasSiblingSkills = normalizedSiblingSkills.length > 0;
  const targets = buildPromptFamilyTargets(maxPositives, maxNegatives, hasSiblingSkills);
  const positives = entries.filter((entry) => entry.should_trigger);
  const negatives = entries.filter((entry) => !entry.should_trigger);

  const explicit = positives.filter((entry) => entry.invocation_type === "explicit");
  const implicit = positives.filter((entry) => entry.invocation_type === "implicit");
  const contextual = positives.filter((entry) => entry.invocation_type === "contextual");
  const remainingPositive = positives.filter(
    (entry) => !["explicit", "implicit", "contextual"].includes(entry.invocation_type ?? ""),
  );

  const selectedPositives = [
    ...takeEntries(explicit, targets.explicitCount),
    ...takeEntries(implicit, targets.implicitCount),
    ...takeEntries(contextual, targets.contextualCount),
  ];
  const selectedPositiveKeys = new Set(
    selectedPositives.map((entry) => normalizeEvalQuery(entry.query)),
  );
  for (const entry of [...positives, ...remainingPositive]) {
    if (selectedPositives.length >= maxPositives) break;
    const key = normalizeEvalQuery(entry.query);
    if (selectedPositiveKeys.has(key)) continue;
    selectedPositiveKeys.add(key);
    selectedPositives.push(entry);
  }

  const siblingMentions = hasSiblingSkills
    ? negatives.filter((entry) => {
        const normalizedQuery = entry.query.toLowerCase();
        return normalizedSiblingSkills.some((skill) => normalizedQuery.includes(skill));
      })
    : siblingSkills === true
      ? negatives.filter((entry) =>
          /(^|[\s/$-])(sc-[a-z0-9-]+|mentor cli|State Change mentor CLI|resource\s+\d+|mental model)/i.test(
            entry.query,
          ),
        )
      : [];
  const nonSiblingNegatives = negatives.filter((entry) => !siblingMentions.includes(entry));
  const selectedNegatives = [
    ...takeEntries(siblingMentions, targets.siblingNegativeCount),
    ...takeEntries(
      nonSiblingNegatives,
      maxNegatives - Math.min(targets.siblingNegativeCount, siblingMentions.length),
    ),
  ];

  const selectedNegativeKeys = new Set(
    selectedNegatives.map((entry) => normalizeEvalQuery(entry.query)),
  );
  for (const entry of negatives) {
    if (selectedNegatives.length >= maxNegatives) break;
    const key = normalizeEvalQuery(entry.query);
    if (selectedNegativeKeys.has(key)) continue;
    selectedNegativeKeys.add(key);
    selectedNegatives.push(entry);
  }

  return [...selectedPositives.slice(0, maxPositives), ...selectedNegatives.slice(0, maxNegatives)];
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function buildSyntheticPrompt(
  skillContent: string,
  skillName: string,
  maxPositives: number,
  maxNegatives: number,
  realExamples?: SyntheticPromptRealExamples,
  siblingSkills: string[] = [],
): { system: string; user: string } {
  const {
    explicitCount,
    implicitCount,
    contextualCount,
    siblingNegativeCount,
    adjacentNegativeCount,
    unrelatedNegativeCount,
  } = buildPromptFamilyTargets(maxPositives, maxNegatives, siblingSkills.length > 0);

  const system = `You are generating test queries for a coding agent skill. Given the skill description below, generate realistic user queries.

Your job is to create a SMALL, TARGETED benchmark for cold-start routing quality.

For POSITIVE queries (should trigger this skill):
- Generate a balanced mix of:
  - Explicit: directly names the skill or uses $${skillName} syntax
  - Implicit: describes the task without naming the skill
  - Contextual: realistic natural language with domain context, proper nouns, filenames, or setup noise
- Avoid merely paraphrasing bullet points from the skill
- Prefer realistic user phrasing over polished product copy
- Include at least a few prompts that test the edge of the skill's scope, not just the obvious center

For NEGATIVE queries (should NOT trigger this skill):
- Include hard negative controls:
  - sibling-skill confusion cases
  - topically adjacent but wrong-intent cases
  - clearly unrelated cases
- Make the hard negatives plausible, not cartoonishly unrelated
- If a query belongs to another installed skill, make that obvious from the task itself

Output as JSON array with no surrounding text:
[{"query": "...", "should_trigger": true, "invocation_type": "explicit|implicit|contextual|negative"}]`;

  let user = `Skill name: ${skillName}

Skill content:
${skillContent}

Generate exactly ${maxPositives} positive queries (should_trigger: true) and ${maxNegatives} negative queries (should_trigger: false).

Required positive mix:
- ${explicitCount} explicit
- ${implicitCount} implicit
- ${contextualCount} contextual

Required negative mix:
- ${siblingNegativeCount} sibling-skill confusion cases
- ${adjacentNegativeCount} adjacent but wrong-intent cases
- ${unrelatedNegativeCount} clearly unrelated cases

Return ONLY the JSON array.`;

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

  if (siblingSkills.length > 0) {
    user += `\n\nNearby installed skills to use for boundary-setting hard negatives:\n${siblingSkills
      .map((skill) => `- ${skill}`)
      .join(
        "\n",
      )}\n\nAt least ${siblingNegativeCount} negative queries should clearly belong to one of these sibling skills instead of ${skillName}.`;
  }

  return { system, user };
}

export function buildSyntheticRefinementPrompt(
  skillContent: string,
  skillName: string,
  candidates: EvalEntry[],
  maxPositives: number,
  maxNegatives: number,
  siblingSkills: string[] = [],
): { system: string; user: string } {
  const targets = buildPromptFamilyTargets(maxPositives, maxNegatives, siblingSkills.length > 0);
  const system = `You are refining a cold-start eval benchmark for a coding agent skill.

Your job is to critique and prune a candidate pool into a SMALL, SHARP benchmark.

For each candidate, reason using binary questions:
- Is this realistic user phrasing?
- Is this more than a trivial paraphrase of the skill bullets?
- Does this clearly test in-scope behavior, or clearly test a boundary?
- For negatives: does it clearly belong elsewhere or represent a plausible wrong-intent adjacent request?
- Is it sufficiently distinct from the other selected prompts?

Return ONLY a JSON array with the final benchmark.`;

  const user = `Skill name: ${skillName}

Skill content:
${skillContent}

Target final benchmark:
- ${maxPositives} positives
- ${maxNegatives} negatives
- Positive mix: ${targets.explicitCount} explicit, ${targets.implicitCount} implicit, ${targets.contextualCount} contextual
- Negative mix: ${targets.siblingNegativeCount} sibling-skill confusion, ${targets.adjacentNegativeCount} adjacent wrong-intent, ${targets.unrelatedNegativeCount} unrelated

${siblingSkills.length > 0 ? `Sibling skills for hard-negative boundaries:\n${siblingSkills.map((skill) => `- ${skill}`).join("\n")}\n` : ""}
Candidate pool:
${JSON.stringify(candidates, null, 2)}

Instructions:
- Remove duplicates and near-duplicates
- Prefer prompts that test trigger boundaries, not just center-of-mass obvious usage
- Keep sibling-skill negatives if they are strong boundary tests
- Keep the final set compact, diverse, and realistic
- Return ONLY the final JSON array`;

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
      source: "synthetic",
      created_at: new Date().toISOString(),
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
  const oversampleFactor = 2;

  const skillContent = readFileSync(skillPath, "utf-8");
  const siblingSkills = inferSiblingSkills(skillName);

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
    const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
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
    maxPositives * oversampleFactor,
    maxNegatives * oversampleFactor,
    realExamples,
    siblingSkills,
  );

  const raw = await callLlm(system, user, agent, options.modelFlag);
  const firstPass = dedupeEvalEntries(parseSyntheticResponse(raw, skillName));

  try {
    const refinement = buildSyntheticRefinementPrompt(
      skillContent,
      skillName,
      firstPass,
      maxPositives,
      maxNegatives,
      siblingSkills,
    );
    const refinedRaw = await callLlm(refinement.system, refinement.user, agent, options.modelFlag);
    const refined = dedupeEvalEntries(parseSyntheticResponse(refinedRaw, skillName));
    const selected = selectBalancedEvalEntries(refined, maxPositives, maxNegatives, siblingSkills);
    if (
      selected.filter((entry) => entry.should_trigger).length >= maxPositives &&
      selected.filter((entry) => !entry.should_trigger).length >= maxNegatives
    ) {
      return selected;
    }
  } catch {
    // fall through to first-pass selection
  }

  return selectBalancedEvalEntries(firstPass, maxPositives, maxNegatives, siblingSkills);
}
