/**
 * synthetic-evals.ts
 *
 * Generates eval queries from a SKILL.md using an LLM, without requiring
 * real session logs. Solves the cold-start problem for new skills that
 * have no telemetry data yet.
 */

import { readFileSync } from "node:fs";

import type { EvalEntry, InvocationType, QueryLogRecord, SkillUsageRecord } from "../types.js";
import { callLlm, stripMarkdownFences } from "../utils/llm-call.js";
import type { LlmCallObserver } from "../utils/llm-call.js";
import { extractActionableQueryText, extractPositiveEvalQueryText } from "../utils/query-filter.js";
import { findInstalledSkillNames } from "../utils/skill-discovery.js";
import { classifyInvocation } from "./invocation-classifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyntheticEvalOptions {
  maxPositives?: number;
  maxNegatives?: number;
  modelFlag?: string;
  llmObserverFactory?: (step: {
    current: number;
    total: number;
    phase: string;
    label: string;
  }) => LlmCallObserver | undefined;
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

const MAX_REAL_EXAMPLE_LENGTH = 220;
const MAX_SYNTHETIC_SKILL_CONTENT_CHARS = 6000;
const MAX_SYNTHETIC_SECTION_CHARS = 1200;
const MAX_SYNTHETIC_PREAMBLE_CHARS = 800;
const PRIORITY_SYNTHETIC_SECTION_PATTERNS = [
  /when this skill activates/i,
  /when to invoke/i,
  /when to use/i,
  /\buse when\b/i,
  /workflow routing/i,
  /\busage\b/i,
  /\bexamples?\b/i,
  /\bformat\b/i,
  /publish workflow/i,
  /input/i,
  /output/i,
  /activation/i,
] as const;

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

function truncatePromptExample(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length <= MAX_REAL_EXAMPLE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_REAL_EXAMPLE_LENGTH - 1).trimEnd()}…`;
}

function truncateSyntheticSection(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

export function summarizeSkillContentForSyntheticPrompt(skillContent: string): string {
  const trimmed = skillContent.trim();
  if (trimmed.length <= MAX_SYNTHETIC_SKILL_CONTENT_CHARS) return trimmed;

  const frontmatterMatch = trimmed.match(/^---\n[\s\S]*?\n---\n*/);
  const frontmatter = frontmatterMatch?.[0]?.trim() ?? "";
  const body = frontmatterMatch ? trimmed.slice(frontmatterMatch[0].length).trim() : trimmed;
  const sectionRegex = /^#{1,6}\s+.+$/gm;
  const headingMatches = [...body.matchAll(sectionRegex)];

  if (headingMatches.length === 0) {
    return truncateSyntheticSection(trimmed, MAX_SYNTHETIC_SKILL_CONTENT_CHARS);
  }

  const summaryParts: string[] = [];
  let usedLength = 0;
  const appendPart = (part: string): boolean => {
    const normalized = part.trim();
    if (!normalized) return false;
    const nextLength = usedLength + normalized.length + (summaryParts.length > 0 ? 2 : 0);
    if (nextLength > MAX_SYNTHETIC_SKILL_CONTENT_CHARS) return false;
    summaryParts.push(normalized);
    usedLength = nextLength;
    return true;
  };

  if (frontmatter) {
    appendPart(frontmatter);
  }

  const preamble = body.slice(0, headingMatches[0]?.index ?? 0).trim();
  if (preamble) {
    appendPart(truncateSyntheticSection(preamble, MAX_SYNTHETIC_PREAMBLE_CHARS));
  }

  const sections = headingMatches.map((match, index) => {
    const start = match.index ?? 0;
    const end = headingMatches[index + 1]?.index ?? body.length;
    const content = body.slice(start, end).trim();
    const heading = match[0].replace(/^#{1,6}\s+/, "").trim();
    return { heading, content, index };
  });

  const selectedIndices = new Set<number>();
  if (sections.length > 0) selectedIndices.add(0);
  for (const section of sections) {
    if (PRIORITY_SYNTHETIC_SECTION_PATTERNS.some((pattern) => pattern.test(section.heading))) {
      selectedIndices.add(section.index);
    }
  }

  for (const section of sections) {
    if (!selectedIndices.has(section.index)) continue;
    appendPart(truncateSyntheticSection(section.content, MAX_SYNTHETIC_SECTION_CHARS));
  }

  appendPart("[skill content summarized for synthetic eval generation]");
  return summaryParts.join("\n\n");
}

export function buildSyntheticPromptRealExamples(
  positiveCandidates: string[],
  negativeCandidates: string[],
  skillName: string,
  limit = 5,
): SyntheticPromptRealExamples | undefined {
  const cleanedPositives: string[] = [];
  const seenPositives = new Set<string>();
  for (const candidate of positiveCandidates) {
    const cleaned = extractPositiveEvalQueryText(candidate, skillName);
    if (!cleaned) continue;
    const normalized = normalizeEvalQuery(cleaned);
    if (seenPositives.has(normalized)) continue;
    seenPositives.add(normalized);
    cleanedPositives.push(truncatePromptExample(cleaned));
    if (cleanedPositives.length >= limit) break;
  }

  if (cleanedPositives.length === 0) return undefined;

  const positiveSet = new Set(cleanedPositives.map((query) => normalizeEvalQuery(query)));
  const cleanedNegatives: string[] = [];
  const seenNegatives = new Set<string>();
  for (const candidate of negativeCandidates) {
    const cleaned = extractActionableQueryText(candidate);
    if (!cleaned) continue;
    const truncated = truncatePromptExample(cleaned);
    const normalized = normalizeEvalQuery(truncated);
    if (positiveSet.has(normalized) || seenNegatives.has(normalized)) continue;
    seenNegatives.add(normalized);
    cleanedNegatives.push(truncated);
    if (cleanedNegatives.length >= limit) break;
  }

  return { positive: cleanedPositives, negative: cleanedNegatives };
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
  const summarizedSkillContent = summarizeSkillContentForSyntheticPrompt(skillContent);
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
${summarizedSkillContent}

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
  const summarizedSkillContent = summarizeSkillContentForSyntheticPrompt(skillContent);
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
${summarizedSkillContent}

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
    const positiveCandidates = skillRecords
      .filter((r) => isHighConfidencePositiveSkillRecord(r, skillName))
      .map((r) => r.query)
      .filter((q): q is string => typeof q === "string" && q.length > 0);

    // Negatives: from all_queries, excluding cleaned positives later.
    const allQueries = queryQueryLog(db) as QueryLogRecord[];
    const negativeCandidates = allQueries
      .map((r) => r.query)
      .filter((q): q is string => typeof q === "string" && q.length > 0);

    realExamples = buildSyntheticPromptRealExamples(
      positiveCandidates,
      negativeCandidates,
      skillName,
    );
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

  const raw = await callLlm(
    system,
    user,
    agent,
    options.modelFlag,
    undefined,
    options.llmObserverFactory?.({
      current: 2,
      total: 4,
      phase: "draft_eval_set",
      label: "Draft synthetic eval set",
    }),
  );
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
    const refinedRaw = await callLlm(
      refinement.system,
      refinement.user,
      agent,
      options.modelFlag,
      undefined,
      options.llmObserverFactory?.({
        current: 3,
        total: 4,
        phase: "refine_eval_set",
        label: "Refine synthetic eval set",
      }),
    );
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
