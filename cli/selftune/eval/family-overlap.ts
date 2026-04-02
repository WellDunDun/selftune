#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { getDb } from "../localdb/db.js";
import { queryQueryLog, querySkillUsageRecords } from "../localdb/queries.js";
import type {
  SkillFamilyColdStartPair,
  SkillFamilyColdStartSuspicion,
  QueryLogRecord,
  SkillFamilyOverlapMember,
  SkillFamilyOverlapPair,
  SkillFamilyOverlapReport,
  SkillFamilyRefactorProposal,
  SkillUsageRecord,
} from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import {
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "../utils/skill-discovery.js";
import {
  buildStopwordSet,
  extractWhenToUseLines,
  jaccardSimilarity,
  tokenizeText,
} from "../utils/text-similarity.js";
import { buildEvalSet } from "./hooks-to-evals.js";

const DEFAULT_MIN_OVERLAP = 0.3;
const DEFAULT_MIN_SHARED = 2;
const DEFAULT_MAX_SHARED = 10;
const DESCRIPTION_SIMILARITY_THRESHOLD = 0.18;
const WHEN_TO_USE_SIMILARITY_THRESHOLD = 0.18;
const CONFUSION_QUERY_LINE_OVERLAP_THRESHOLD = 0.12;
const COMMAND_AUGMENTED_HIGH_SIMILARITY_THRESHOLD = 0.22;
const LOW_SUSPICION_SIMILARITY_THRESHOLD = 0.28;
const SHARED_TERM_LIMIT = 6;
const STATIC_PAIR_LIMIT = 10;

const STOPWORDS = buildStopwordSet([
  "between",
  "by",
  "can",
  "change",
  "content",
  "decision",
  "decisions",
  "do",
  "get",
  "help",
  "i",
  "if",
  "my",
  "state",
  "their",
  "users",
  "want",
  "wants",
  "you",
  "your",
]);

interface FamilyOverlapOptions {
  familyPrefix?: string;
  parentSkillName?: string;
  minOverlapPct?: number;
  minSharedQueries?: number;
  maxSharedQueries?: number;
  searchDirs?: string[];
}

interface InstalledSkillSurface {
  skillName: string;
  skillPath?: string;
  descriptionTokens: Set<string>;
  whenToUseTokens: Set<string>;
  whenToUseLines: string[];
  commandSurfaces: string[];
}

function getEvalSkillSearchDirs(): string[] {
  const cwd = process.cwd();
  const homeDir = process.env.HOME ?? "";
  const codexHome = process.env.CODEX_HOME ?? `${homeDir}/.codex`;
  return [
    ...findRepositorySkillDirs(cwd),
    ...findRepositoryClaudeSkillDirs(cwd),
    `${homeDir}/.agents/skills`,
    `${homeDir}/.claude/skills`,
    `${codexHome}/skills`,
  ];
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function inferFamilyPrefix(skills: string[]): string | undefined {
  if (skills.length < 2) return undefined;
  const firstPrefixes = skills.map((skill) => {
    const hyphen = skill.indexOf("-");
    return hyphen === -1 ? skill : skill.slice(0, hyphen + 1);
  });
  const candidate = firstPrefixes[0];
  return firstPrefixes.every((prefix) => prefix === candidate) ? candidate : undefined;
}

function inferParentSkillName(
  skills: string[],
  explicitParent?: string,
  familyPrefix?: string,
): string {
  if (explicitParent?.trim()) return explicitParent.trim();
  const inferredPrefix = familyPrefix ?? inferFamilyPrefix(skills) ?? "family";
  return inferredPrefix.endsWith("-") ? inferredPrefix.slice(0, -1) : inferredPrefix;
}

function toWorkflowName(skillName: string, familyPrefix?: string): string {
  const stripped =
    familyPrefix && skillName.startsWith(familyPrefix)
      ? skillName.slice(familyPrefix.length)
      : skillName;
  return stripped.trim() || "default";
}

function buildPositiveQuerySet(
  skillName: string,
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
): Set<string> {
  const evalEntries = buildEvalSet(
    skillRecords,
    queryRecords,
    skillName,
    Number.MAX_SAFE_INTEGER,
    false,
    42,
    false,
  );
  return new Set(
    evalEntries
      .filter((entry) => entry.should_trigger)
      .map((entry) => normalizeQuery(entry.query))
      .filter(Boolean),
  );
}

function buildMember(
  skillName: string,
  positiveQueries: Set<string>,
  searchDirs: string[],
): SkillFamilyOverlapMember {
  return {
    skill_name: skillName,
    skill_path: findInstalledSkillPath(skillName, searchDirs),
    positive_query_count: positiveQueries.size,
  };
}

function scoreConsolidationPressure(overlapPct: number): "low" | "medium" | "high" {
  if (overlapPct >= 0.6) return "high";
  if (overlapPct >= 0.4) return "medium";
  return "low";
}

function sharedTerms(
  leftDescription: Set<string>,
  leftWhenToUse: Set<string>,
  rightDescription: Set<string>,
  rightWhenToUse: Set<string>,
): string[] {
  const shared = new Set<string>();
  for (const token of leftDescription) {
    if (rightDescription.has(token) || rightWhenToUse.has(token)) shared.add(token);
  }
  for (const token of leftWhenToUse) {
    if (rightDescription.has(token) || rightWhenToUse.has(token)) shared.add(token);
  }
  return [...shared].sort((a, b) => a.localeCompare(b)).slice(0, SHARED_TERM_LIMIT);
}

function buildSyntheticSiblingConfusionQueries(
  left: InstalledSkillSurface,
  right: InstalledSkillSurface,
  sharedCommandSurfaces: string[],
): string[] {
  const leftSurfaceTokens = new Set([...left.descriptionTokens, ...left.whenToUseTokens]);
  const rightSurfaceTokens = new Set([...right.descriptionTokens, ...right.whenToUseTokens]);
  const candidates = new Set<string>();

  const maybeAdd = (line: string, sourceTokens: Set<string>, compareTokens: Set<string>) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const lineTokens = tokenizeText(trimmed, STOPWORDS);
    const overlap = jaccardSimilarity(lineTokens, compareTokens);
    if (
      overlap >= CONFUSION_QUERY_LINE_OVERLAP_THRESHOLD ||
      jaccardSimilarity(sourceTokens, compareTokens) >= WHEN_TO_USE_SIMILARITY_THRESHOLD
    ) {
      candidates.add(trimmed);
    }
  };

  for (const line of left.whenToUseLines) {
    maybeAdd(line, leftSurfaceTokens, rightSurfaceTokens);
  }
  for (const line of right.whenToUseLines) {
    maybeAdd(line, rightSurfaceTokens, leftSurfaceTokens);
  }
  for (const command of sharedCommandSurfaces) {
    candidates.add(`${command} for a sibling-family request`);
  }

  return [...candidates].slice(0, 4);
}

function extractCommandSurfaces(body: string): string[] {
  const matches = body.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g);
  const commands = new Set<string>();
  for (const match of matches) {
    const block = match[1] ?? "";
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens.length < 2 || tokens[1]?.startsWith("-")) continue;
      commands.add(`${tokens[0]} ${tokens[1]}`);
    }
  }
  return [...commands].sort((a, b) => a.localeCompare(b));
}

function loadInstalledSkillSurface(skillName: string, searchDirs: string[]): InstalledSkillSurface {
  const skillPath = findInstalledSkillPath(skillName, searchDirs);
  if (!skillPath) {
    return {
      skillName,
      descriptionTokens: new Set<string>(),
      whenToUseTokens: new Set<string>(),
      whenToUseLines: [],
      commandSurfaces: [],
    };
  }

  try {
    const raw = readFileSync(skillPath, "utf8");
    const parsed = parseFrontmatter(raw);
    const whenToUseLines = extractWhenToUseLines(parsed.body);
    return {
      skillName,
      skillPath,
      descriptionTokens: tokenizeText(parsed.description, STOPWORDS),
      whenToUseTokens: tokenizeText(whenToUseLines.join(" "), STOPWORDS),
      whenToUseLines,
      commandSurfaces: extractCommandSurfaces(parsed.body),
    };
  } catch {
    return {
      skillName,
      skillPath,
      descriptionTokens: new Set<string>(),
      whenToUseTokens: new Set<string>(),
      whenToUseLines: [],
      commandSurfaces: [],
    };
  }
}

function scoreStaticSuspicion(
  descriptionSimilarity: number,
  whenToUseSimilarity: number,
  sharedCommandSurfaces: string[],
): "low" | "medium" | "high" | null {
  const descriptionSignal = descriptionSimilarity >= DESCRIPTION_SIMILARITY_THRESHOLD;
  const whenToUseSignal = whenToUseSimilarity >= WHEN_TO_USE_SIMILARITY_THRESHOLD;
  const commandSignal = sharedCommandSurfaces.length > 0;
  const signalCount = Number(descriptionSignal) + Number(whenToUseSignal) + Number(commandSignal);

  if (
    signalCount >= 3 ||
    (commandSignal &&
      Math.max(descriptionSimilarity, whenToUseSimilarity) >=
        COMMAND_AUGMENTED_HIGH_SIMILARITY_THRESHOLD)
  ) {
    return "high";
  }
  if (signalCount >= 2) return "medium";
  if (Math.max(descriptionSimilarity, whenToUseSimilarity) >= LOW_SUSPICION_SIMILARITY_THRESHOLD) {
    return "low";
  }
  return null;
}

function analyzeColdStartSuspicion(
  skills: string[],
  searchDirs: string[],
  readySkillCount: number,
): SkillFamilyColdStartSuspicion | undefined {
  const surfaces = skills.map((skillName) => loadInstalledSkillSurface(skillName, searchDirs));
  const availableSurfaces = surfaces.filter(
    (surface) =>
      Boolean(surface.skillPath) &&
      (surface.descriptionTokens.size > 0 ||
        surface.whenToUseTokens.size > 0 ||
        surface.commandSurfaces.length > 0),
  );
  if (availableSurfaces.length < 2) return undefined;

  const pairs: SkillFamilyColdStartPair[] = [];
  let analyzedPairs = 0;
  for (let i = 0; i < availableSurfaces.length; i++) {
    for (let j = i + 1; j < availableSurfaces.length; j++) {
      analyzedPairs += 1;
      const left = availableSurfaces[i];
      const right = availableSurfaces[j];
      if (!left || !right) continue;
      const descriptionSimilarity = jaccardSimilarity(
        left.descriptionTokens,
        right.descriptionTokens,
      );
      const whenToUseSimilarity = jaccardSimilarity(left.whenToUseTokens, right.whenToUseTokens);
      const sharedCommandSurfaces = left.commandSurfaces.filter((command) =>
        right.commandSurfaces.includes(command),
      );
      const suspicionLevel = scoreStaticSuspicion(
        descriptionSimilarity,
        whenToUseSimilarity,
        sharedCommandSurfaces,
      );
      if (!suspicionLevel) continue;

      pairs.push({
        skill_a: left.skillName,
        skill_b: right.skillName,
        description_similarity: descriptionSimilarity,
        when_to_use_similarity: whenToUseSimilarity,
        shared_command_surfaces: sharedCommandSurfaces,
        shared_terms: sharedTerms(
          left.descriptionTokens,
          left.whenToUseTokens,
          right.descriptionTokens,
          right.whenToUseTokens,
        ),
        synthetic_confusion_queries: buildSyntheticSiblingConfusionQueries(
          left,
          right,
          sharedCommandSurfaces,
        ),
        suspicion_level: suspicionLevel,
      });
    }
  }

  pairs.sort(
    (a, b) =>
      Number(b.suspicion_level === "high") - Number(a.suspicion_level === "high") ||
      Number(b.suspicion_level === "medium") - Number(a.suspicion_level === "medium") ||
      b.when_to_use_similarity - a.when_to_use_similarity ||
      b.description_similarity - a.description_similarity,
  );

  const suspiciousPairCount = pairs.length;
  const averageStaticSimilarity =
    suspiciousPairCount > 0
      ? pairs.reduce(
          // Command overlap is binary, but we weight it equally with the two Jaccard scores
          // because shared command surfaces are a high-precision cold-start signal even when
          // description text is sparse or noisy.
          (sum, pair) =>
            sum +
            (pair.description_similarity +
              pair.when_to_use_similarity +
              (pair.shared_command_surfaces.length > 0 ? 1 : 0)) /
              3,
          0,
        ) / suspiciousPairCount
      : 0;
  const candidate =
    suspiciousPairCount > 0 &&
    readySkillCount < 2 &&
    suspiciousPairCount >= (skills.length >= 3 ? 2 : 1);

  const rationale: string[] = [];
  if (suspiciousPairCount === 0) {
    rationale.push(
      "Installed skill surfaces do not show meaningful overlap yet. Keep gathering cold-start evals and real usage before making a packaging call.",
    );
  } else {
    rationale.push(
      `${suspiciousPairCount} sibling pair${suspiciousPairCount === 1 ? "" : "s"} show overlapping installed skill surfaces before trusted telemetry is available.`,
    );
    if (pairs.some((pair) => pair.shared_command_surfaces.length > 0)) {
      rationale.push(
        "Shared command surfaces suggest some siblings may be thin wrappers around the same backend or query path.",
      );
    }
    if (pairs.some((pair) => pair.when_to_use_similarity >= WHEN_TO_USE_SIMILARITY_THRESHOLD)) {
      rationale.push(
        "Overlapping `When to Use` language suggests sibling boundaries may already be competing on intent before enough telemetry exists to confirm it.",
      );
    }
    if (pairs.some((pair) => pair.synthetic_confusion_queries.length > 0)) {
      rationale.push(
        "Synthetic sibling-confusion probes are available for suspicious pairs, so you can test the family boundary before real telemetry converges.",
      );
    }
    if (candidate) {
      rationale.push(
        "Treat this as architecture suspicion, not proof. Run cold-start evals and gather trusted usage before consolidating the family.",
      );
    }
  }

  return {
    candidate,
    analyzed_pairs: analyzedPairs,
    suspicious_pair_count: suspiciousPairCount,
    average_static_similarity: averageStaticSimilarity,
    pairs: pairs.slice(0, STATIC_PAIR_LIMIT),
    rationale,
  };
}

function buildRefactorProposal(
  skills: string[],
  familyPrefix: string | undefined,
  parentSkillName: string,
): SkillFamilyRefactorProposal {
  const workflows = skills.map((skillName) => {
    const workflowName = toWorkflowName(skillName, familyPrefix);
    return {
      workflow_name: workflowName,
      source_skill: skillName,
      suggested_path: `Workflows/${workflowName}.md`,
    };
  });

  return {
    parent_skill_name: parentSkillName,
    family_prefix: familyPrefix,
    internal_workflows: workflows,
    compatibility_aliases: workflows.map((workflow) => ({
      skill_name: workflow.source_skill,
      target_workflow: workflow.workflow_name,
    })),
    migration_notes: [
      `Create a parent skill \`${parentSkillName}\` whose SKILL.md routes into internal workflows instead of exposing each family member as a primary top-level trigger surface.`,
      "Keep the existing sibling skills as thin compatibility aliases for at least one release cycle while usage shifts to the parent skill.",
      "Move execution-specific instructions into internal Workflows/ or references/ files so the parent SKILL.md stays focused on routing and progressive disclosure.",
      "Use the compatibility aliases to measure whether trigger quality improves before removing the old skill entry points.",
    ],
  };
}

export function analyzeSkillFamilyOverlap(
  skills: string[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  options: FamilyOverlapOptions = {},
): SkillFamilyOverlapReport {
  if (skills.length < 2) {
    throw new CLIError(
      "Skill family overlap analysis requires at least 2 skills.",
      "INVALID_FLAG",
      "selftune eval family-overlap --skills skill-a,skill-b",
    );
  }

  const searchDirs = options.searchDirs ?? getEvalSkillSearchDirs();
  const familyPrefix = options.familyPrefix ?? inferFamilyPrefix(skills);
  const minOverlapPct = options.minOverlapPct ?? DEFAULT_MIN_OVERLAP;
  const minSharedQueries = options.minSharedQueries ?? DEFAULT_MIN_SHARED;
  const maxSharedQueries = options.maxSharedQueries ?? DEFAULT_MAX_SHARED;

  const positiveQueriesBySkill = new Map<string, Set<string>>();
  const members: SkillFamilyOverlapMember[] = [];
  for (const skillName of skills) {
    const positives = buildPositiveQuerySet(skillName, skillRecords, queryRecords);
    positiveQueriesBySkill.set(skillName, positives);
    members.push(buildMember(skillName, positives, searchDirs));
  }

  const pairs: SkillFamilyOverlapPair[] = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const skillA = skills[i];
      const skillB = skills[j];
      const positivesA = positiveQueriesBySkill.get(skillA) ?? new Set<string>();
      const positivesB = positiveQueriesBySkill.get(skillB) ?? new Set<string>();
      if (positivesA.size === 0 || positivesB.size === 0) continue;

      const sharedQueries = [...positivesA].filter((query) => positivesB.has(query));
      const overlapPct = sharedQueries.length / Math.min(positivesA.size, positivesB.size);
      if (sharedQueries.length < minSharedQueries || overlapPct < minOverlapPct) continue;

      pairs.push({
        skill_a: skillA,
        skill_b: skillB,
        overlap_pct: overlapPct,
        shared_query_count: sharedQueries.length,
        shared_queries: sharedQueries.slice(0, maxSharedQueries),
        consolidation_pressure: scoreConsolidationPressure(overlapPct),
      });
    }
  }

  pairs.sort(
    (a, b) => b.overlap_pct - a.overlap_pct || b.shared_query_count - a.shared_query_count,
  );

  const totalPairsAnalyzed = (skills.length * (skills.length - 1)) / 2;
  const overlapCount = pairs.length;
  const overlapDensity = totalPairsAnalyzed > 0 ? overlapCount / totalPairsAnalyzed : 0;
  const averageOverlapPct =
    overlapCount > 0 ? pairs.reduce((sum, pair) => sum + pair.overlap_pct, 0) / overlapCount : 0;
  const readySkillCount = members.filter(
    (member) => member.positive_query_count >= minSharedQueries,
  ).length;
  const coldStartSuspicion = analyzeColdStartSuspicion(skills, searchDirs, readySkillCount);
  const consolidationCandidate =
    readySkillCount >= 2 &&
    skills.length >= 3 &&
    (overlapCount >= 2 || (overlapCount >= 1 && overlapDensity >= 0.5));

  const parentSkillName = inferParentSkillName(skills, options.parentSkillName, familyPrefix);
  const rationale = [
    `${skills.length} sibling skills analyzed with ${totalPairsAnalyzed} pairwise boundary checks.`,
    overlapCount === 0
      ? "No exact-query overlap crossed the current consolidation threshold."
      : `${overlapCount} skill pairs share at least ${Math.round(minOverlapPct * 100)}% of their trusted positive queries.`,
  ];

  if (pairs.some((pair) => pair.consolidation_pressure === "high")) {
    rationale.push(
      "High-overlap pairs suggest the current top-level routing surfaces are competing for the same real user intent.",
    );
  }

  if (readySkillCount < 2) {
    rationale.push(
      `Only ${readySkillCount} sibling skills currently have enough trusted positives to make a packaging call. Generate cold-start evals and gather real usage before treating this as evidence against consolidation.`,
    );
  }

  if (readySkillCount < 2 && coldStartSuspicion?.candidate) {
    rationale.push(
      "Installed skill surfaces already suggest an architecture suspicion: some siblings look like overlapping entry points to the same underlying workflow family.",
    );
  }

  if (consolidationCandidate) {
    rationale.push(
      "This family looks like a packaging problem, not just a wording problem. Test a parent skill with internal workflows before continuing standalone description optimization.",
    );
  }

  return {
    family_prefix: familyPrefix,
    analyzed_skills: skills,
    members,
    pairs,
    cold_start_suspicion: coldStartSuspicion,
    total_pairs_analyzed: totalPairsAnalyzed,
    overlap_count: overlapCount,
    overlap_density: overlapDensity,
    average_overlap_pct: averageOverlapPct,
    consolidation_candidate: consolidationCandidate,
    recommendation:
      readySkillCount < 2
        ? coldStartSuspicion?.candidate
          ? "Trusted telemetry is still sparse, but installed skill surfaces suggest this family may want a parent skill. Treat this as cold-start architecture suspicion, then confirm with cold-start evals plus real usage."
          : "Insufficient trusted telemetry to make a family-packaging call yet. Use cold-start evals plus a few days of real usage before deciding whether to consolidate."
        : consolidationCandidate
          ? `Consider consolidating this family under a parent skill like \`${parentSkillName}\`.`
          : "Keep the skills separate for now and continue improving boundaries at the description/workflow level.",
    rationale,
    refactor_proposal: consolidationCandidate
      ? buildRefactorProposal(skills, familyPrefix, parentSkillName)
      : undefined,
    generated_at: new Date().toISOString(),
  };
}

function parseSkillList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveFamilySkills(
  explicitSkills: string[],
  familyPrefix: string | undefined,
  skillRecords: SkillUsageRecord[],
  searchDirs: string[],
): string[] {
  if (explicitSkills.length > 0)
    return [...new Set(explicitSkills)].sort((a, b) => a.localeCompare(b));

  if (!familyPrefix) {
    throw new CLIError(
      "Pass either --skills <a,b,c> or --prefix <family->.",
      "MISSING_FLAG",
      "selftune eval family-overlap --prefix sc-",
    );
  }

  const installedNames = findInstalledSkillNames(searchDirs);
  const observedNames = new Set<string>(
    skillRecords.map((record) => record.skill_name).filter(Boolean),
  );
  const familySkills = new Set<string>();
  for (const name of [...installedNames, ...observedNames]) {
    if (name.startsWith(familyPrefix)) familySkills.add(name);
  }

  return [...familySkills].sort((a, b) => a.localeCompare(b));
}

export async function cliMain(): Promise<void> {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h", default: false },
        prefix: { type: "string" },
        skills: { type: "string" },
        "parent-skill": { type: "string" },
        "min-overlap": { type: "string" },
        "min-shared": { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CLIError(
      `Invalid arguments: ${message}`,
      "INVALID_FLAG",
      "selftune eval family-overlap --help",
    );
  }

  if (values.help) {
    console.log(`Usage:
  selftune eval family-overlap --skills skill-a,skill-b[,skill-c]
  selftune eval family-overlap --prefix sc-

Options:
  --skills <a,b,c>       Explicit skill names
  --prefix <family->     Analyze installed or observed skills with this prefix
  --parent-skill <name>  Override the inferred parent skill name
  --min-overlap <0-1>    Minimum overlap percentage (default: 0.3)
  --min-shared <n>       Minimum shared queries (default: 2)
  -h, --help             Show this help
`);
    return;
  }

  const rawMinOverlap = values["min-overlap"] as string | undefined;
  const rawMinShared = values["min-shared"] as string | undefined;
  const minOverlapPct =
    rawMinOverlap === undefined ? DEFAULT_MIN_OVERLAP : Number.parseFloat(rawMinOverlap);
  const minSharedQueries =
    rawMinShared === undefined ? DEFAULT_MIN_SHARED : Number.parseInt(rawMinShared, 10);

  if (!Number.isFinite(minOverlapPct) || minOverlapPct <= 0 || minOverlapPct > 1) {
    throw new CLIError(
      "Invalid --min-overlap value. Use a number between 0 and 1.",
      "INVALID_FLAG",
      "selftune eval family-overlap --prefix sc- --min-overlap 0.3",
    );
  }

  if (!Number.isFinite(minSharedQueries) || minSharedQueries < 1) {
    throw new CLIError(
      "Invalid --min-shared value. Use a positive integer.",
      "INVALID_FLAG",
      "selftune eval family-overlap --prefix sc- --min-shared 2",
    );
  }

  const searchDirs = getEvalSkillSearchDirs();
  const db = getDb();
  const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
  const queryRecords = queryQueryLog(db) as QueryLogRecord[];
  const familyPrefix = (values.prefix as string | undefined)?.trim() || undefined;
  const explicitSkills = parseSkillList(values.skills as string | undefined);
  const skills = resolveFamilySkills(explicitSkills, familyPrefix, skillRecords, searchDirs);

  if (skills.length < 2) {
    throw new CLIError(
      `Need at least 2 skills to analyze, found ${skills.length}.`,
      "INVALID_FLAG",
      "selftune eval family-overlap --prefix sc-",
    );
  }

  const report = analyzeSkillFamilyOverlap(skills, skillRecords, queryRecords, {
    familyPrefix,
    parentSkillName: (values["parent-skill"] as string | undefined)?.trim() || undefined,
    minOverlapPct,
    minSharedQueries,
    searchDirs,
  });
  console.log(JSON.stringify(report, null, 2));
}
