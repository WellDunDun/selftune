/**
 * bounded-mutations.ts
 *
 * Bounded mutation primitives for package search. Generates routing and body
 * variants of a skill file that a package search runner can evaluate.
 *
 * Each mutation produces a complete, self-contained SKILL.md variant written
 * to a temporary directory. The caller (package evaluator) is responsible for
 * cleanup via `cleanupVariants()`.
 *
 * Mutations are deterministic permutations — no LLM calls. This keeps variant
 * generation fast and predictable. LLM-driven evolution remains in
 * propose-body.ts / propose-routing.ts for the existing evolution pipeline.
 *
 * Phase 2 adds eval-informed targeted mutations that use measured weaknesses
 * from replay failures and grading results to focus mutations on the specific
 * patterns that failed.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { parseSkillSections, replaceSection } from "./deploy-proposal.js";
import { generateBodyProposal } from "./propose-body.js";
import { generateRoutingProposal } from "./propose-routing.js";
import type { EffortLevel } from "../utils/llm-call.js";
import type { FailurePattern } from "../types.js";

// ---------------------------------------------------------------------------
// Types (local — do NOT add to shared types.ts)
// ---------------------------------------------------------------------------

export interface BoundedMutationOptions {
  maxVariants?: number; // default 3
  mutationSurface: "routing" | "body" | "both";
  parentSkillPath: string;
  agent?: string;
}

export interface BoundedMutationResult {
  variantSkillPath: string; // path to temporary variant
  mutationSurface: "routing" | "body";
  mutationDescription: string; // what changed
  parentFingerprint: string;
}

/** Weaknesses extracted from frontier candidate evaluation data. */
export interface MutationWeaknesses {
  /** Queries that failed during replay (should have triggered but didn't). */
  replayFailureSamples: string[];
  /** Queries that were routed incorrectly. */
  routingFailureSamples: string[];
  /** Body quality score from evaluation (0.0-1.0, higher is better). */
  bodyQualityScore: number;
  /** Change in grading pass rate relative to previous candidate. */
  gradingPassRateDelta: number;
  /** Textual descriptions of grading failure patterns. */
  gradingFailurePatterns?: string[];
}

export interface ReflectiveMutationOptions {
  maxVariants?: number;
  skillName: string;
  agent: string;
  modelFlag?: string;
  effort?: EffortLevel;
}

interface ReflectiveMutationDeps {
  generateBodyProposal?: typeof generateBodyProposal;
  generateRoutingProposal?: typeof generateRoutingProposal;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/** Compute a short content fingerprint of the parent skill file. */
function fingerprintContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

/** Create a temp directory for a variant and return the SKILL.md path within. */
function createVariantDir(parentPath: string, index: number): string {
  const stem = basename(dirname(parentPath)) || "skill";
  const dir = join(tmpdir(), `selftune-variant-${stem}-${Date.now()}-${index}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "SKILL.md");
}

function buildFailurePatternsFromWeaknesses(
  skillName: string,
  weaknesses: MutationWeaknesses,
): FailurePattern[] {
  const now = new Date().toISOString();
  const patterns: FailurePattern[] = [];
  const replayFailures = [
    ...new Set(weaknesses.replayFailureSamples.map((sample) => sample.trim())),
  ]
    .filter(Boolean)
    .slice(0, 8);
  const routingFailures = [
    ...new Set(weaknesses.routingFailureSamples.map((sample) => sample.trim())),
  ]
    .filter(Boolean)
    .slice(0, 8);

  if (replayFailures.length > 0) {
    patterns.push({
      pattern_id: `reflective-${skillName}-replay`,
      skill_name: skillName,
      invocation_type: "explicit",
      missed_queries: replayFailures,
      frequency: replayFailures.length,
      sample_sessions: [],
      extracted_at: now,
    });
  }

  if (routingFailures.length > 0) {
    patterns.push({
      pattern_id: `reflective-${skillName}-routing`,
      skill_name: skillName,
      invocation_type: "contextual",
      missed_queries: routingFailures,
      frequency: routingFailures.length,
      sample_sessions: [],
      extracted_at: now,
    });
  }

  if ((weaknesses.gradingFailurePatterns?.length ?? 0) > 0) {
    const missedQueries =
      replayFailures.length > 0
        ? replayFailures
        : routingFailures.length > 0
          ? routingFailures
          : weaknesses.gradingFailurePatterns!.slice(0, 3);
    patterns.push({
      pattern_id: `reflective-${skillName}-grading`,
      skill_name: skillName,
      invocation_type: "implicit",
      missed_queries: missedQueries,
      frequency: weaknesses.gradingFailurePatterns!.length,
      sample_sessions: [],
      extracted_at: now,
      feedback: weaknesses.gradingFailurePatterns!.slice(0, 5).map((pattern, index) => ({
        query: missedQueries[index] ?? `quality-review-${index + 1}`,
        failure_reason: pattern,
        improvement_hint: pattern,
        invocation_type: "implicit",
      })),
    });
  }

  return patterns;
}

function rebuildSkillWithBody(
  parsed: ReturnType<typeof parseSkillSections>,
  proposedBody: string,
): string {
  const parts: string[] = [];
  if (parsed.frontmatter) {
    parts.push(parsed.frontmatter.trimEnd(), "");
  }
  parts.push(parsed.title, "", proposedBody.trim(), "");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Routing mutation strategies
// ---------------------------------------------------------------------------

/**
 * Deterministic routing table mutations. Each strategy modifies the routing
 * table in a different way to explore the search space:
 *
 * 1. Synonym expansion — adds synonym triggers for existing rows
 * 2. Granularity split — splits broad triggers into more specific ones
 * 3. Coverage broadening — adds catch-all/fuzzy trigger rows
 */

interface RoutingRow {
  trigger: string;
  workflow: string;
}

/** Parse a markdown routing table into rows. */
function parseRoutingTable(tableContent: string): RoutingRow[] {
  const lines = tableContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"));

  if (lines.length < 3) return []; // header + separator + at least 1 row

  // Skip header (line 0) and separator (line 1)
  return lines.slice(2).map((line) => {
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    return {
      trigger: cells[0] || "",
      workflow: cells[1] || "",
    };
  });
}

/** Render routing rows back to a markdown table. */
function renderRoutingTable(rows: RoutingRow[]): string {
  const lines = [
    "| Trigger | Workflow |",
    "| --- | --- |",
    ...rows.map((r) => `| ${r.trigger} | ${r.workflow} |`),
  ];
  return lines.join("\n");
}

/** Strategy 1: Add synonym triggers for each existing row. */
function synonymExpansion(rows: RoutingRow[]) {
  const synonymMap = new Map([
    ["create", ["add", "new", "make"]],
    ["list", ["show", "display", "view"]],
    ["update", ["edit", "modify", "change"]],
    ["delete", ["remove", "drop", "destroy"]],
    ["get", ["fetch", "retrieve", "read"]],
    ["search", ["find", "lookup", "query"]],
    ["run", ["execute", "start", "launch"]],
    ["stop", ["halt", "end", "terminate"]],
    ["deploy", ["publish", "release", "ship"]],
    ["test", ["verify", "check", "validate"]],
  ]);

  const expanded: RoutingRow[] = [...rows];
  const addedTriggers: string[] = [];

  for (const row of rows) {
    const words = row.trigger.toLowerCase().split(/\s+/);
    for (const word of words) {
      const synonyms = synonymMap.get(word);
      if (synonyms) {
        // Pick the first synonym not already present
        const existing = expanded.map((r) => r.trigger.toLowerCase());
        for (const syn of synonyms) {
          const newTrigger = row.trigger.replace(new RegExp(`\\b${word}\\b`, "i"), syn);
          if (!existing.includes(newTrigger.toLowerCase())) {
            expanded.push({ trigger: newTrigger, workflow: row.workflow });
            addedTriggers.push(newTrigger);
            break;
          }
        }
      }
    }
  }

  return {
    rows: expanded,
    description:
      addedTriggers.length > 0
        ? `Synonym expansion: added triggers [${addedTriggers.join(", ")}]`
        : "Synonym expansion: no new synonyms found",
  };
}

/** Strategy 2: Split triggers into more specific forms. */
function granularitySplit(rows: RoutingRow[]) {
  const result: RoutingRow[] = [];
  const splits: string[] = [];

  for (const row of rows) {
    result.push(row);
    // For each row, add a more specific variant with a qualifier
    const qualifiers = ["by name", "by id", "all", "recent"];
    const qualifier = qualifiers[result.length % qualifiers.length];
    const specificTrigger = `${row.trigger} ${qualifier}`;
    result.push({ trigger: specificTrigger, workflow: row.workflow });
    splits.push(specificTrigger);
  }

  return {
    rows: result,
    description: `Granularity split: added specific triggers [${splits.join(", ")}]`,
  };
}

/** Strategy 3: Add broader catch-all patterns. */
function coverageBroadening(rows: RoutingRow[]) {
  const workflowGroups = new Map<string, string[]>();
  for (const row of rows) {
    const triggers = workflowGroups.get(row.workflow) || [];
    triggers.push(row.trigger);
    workflowGroups.set(row.workflow, triggers);
  }

  const broadened: RoutingRow[] = [...rows];
  const added: string[] = [];

  for (const [workflow, triggers] of workflowGroups) {
    // Extract the common verb/noun pattern and add a help/info variant
    const words = triggers.flatMap((t) => t.split(/\s+/));
    const nouns = words.filter(
      (w) =>
        !["create", "list", "update", "delete", "get", "set", "run", "stop"].includes(
          w.toLowerCase(),
        ),
    );
    if (nouns.length > 0) {
      const noun = nouns[0];
      const helpTrigger = `help with ${noun}`;
      if (!broadened.some((r) => r.trigger.toLowerCase() === helpTrigger.toLowerCase())) {
        broadened.push({ trigger: helpTrigger, workflow });
        added.push(helpTrigger);
      }
    }
  }

  return {
    rows: broadened,
    description:
      added.length > 0
        ? `Coverage broadening: added catch-all triggers [${added.join(", ")}]`
        : "Coverage broadening: no new patterns added",
  };
}

const ROUTING_STRATEGIES = [synonymExpansion, granularitySplit, coverageBroadening];

// ---------------------------------------------------------------------------
// Body mutation strategies
// ---------------------------------------------------------------------------

/**
 * Deterministic body mutations. Each strategy modifies the skill body
 * in a different way:
 *
 * 1. Instruction emphasis — reorders and highlights key instructions
 * 2. Example enrichment — adds generated example phrases
 * 3. Description expansion — expands the description paragraph
 */

/** Strategy 1: Reorder instructions to emphasize different aspects. */
function instructionEmphasis(parsed: ReturnType<typeof parseSkillSections>, _fullContent: string) {
  const newSections = { ...parsed.sections };
  const instructions = newSections["Instructions"] || "";

  if (instructions) {
    // Reverse the numbered list order to emphasize different steps
    const lines = instructions.split("\n");
    const numbered = lines.filter((l) => /^\d+\./.test(l.trim()));
    const nonNumbered = lines.filter((l) => !/^\d+\./.test(l.trim()));

    if (numbered.length > 1) {
      const reversed = numbered.toReversed().map((line, i) => {
        return line.replace(/^\d+\./, `${i + 1}.`);
      });
      newSections["Instructions"] = [...nonNumbered, ...reversed].join("\n").trim();
    }
  }

  return {
    sections: newSections,
    description: "Instruction emphasis: reordered instruction steps",
    desc: `${parsed.description}\n\nThis skill prioritizes the final steps of its workflow.`,
  };
}

/** Strategy 2: Enrich examples section. */
function exampleEnrichment(parsed: ReturnType<typeof parseSkillSections>, _fullContent: string) {
  const newSections = { ...parsed.sections };
  const examples = newSections["Examples"] || "";

  // Generate additional example patterns from existing triggers
  const routing = newSections["Workflow Routing"] || "";
  const rows = parseRoutingTable(routing);
  const newExamples = rows.map((r) => `- "I need to ${r.trigger}"`);

  newSections["Examples"] = examples
    ? `${examples}\n${newExamples.join("\n")}`
    : newExamples.join("\n");

  return {
    sections: newSections,
    description: "Example enrichment: added example phrases from routing triggers",
    desc: parsed.description,
  };
}

/** Strategy 3: Expand the description paragraph. */
function descriptionExpansion(parsed: ReturnType<typeof parseSkillSections>, _fullContent: string) {
  const routing = parsed.sections["Workflow Routing"] || "";
  const rows = parseRoutingTable(routing);
  const capabilities = rows.map((r) => r.trigger).join(", ");

  const expandedDesc = capabilities
    ? `${parsed.description} Capabilities include: ${capabilities}.`
    : `${parsed.description} This skill provides comprehensive workflow automation.`;

  return {
    sections: { ...parsed.sections },
    description: "Description expansion: added capability summary from routing table",
    desc: expandedDesc,
  };
}

const BODY_STRATEGIES = [instructionEmphasis, exampleEnrichment, descriptionExpansion];

// ---------------------------------------------------------------------------
// Reassembly
// ---------------------------------------------------------------------------

/** Reassemble a SKILL.md from parsed sections. */
function reassembleSkill(
  parsed: ReturnType<typeof parseSkillSections>,
  sectionOverrides?: Record<string, string>,
  descriptionOverride?: string,
): string {
  const parts: string[] = [];

  if (parsed.frontmatter) {
    parts.push(parsed.frontmatter);
    parts.push("");
  }
  if (parsed.title) {
    parts.push(parsed.title);
    parts.push("");
  }

  parts.push(descriptionOverride ?? parsed.description);
  parts.push("");

  const sections = sectionOverrides ?? parsed.sections;
  for (const [name, content] of Object.entries(sections)) {
    parts.push(`## ${name}`);
    parts.push("");
    parts.push(content);
    parts.push("");
  }

  return parts.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate N routing variants of a skill. Each variant has a modified
 * Workflow Routing table while preserving all other content.
 */
export async function generateRoutingMutations(
  skillPath: string,
  options?: BoundedMutationOptions,
): Promise<BoundedMutationResult[]> {
  if (!existsSync(skillPath)) {
    throw new Error(`Skill file not found: ${skillPath}`);
  }

  const maxVariants = options?.maxVariants ?? 3;
  const content = readFileSync(skillPath, "utf-8");
  const fingerprint = fingerprintContent(content);
  const parsed = parseSkillSections(content);
  const currentRouting = parsed.sections["Workflow Routing"] || "";
  const currentRows = parseRoutingTable(currentRouting);

  if (currentRows.length === 0) {
    throw new Error(`No routing table found in ${skillPath}`);
  }

  const results: BoundedMutationResult[] = [];

  for (let i = 0; i < maxVariants; i++) {
    const strategy = ROUTING_STRATEGIES[i % ROUTING_STRATEGIES.length];
    const { rows: mutatedRows, description } = strategy(currentRows);
    const newTable = renderRoutingTable(mutatedRows);

    // Replace only the routing section, keep everything else
    const variantContent = replaceSection(content, "Workflow Routing", newTable);
    const variantPath = createVariantDir(skillPath, i);

    writeFileSync(variantPath, variantContent, "utf-8");

    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "routing",
      mutationDescription: description,
      parentFingerprint: fingerprint,
    });
  }

  return results;
}

/**
 * Generate N body variants of a skill. Each variant has modified
 * body content (instructions, examples, description) while preserving
 * the overall SKILL.md structure.
 */
export async function generateBodyMutations(
  skillPath: string,
  options?: BoundedMutationOptions,
): Promise<BoundedMutationResult[]> {
  if (!existsSync(skillPath)) {
    throw new Error(`Skill file not found: ${skillPath}`);
  }

  const maxVariants = options?.maxVariants ?? 3;
  const content = readFileSync(skillPath, "utf-8");
  const fingerprint = fingerprintContent(content);
  const parsed = parseSkillSections(content);

  const results: BoundedMutationResult[] = [];

  for (let i = 0; i < maxVariants; i++) {
    const strategy = BODY_STRATEGIES[i % BODY_STRATEGIES.length];
    const { sections, description, desc } = strategy(parsed, content);

    const variantContent = reassembleSkill(parsed, sections, desc);
    const variantPath = createVariantDir(skillPath, i);

    writeFileSync(variantPath, variantContent, "utf-8");

    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "body",
      mutationDescription: description,
      parentFingerprint: fingerprint,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Reflective routing/body mutations (measured evidence -> LLM proposal)
// ---------------------------------------------------------------------------

export async function generateReflectiveRoutingMutations(
  skillPath: string,
  weaknesses: MutationWeaknesses,
  options: ReflectiveMutationOptions,
  deps: ReflectiveMutationDeps = {},
): Promise<BoundedMutationResult[]> {
  if (!existsSync(skillPath) || !options.agent) {
    return [];
  }

  const allFailures = [...weaknesses.replayFailureSamples, ...weaknesses.routingFailureSamples]
    .map((sample) => sample.trim())
    .filter(Boolean);
  if (allFailures.length === 0) {
    return [];
  }

  const content = readFileSync(skillPath, "utf-8");
  const parsed = parseSkillSections(content);
  const currentRouting = parsed.sections["Workflow Routing"] ?? "";
  if (!currentRouting.trim()) {
    return [];
  }

  const proposal = await (deps.generateRoutingProposal ?? generateRoutingProposal)(
    currentRouting,
    content,
    buildFailurePatternsFromWeaknesses(options.skillName, weaknesses),
    [...new Set(allFailures)],
    options.skillName,
    skillPath,
    options.agent,
    options.modelFlag,
    options.effort,
  );

  const variantContent = replaceSection(content, "Workflow Routing", proposal.proposed_body.trim());
  const variantPath = createVariantDir(skillPath, 0);
  writeFileSync(variantPath, variantContent, "utf-8");

  const variant: BoundedMutationResult = {
    variantSkillPath: variantPath,
    mutationSurface: "routing",
    mutationDescription: `Reflective: ${proposal.rationale}`,
    parentFingerprint: fingerprintContent(content),
  };
  return [variant].slice(0, options.maxVariants ?? 1);
}

export async function generateReflectiveBodyMutations(
  skillPath: string,
  weaknesses: MutationWeaknesses,
  options: ReflectiveMutationOptions,
  deps: ReflectiveMutationDeps = {},
): Promise<BoundedMutationResult[]> {
  if (!existsSync(skillPath) || !options.agent) {
    return [];
  }

  const hasBodyWeakness = weaknesses.bodyQualityScore < 0.8;
  const hasGradingDecline = weaknesses.gradingPassRateDelta < -0.05;
  const hasFailurePatterns = (weaknesses.gradingFailurePatterns?.length ?? 0) > 0;
  if (!hasBodyWeakness && !hasGradingDecline && !hasFailurePatterns) {
    return [];
  }

  const content = readFileSync(skillPath, "utf-8");
  const parsed = parseSkillSections(content);
  const proposal = await (deps.generateBodyProposal ?? generateBodyProposal)(
    content,
    buildFailurePatternsFromWeaknesses(options.skillName, weaknesses),
    [...new Set([...weaknesses.replayFailureSamples, ...weaknesses.routingFailureSamples])],
    options.skillName,
    skillPath,
    options.agent,
    options.modelFlag,
    undefined,
    undefined,
    options.effort,
  );

  const variantPath = createVariantDir(skillPath, 0);
  writeFileSync(variantPath, rebuildSkillWithBody(parsed, proposal.proposed_body), "utf-8");

  const variant: BoundedMutationResult = {
    variantSkillPath: variantPath,
    mutationSurface: "body",
    mutationDescription: `Reflective: ${proposal.rationale}`,
    parentFingerprint: fingerprintContent(content),
  };
  return [variant].slice(0, options.maxVariants ?? 1);
}

// ---------------------------------------------------------------------------
// Targeted routing mutations (eval-informed)
// ---------------------------------------------------------------------------

/** Extract keywords from a list of queries. */
function extractKeywords(queries: string[]): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "to",
    "for",
    "of",
    "in",
    "on",
    "at",
    "is",
    "it",
    "my",
    "me",
    "i",
    "do",
    "can",
    "you",
    "how",
    "what",
    "this",
    "that",
    "with",
    "and",
    "or",
    "but",
  ]);
  const words = new Map<string, number>();
  for (const q of queries) {
    for (const w of q.toLowerCase().split(/\s+/)) {
      const clean = w.replace(/[^a-z0-9-]/g, "");
      if (clean.length > 1 && !stopWords.has(clean)) {
        words.set(clean, (words.get(clean) ?? 0) + 1);
      }
    }
  }
  return [...words.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
}

/** Remove duplicate routing rows by trigger text. */
function deduplicateRows(rows: RoutingRow[]): RoutingRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.trigger.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Generate routing mutations targeted at specific weaknesses identified
 * through replay failures and missed queries.
 *
 * Unlike deterministic mutations, these use the actual failure data to
 * focus the mutation on patterns that failed.
 */
export function generateTargetedRoutingMutations(
  skillPath: string,
  weaknesses: MutationWeaknesses,
  options?: { maxVariants?: number },
): BoundedMutationResult[] {
  const allFailures = [...weaknesses.replayFailureSamples, ...weaknesses.routingFailureSamples];

  // No weaknesses to target -- nothing to do
  if (allFailures.length === 0) {
    return [];
  }

  const content = readFileSync(skillPath, "utf-8");
  const fingerprint = fingerprintContent(content);
  const parsed = parseSkillSections(content);
  const routing = parsed.sections["Workflow Routing"] ?? "";
  const rows = parseRoutingTable(routing);
  const maxVariants = options?.maxVariants ?? 3;
  const results: BoundedMutationResult[] = [];

  // Extract keywords from failure samples
  const keywords = extractKeywords(allFailures);

  // Strategy 1: Add failure-derived routing rows
  if (results.length < maxVariants && allFailures.length > 0) {
    const defaultWorkflow = rows.length > 0 ? rows[0].workflow : "Default";
    const failureRows = allFailures.map((q) => ({
      trigger: q.toLowerCase().trim(),
      workflow: defaultWorkflow,
    }));
    const allRows = deduplicateRows([...rows, ...failureRows]);
    const newTable = renderRoutingTable(allRows);
    const variantContent = replaceSection(content, "Workflow Routing", newTable);
    const variantPath = createVariantDir(skillPath, results.length);
    writeFileSync(variantPath, variantContent, "utf-8");
    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "routing",
      mutationDescription: "Targeted: added failure-derived routing rows",
      parentFingerprint: fingerprint,
    });
  }

  // Strategy 2: Add keyword-expanded routing rows
  if (results.length < maxVariants && keywords.length > 0) {
    const defaultWorkflow = rows.length > 0 ? rows[0].workflow : "Default";
    const existingVerbs = rows.map((r) => r.trigger.split(/\s+/)[0]).filter(Boolean);
    const verbs = existingVerbs.length > 0 ? existingVerbs : ["manage"];
    const keywordRows = keywords.slice(0, 5).flatMap((kw) =>
      verbs.slice(0, 2).map((verb) => ({
        trigger: `${verb} ${kw}`,
        workflow: defaultWorkflow,
      })),
    );
    const allRows = deduplicateRows([...rows, ...keywordRows]);
    const newTable = renderRoutingTable(allRows);
    const variantContent = replaceSection(content, "Workflow Routing", newTable);
    const variantPath = createVariantDir(skillPath, results.length);
    writeFileSync(variantPath, variantContent, "utf-8");
    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "routing",
      mutationDescription: "Targeted: added keyword-expanded routing rows",
      parentFingerprint: fingerprint,
    });
  }

  // Strategy 3: Merge failure samples into description for broader matching
  if (results.length < maxVariants && keywords.length > 0) {
    const keywordNote = `Also handles: ${keywords.join(", ")}.`;
    const newDescription = parsed.description
      ? `${parsed.description}\n\n${keywordNote}`
      : keywordNote;
    const variantContent = reassembleSkill(parsed, undefined, newDescription);
    const variantPath = createVariantDir(skillPath, results.length);
    writeFileSync(variantPath, variantContent, "utf-8");
    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "routing",
      mutationDescription: "Targeted: augmented description with failure keywords",
      parentFingerprint: fingerprint,
    });
  }

  return results.slice(0, maxVariants);
}

// ---------------------------------------------------------------------------
// Targeted body mutations (eval-informed)
// ---------------------------------------------------------------------------

/**
 * Generate body mutations targeted at specific weaknesses identified
 * through grading failures and body quality feedback.
 *
 * Only produces mutations when body quality is below threshold or
 * grading pass rate has declined.
 */
export function generateTargetedBodyMutations(
  skillPath: string,
  weaknesses: MutationWeaknesses,
  options?: { maxVariants?: number },
): BoundedMutationResult[] {
  const hasBodyWeakness = weaknesses.bodyQualityScore < 0.8;
  const hasGradingDecline = weaknesses.gradingPassRateDelta < -0.05;
  const hasFailurePatterns = (weaknesses.gradingFailurePatterns?.length ?? 0) > 0;

  if (!hasBodyWeakness && !hasGradingDecline && !hasFailurePatterns) {
    return [];
  }

  const content = readFileSync(skillPath, "utf-8");
  const fingerprint = fingerprintContent(content);
  const parsed = parseSkillSections(content);
  const maxVariants = options?.maxVariants ?? 3;
  const results: BoundedMutationResult[] = [];

  // Strategy 1: Strengthen instructions based on failure patterns
  if (results.length < maxVariants && (hasGradingDecline || hasFailurePatterns)) {
    const instructions = parsed.sections["Instructions"] ?? "";
    const failureContext =
      weaknesses.gradingFailurePatterns?.join("; ") ?? "execution quality declined";
    const strengthened = instructions
      ? `${instructions}\n\n**Important:** Pay special attention to: ${failureContext}. Ensure all steps are followed precisely.`
      : `Follow these steps carefully. ${failureContext}. Ensure all steps are followed precisely.`;
    const variantContent = reassembleSkill(parsed, {
      ...parsed.sections,
      Instructions: strengthened,
    });
    const variantPath = createVariantDir(skillPath, results.length);
    writeFileSync(variantPath, variantContent, "utf-8");
    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "body",
      mutationDescription: "Targeted: strengthened instructions from failure patterns",
      parentFingerprint: fingerprint,
    });
  }

  // Strategy 2: Expand examples from failure patterns
  if (results.length < maxVariants && hasFailurePatterns) {
    const examples = parsed.sections["Examples"] ?? "";
    const failureExamples = (weaknesses.gradingFailurePatterns ?? [])
      .map((pattern) => `- Address: "${pattern}"`)
      .join("\n");
    const expanded = examples
      ? `${examples}\n\n### Failure-informed examples\n\n${failureExamples}`
      : `### Failure-informed examples\n\n${failureExamples}`;
    const variantContent = reassembleSkill(parsed, { ...parsed.sections, Examples: expanded });
    const variantPath = createVariantDir(skillPath, results.length);
    writeFileSync(variantPath, variantContent, "utf-8");
    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "body",
      mutationDescription: "Targeted: expanded examples from failure patterns",
      parentFingerprint: fingerprint,
    });
  }

  // Strategy 3: Add quality guard section
  if (results.length < maxVariants && hasBodyWeakness) {
    const qualityGuard = `Before completing, verify:\n- All required steps were followed\n- Output matches expected format\n- No errors were silently ignored`;
    const variantContent = reassembleSkill(parsed, {
      ...parsed.sections,
      "Quality Checklist": qualityGuard,
    });
    const variantPath = createVariantDir(skillPath, results.length);
    writeFileSync(variantPath, variantContent, "utf-8");
    results.push({
      variantSkillPath: variantPath,
      mutationSurface: "body",
      mutationDescription: "Targeted: added quality guard checklist",
      parentFingerprint: fingerprint,
    });
  }

  return results.slice(0, maxVariants);
}

// ---------------------------------------------------------------------------
// Weakness extraction
// ---------------------------------------------------------------------------

const decodeValidation = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      per_entry_results: Schema.optionalKey(Schema.Array(Schema.Json)),
    }),
  ),
);
const decodeReplayEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    query: Schema.String,
    should_trigger: Schema.Boolean,
    triggered: Schema.optionalKey(Schema.Boolean),
    passed: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeSavedArray = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Json)));
const decodeExpectation = Schema.decodeUnknownOption(
  Schema.Struct({
    passed: Schema.Boolean,
    text: Schema.optionalKey(Schema.Json),
    name: Schema.optionalKey(Schema.Json),
    description: Schema.optionalKey(Schema.Json),
  }),
);
const decodeFeedback = Schema.decodeUnknownOption(
  Schema.Struct({
    improvement_hint: Schema.optionalKey(Schema.Json),
    failure_reason: Schema.optionalKey(Schema.Json),
    query: Schema.optionalKey(Schema.Json),
  }),
);
const decodeGradeRate = Schema.decodeUnknownOption(Schema.Number);

/**
 * Extract mutation weaknesses from the local database for a given skill.
 *
 * Reads the most recent evolution evidence and grading results to identify:
 * - Replay failure samples (queries that should have triggered but didn't)
 * - Routing failure samples (queries that routed incorrectly)
 * - Body quality score (from grading summaries)
 * - Grading pass rate delta (trend direction)
 */
export function extractMutationWeaknesses(skillName: string, db: Database): MutationWeaknesses {
  const replayFailureSamples: string[] = [];
  const routingFailureSamples: string[] = [];
  let bodyQualityScore = 1.0;
  let gradingPassRateDelta = 0;
  const gradingFailurePatterns: string[] = [];

  // --- Extract replay/routing failures from evolution evidence ---
  try {
    const evidenceRows = db
      .query<{ validation_json: string }, [string]>(
        `SELECT validation_json FROM evolution_evidence
         WHERE skill_name = ? AND validation_json IS NOT NULL
         ORDER BY timestamp DESC LIMIT 5`,
      )
      .all(skillName);

    for (const row of evidenceRows) {
      try {
        const validation = decodeValidation(row.validation_json);
        for (const savedEntry of validation.per_entry_results ?? []) {
          const decoded = decodeReplayEntry(savedEntry);
          if (Option.isNone(decoded)) continue;
          const entry = decoded.value;
          if (entry.should_trigger && !entry.triggered && entry.query) {
            if (!replayFailureSamples.includes(entry.query)) {
              replayFailureSamples.push(entry.query);
            }
          }
          if (entry.should_trigger && entry.triggered && !entry.passed && entry.query) {
            if (!routingFailureSamples.includes(entry.query)) {
              routingFailureSamples.push(entry.query);
            }
          }
        }
      } catch {
        // Skip malformed validation JSON
      }
    }
  } catch {
    // Table may not exist yet
  }

  // --- Extract grading pass rate trend ---
  try {
    const gradingRows = db
      .query<
        {
          pass_rate: number | null;
          expectations_json: string | null;
          failure_feedback_json: string | null;
          graded_at: string;
        },
        [string]
      >(
        `SELECT pass_rate, expectations_json, failure_feedback_json, graded_at FROM grading_results
         WHERE skill_name = ?
         ORDER BY graded_at DESC LIMIT 10`,
      )
      .all(skillName);

    if (gradingRows.length >= 2) {
      const recentRate = Option.getOrElse(decodeGradeRate(gradingRows[0].pass_rate), () => 1.0);
      const previousRate = Option.getOrElse(decodeGradeRate(gradingRows[1].pass_rate), () => 1.0);
      gradingPassRateDelta = recentRate - previousRate;
      bodyQualityScore = recentRate;
    } else if (gradingRows.length === 1) {
      bodyQualityScore = Option.getOrElse(decodeGradeRate(gradingRows[0].pass_rate), () => 1.0);
    }

    // Extract failure patterns from failed expectations and failure feedback.
    for (const row of gradingRows) {
      try {
        const expectations = row.expectations_json ? decodeSavedArray(row.expectations_json) : [];
        for (const savedExpectation of expectations) {
          const decoded = decodeExpectation(savedExpectation);
          if (Option.isNone(decoded)) continue;
          const exp = decoded.value;
          if (exp.passed === false) {
            const pattern = exp.text ?? exp.name ?? exp.description;
            if (
              Schema.is(Schema.String)(pattern) &&
              pattern.length > 0 &&
              !gradingFailurePatterns.includes(pattern)
            ) {
              gradingFailurePatterns.push(pattern);
            }
          }
        }
      } catch {
        // Skip malformed expectations JSON
      }

      try {
        const feedback = row.failure_feedback_json
          ? decodeSavedArray(row.failure_feedback_json)
          : [];
        for (const savedFeedback of feedback) {
          const decoded = decodeFeedback(savedFeedback);
          if (Option.isNone(decoded)) continue;
          const item = decoded.value;
          const pattern = item.improvement_hint ?? item.failure_reason ?? item.query;
          if (
            Schema.is(Schema.String)(pattern) &&
            pattern.length > 0 &&
            !gradingFailurePatterns.includes(pattern)
          ) {
            gradingFailurePatterns.push(pattern);
          }
        }
      } catch {
        // Skip malformed failure feedback JSON
      }
    }
  } catch {
    // Table may not exist yet
  }

  return {
    replayFailureSamples,
    routingFailureSamples,
    bodyQualityScore,
    gradingPassRateDelta,
    gradingFailurePatterns: gradingFailurePatterns.length > 0 ? gradingFailurePatterns : undefined,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up temporary variant files. Call this after evaluation is complete.
 */
export function cleanupVariants(results: BoundedMutationResult[]): void {
  for (const r of results) {
    try {
      const dir = dirname(r.variantSkillPath);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
