#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { getDb } from "../localdb/db.js";
import { queryQueryLog, querySkillUsageRecords } from "../localdb/queries.js";
import type {
  QueryLogRecord,
  SkillFamilyOverlapMember,
  SkillFamilyOverlapPair,
  SkillFamilyOverlapReport,
  SkillFamilyRefactorProposal,
  SkillUsageRecord,
} from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import {
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "../utils/skill-discovery.js";
import { buildEvalSet } from "./hooks-to-evals.js";

const DEFAULT_MIN_OVERLAP = 0.3;
const DEFAULT_MIN_SHARED = 2;
const DEFAULT_MAX_SHARED = 10;

interface FamilyOverlapOptions {
  familyPrefix?: string;
  parentSkillName?: string;
  minOverlapPct?: number;
  minSharedQueries?: number;
  maxSharedQueries?: number;
  searchDirs?: string[];
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
    total_pairs_analyzed: totalPairsAnalyzed,
    overlap_count: overlapCount,
    overlap_density: overlapDensity,
    average_overlap_pct: averageOverlapPct,
    consolidation_candidate: consolidationCandidate,
    recommendation:
      readySkillCount < 2
        ? "Insufficient trusted telemetry to make a family-packaging call yet. Use cold-start evals plus a few days of real usage before deciding whether to consolidate."
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
