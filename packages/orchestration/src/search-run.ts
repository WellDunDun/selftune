import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "@selftune/runtime/command-surface";
import {
  readPackageCandidateArtifact,
  selectAcceptedPackageFrontierCandidate,
} from "@selftune/runtime/create/package-candidate-state";
import type { CreatePackageEvaluationResult } from "@selftune/runtime/create/package-evaluator";
import { resolveCreateSkillPath } from "@selftune/runtime/create/readiness";
import { computeCreatePackageFingerprint } from "@selftune/runtime/create/package-fingerprint";
import { runPackageSearch } from "@selftune/runtime/create/package-search";
import {
  type BoundedMutationResult,
  cleanupVariants,
  extractMutationWeaknesses,
  generateBodyMutations,
  generateReflectiveBodyMutations,
  generateReflectiveRoutingMutations,
  generateRoutingMutations,
  generateTargetedBodyMutations,
  generateTargetedRoutingMutations,
} from "@selftune/runtime/evolution/bounded-mutations";
import { getDb } from "@selftune/local-store";
import {
  readCanonicalPackageEvaluationArtifact,
  writeCanonicalPackageEvaluation,
  writeCanonicalPackageEvaluationArtifact,
} from "@selftune/runtime/testing-readiness";
import type {
  CreatePackageEvaluationSummary,
  PackageSearchRunResult,
} from "@selftune/runtime/types";
import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";

const SEARCH_SURFACES = ["routing", "body", "both"] as const;
type SearchSurface = (typeof SEARCH_SURFACES)[number];

export interface SearchRunVariant {
  skill_path: string;
  mutation_surface: "routing" | "body";
  mutation_description: string;
  fingerprint: string;
}

interface SearchSurfacePlan {
  routing_count: number;
  body_count: number;
  weakness_source: "accepted_frontier" | "canonical_package_evaluation" | "default_even_split";
  routing_weakness: number | null;
  body_weakness: number | null;
}

export interface SearchRunVariantGenerationDeps {
  extractMutationWeaknesses?: typeof extractMutationWeaknesses;
  generateReflectiveRoutingMutations?: typeof generateReflectiveRoutingMutations;
  generateReflectiveBodyMutations?: typeof generateReflectiveBodyMutations;
  generateRoutingMutations?: typeof generateRoutingMutations;
  generateBodyMutations?: typeof generateBodyMutations;
  generateTargetedRoutingMutations?: typeof generateTargetedRoutingMutations;
  generateTargetedBodyMutations?: typeof generateTargetedBodyMutations;
  computeCreatePackageFingerprint?: typeof computeCreatePackageFingerprint;
}

export interface GeneratedSearchRunVariants {
  generated_variants: SearchRunVariant[];
  cleanup_variants: BoundedMutationResult[];
}

export interface ApplySearchRunWinnerResult {
  applied_winner: boolean;
  applied_candidate_id: string | null;
  next_command: string | null;
  package_evaluation: CreatePackageEvaluationSummary | null;
}

export interface ApplySearchRunWinnerDeps {
  readPackageCandidateArtifact?: typeof readPackageCandidateArtifact;
  readSkillContent?: (skillPath: string) => string;
  writeSkillContent?: (skillPath: string, content: string) => void;
  writeCanonicalPackageEvaluation?: typeof writeCanonicalPackageEvaluation;
  writeCanonicalPackageEvaluationArtifact?: typeof writeCanonicalPackageEvaluationArtifact;
}

interface SearchRunPayload extends PackageSearchRunResult, ApplySearchRunWinnerResult {
  generated_variants: SearchRunVariant[];
  improved: boolean;
  surface_plan: SearchSurfacePlan;
}

function inferSkillName(skillPath: string): string {
  return basename(resolveCreateSkillPath(skillPath).skill_dir);
}

function readSurface(rawSurface: string | undefined): SearchSurface {
  const surface = SEARCH_SURFACES.find((surface) => surface === (rawSurface ?? "both"));
  if (surface === undefined) {
    throw new CLIError(
      `Invalid --surface value: ${rawSurface}`,
      "INVALID_FLAG",
      "Use one of: routing, body, both",
    );
  }
  return surface;
}

function readMaxCandidates(rawMax: string | undefined): number {
  if (rawMax == null) return 5;
  if (!/^[1-9]\d*$/.test(rawMax)) {
    throw new CLIError(
      "Invalid --max-candidates value. Use a positive integer.",
      "INVALID_FLAG",
      "selftune search-run --skill-path <path> --max-candidates 5",
    );
  }
  return Number(rawMax);
}

function computeRoutingWeakness(summary: CreatePackageEvaluationSummary): number {
  const routingPassRate = summary.routing?.pass_rate ?? summary.replay.pass_rate;
  return Math.min(1, Math.max(0, 1 - routingPassRate));
}

export function computeBodyWeakness(summary: CreatePackageEvaluationSummary): number {
  if (!summary.body) return 0.5;
  if (!summary.body.valid) return 1;
  if (summary.body.quality_score == null) return 0.5;
  return Math.min(1, Math.max(0, 1 - summary.body.quality_score));
}

function readMeasuredSurfaceWeakness(
  skillName: string,
  db: Database,
): Omit<SearchSurfacePlan, "routing_count" | "body_count"> {
  const frontierParent = selectAcceptedPackageFrontierCandidate(skillName, { db });
  if (frontierParent) {
    return {
      weakness_source: "accepted_frontier",
      routing_weakness: computeRoutingWeakness(frontierParent.summary),
      body_weakness: computeBodyWeakness(frontierParent.summary),
    };
  }

  const canonicalEvaluation = readCanonicalPackageEvaluationArtifact(skillName)?.summary ?? null;
  if (canonicalEvaluation) {
    return {
      weakness_source: "canonical_package_evaluation",
      routing_weakness: computeRoutingWeakness(canonicalEvaluation),
      body_weakness: computeBodyWeakness(canonicalEvaluation),
    };
  }

  return {
    weakness_source: "default_even_split",
    routing_weakness: null,
    body_weakness: null,
  };
}

export function planVariantCounts(
  surface: SearchSurface,
  maxCandidates: number,
  weakness: {
    weakness_source: SearchSurfacePlan["weakness_source"];
    routing_weakness: number | null;
    body_weakness: number | null;
  } = {
    weakness_source: "default_even_split",
    routing_weakness: null,
    body_weakness: null,
  },
): SearchSurfacePlan {
  if (surface === "routing") {
    return {
      routing_count: maxCandidates,
      body_count: 0,
      ...weakness,
    };
  }
  if (surface === "body") {
    return {
      routing_count: 0,
      body_count: maxCandidates,
      ...weakness,
    };
  }

  const routingWeakness = weakness.routing_weakness;
  const bodyWeakness = weakness.body_weakness;
  if (routingWeakness == null || bodyWeakness == null || maxCandidates <= 1) {
    return {
      routing_count: Math.ceil(maxCandidates / 2),
      body_count: Math.floor(maxCandidates / 2),
      ...weakness,
    };
  }

  const totalWeakness = routingWeakness + bodyWeakness;
  if (totalWeakness <= Number.EPSILON) {
    return {
      routing_count: Math.ceil(maxCandidates / 2),
      body_count: Math.floor(maxCandidates / 2),
      ...weakness,
    };
  }

  const baseCount = maxCandidates >= 2 ? 1 : 0;
  const remaining = Math.max(0, maxCandidates - baseCount * 2);
  const routingExtra = Math.round((remaining * routingWeakness) / totalWeakness);
  const routingCount = baseCount + routingExtra;
  return {
    routing_count: routingCount,
    body_count: maxCandidates - routingCount,
    ...weakness,
  };
}

function selectUniqueVariants(
  variants: readonly BoundedMutationResult[],
  count: number,
  seenFingerprints: Set<string>,
  deps: SearchRunVariantGenerationDeps,
): SearchRunVariant[] {
  const selected: SearchRunVariant[] = [];
  const computeFingerprint =
    deps.computeCreatePackageFingerprint ?? computeCreatePackageFingerprint;

  for (const variant of variants) {
    if (selected.length >= count) {
      break;
    }

    const fingerprint = computeFingerprint(variant.variantSkillPath);
    if (!fingerprint) {
      throw new CLIError(
        `Failed to fingerprint ${variant.mutationSurface} variant at ${variant.variantSkillPath}`,
        "OPERATION_FAILED",
      );
    }
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenFingerprints.add(fingerprint);
    selected.push({
      skill_path: variant.variantSkillPath,
      mutation_surface: variant.mutationSurface,
      mutation_description: variant.mutationDescription,
      fingerprint,
    });
  }

  return selected;
}

async function generateSurfaceVariants(
  skillPath: string,
  skillName: string,
  targetCount: number,
  surface: "routing" | "body",
  agent: string | undefined,
  db: Database,
  seenFingerprints: Set<string>,
  deps: SearchRunVariantGenerationDeps,
): Promise<GeneratedSearchRunVariants> {
  if (targetCount <= 0) {
    return {
      generated_variants: [],
      cleanup_variants: [],
    };
  }

  const extractWeaknesses = deps.extractMutationWeaknesses ?? extractMutationWeaknesses;
  const weaknesses = extractWeaknesses(skillName, db);
  const cleanupResults: BoundedMutationResult[] = [];

  try {
    if (agent) {
      const reflectiveVariants = await (async () => {
        try {
          return surface === "routing"
            ? await (deps.generateReflectiveRoutingMutations ?? generateReflectiveRoutingMutations)(
                skillPath,
                weaknesses,
                {
                  maxVariants: 1,
                  skillName,
                  agent,
                },
              )
            : await (deps.generateReflectiveBodyMutations ?? generateReflectiveBodyMutations)(
                skillPath,
                weaknesses,
                {
                  maxVariants: 1,
                  skillName,
                  agent,
                },
              );
        } catch {
          return [];
        }
      })();
      cleanupResults.push(...reflectiveVariants);

      const reflectiveSelections = selectUniqueVariants(
        reflectiveVariants,
        targetCount,
        seenFingerprints,
        deps,
      );
      if (reflectiveSelections.length >= targetCount) {
        return {
          generated_variants: reflectiveSelections,
          cleanup_variants: cleanupResults,
        };
      }

      const remainingAfterReflective = targetCount - reflectiveSelections.length;
      const targetedVariants =
        surface === "routing"
          ? (deps.generateTargetedRoutingMutations ?? generateTargetedRoutingMutations)(
              skillPath,
              weaknesses,
              {
                maxVariants: remainingAfterReflective,
              },
            )
          : (deps.generateTargetedBodyMutations ?? generateTargetedBodyMutations)(
              skillPath,
              weaknesses,
              {
                maxVariants: remainingAfterReflective,
              },
            );
      cleanupResults.push(...targetedVariants);

      reflectiveSelections.push(
        ...selectUniqueVariants(targetedVariants, remainingAfterReflective, seenFingerprints, deps),
      );
      if (reflectiveSelections.length >= targetCount) {
        return {
          generated_variants: reflectiveSelections,
          cleanup_variants: cleanupResults,
        };
      }

      const deterministicOptions = {
        mutationSurface: surface,
        maxVariants: targetCount,
        parentSkillPath: skillPath,
        agent,
      } as const;
      const deterministicVariants =
        surface === "routing"
          ? await (deps.generateRoutingMutations ?? generateRoutingMutations)(
              skillPath,
              deterministicOptions,
            )
          : await (deps.generateBodyMutations ?? generateBodyMutations)(
              skillPath,
              deterministicOptions,
            );
      cleanupResults.push(...deterministicVariants);
      reflectiveSelections.push(
        ...selectUniqueVariants(
          deterministicVariants,
          targetCount - reflectiveSelections.length,
          seenFingerprints,
          deps,
        ),
      );

      return {
        generated_variants: reflectiveSelections,
        cleanup_variants: cleanupResults,
      };
    }

    const targetedVariants =
      surface === "routing"
        ? (deps.generateTargetedRoutingMutations ?? generateTargetedRoutingMutations)(
            skillPath,
            weaknesses,
            {
              maxVariants: targetCount,
            },
          )
        : (deps.generateTargetedBodyMutations ?? generateTargetedBodyMutations)(
            skillPath,
            weaknesses,
            {
              maxVariants: targetCount,
            },
          );
    cleanupResults.push(...targetedVariants);

    const generatedVariants = selectUniqueVariants(
      targetedVariants,
      targetCount,
      seenFingerprints,
      deps,
    );
    if (generatedVariants.length >= targetCount) {
      return {
        generated_variants: generatedVariants,
        cleanup_variants: cleanupResults,
      };
    }

    const deterministicOptions = {
      mutationSurface: surface,
      maxVariants: targetCount,
      parentSkillPath: skillPath,
      agent,
    } as const;
    const deterministicVariants =
      surface === "routing"
        ? await (deps.generateRoutingMutations ?? generateRoutingMutations)(
            skillPath,
            deterministicOptions,
          )
        : await (deps.generateBodyMutations ?? generateBodyMutations)(
            skillPath,
            deterministicOptions,
          );
    cleanupResults.push(...deterministicVariants);
    generatedVariants.push(
      ...selectUniqueVariants(
        deterministicVariants,
        targetCount - generatedVariants.length,
        seenFingerprints,
        deps,
      ),
    );

    return {
      generated_variants: generatedVariants,
      cleanup_variants: cleanupResults,
    };
  } catch (error) {
    cleanupVariants(cleanupResults);
    throw error;
  }
}

export async function generateSearchRunVariants(
  skillPath: string,
  skillName: string,
  surfacePlan: SearchSurfacePlan,
  agent: string | undefined,
  db: Database,
  deps: SearchRunVariantGenerationDeps = {},
): Promise<GeneratedSearchRunVariants> {
  const seenFingerprints = new Set<string>();
  const cleanupResults: BoundedMutationResult[] = [];

  try {
    const routingVariants = await generateSurfaceVariants(
      skillPath,
      skillName,
      surfacePlan.routing_count,
      "routing",
      agent,
      db,
      seenFingerprints,
      deps,
    );
    cleanupResults.push(...routingVariants.cleanup_variants);

    const bodyVariants = await generateSurfaceVariants(
      skillPath,
      skillName,
      surfacePlan.body_count,
      "body",
      agent,
      db,
      seenFingerprints,
      deps,
    );
    cleanupResults.push(...bodyVariants.cleanup_variants);

    return {
      generated_variants: [
        ...routingVariants.generated_variants,
        ...bodyVariants.generated_variants,
      ],
      cleanup_variants: cleanupResults,
    };
  } catch (error) {
    cleanupVariants(cleanupResults);
    throw error;
  }
}

function buildSearchRunNextCommand(skillPath: string, passed: boolean): string {
  return passed
    ? `selftune publish --skill-path ${skillPath}`
    : `selftune verify --skill-path ${skillPath}`;
}

function normalizeCandidateEvaluationForSkillPath(
  evaluation: CreatePackageEvaluationResult,
  skillPath: string,
): CreatePackageEvaluationResult {
  const nextCommand = buildSearchRunNextCommand(skillPath, evaluation.summary.evaluation_passed);
  return {
    ...evaluation,
    summary: {
      ...evaluation.summary,
      skill_path: skillPath,
      evaluation_source: "candidate_cache",
      next_command: nextCommand,
    },
    replay: {
      ...evaluation.replay,
      skill_path: skillPath,
    },
  };
}

export function applySearchRunWinner(
  skillName: string,
  targetSkillPath: string,
  winnerCandidateId: string | null,
  deps: ApplySearchRunWinnerDeps = {},
): ApplySearchRunWinnerResult {
  if (!winnerCandidateId) {
    return {
      applied_winner: false,
      applied_candidate_id: null,
      next_command: null,
      package_evaluation: null,
    };
  }

  const candidateArtifact = (deps.readPackageCandidateArtifact ?? readPackageCandidateArtifact)(
    skillName,
    winnerCandidateId,
  );
  if (!candidateArtifact) {
    throw new CLIError(
      `Winner candidate artifact is missing for ${winnerCandidateId}.`,
      "OPERATION_FAILED",
      "Re-run selftune search-run to regenerate candidate artifacts.",
    );
  }

  const winnerSkillPath = candidateArtifact.summary.skill_path;
  const winnerContent = (
    deps.readSkillContent ?? ((skillPath) => readFileSync(skillPath, "utf-8"))
  )(winnerSkillPath);
  (deps.writeSkillContent ?? ((skillPath, content) => writeFileSync(skillPath, content, "utf-8")))(
    targetSkillPath,
    winnerContent,
  );

  const normalizedEvaluation = normalizeCandidateEvaluationForSkillPath(
    candidateArtifact,
    targetSkillPath,
  );
  (deps.writeCanonicalPackageEvaluationArtifact ?? writeCanonicalPackageEvaluationArtifact)(
    skillName,
    normalizedEvaluation,
  );
  (deps.writeCanonicalPackageEvaluation ?? writeCanonicalPackageEvaluation)(
    skillName,
    normalizedEvaluation.summary,
  );

  return {
    applied_winner: true,
    applied_candidate_id: winnerCandidateId,
    next_command: normalizedEvaluation.summary.next_command,
    package_evaluation: normalizedEvaluation.summary,
  };
}

function formatSearchRunSummary(result: SearchRunPayload): string {
  const lines = [
    `Bounded package search complete for ${result.skill_name}`,
    "",
    `Candidates evaluated: ${result.candidates_evaluated}`,
    `Surface plan: routing ${result.surface_plan.routing_count}, body ${result.surface_plan.body_count}`,
    `Frontier size: ${result.provenance.frontier_size}`,
    `Parent selection: ${result.provenance.parent_selection_method}`,
    `Parent candidate: ${result.parent_candidate_id ?? "root"}`,
    `Winner candidate: ${result.winner_candidate_id ?? "none"}`,
  ];
  if (result.surface_plan.weakness_source !== "default_even_split") {
    lines.push(
      `Surface evidence: ${result.surface_plan.weakness_source} (routing ${result.surface_plan.routing_weakness?.toFixed(2) ?? "n/a"}, body ${result.surface_plan.body_weakness?.toFixed(2) ?? "n/a"})`,
    );
  }
  if (result.winner_rationale) {
    lines.push(`Winner rationale: ${result.winner_rationale}`);
  }
  if (result.applied_winner) {
    lines.push(`Winner applied: ${result.applied_candidate_id ?? result.winner_candidate_id}`);
  }
  if (result.next_command) {
    lines.push(`Next command: ${result.next_command}`);
  }
  return lines.join("\n");
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      "skill-path": { type: "string" },
      surface: { type: "string" },
      "max-candidates": { type: "string" },
      agent: { type: "string" },
      "eval-set": { type: "string" },
      "apply-winner": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.searchRun));
    process.exit(0);
  }

  const skillPathArg = values["skill-path"] ?? "";
  if (!skillPathArg.trim()) {
    throw new CLIError(
      "--skill-path <path> is required.",
      "MISSING_FLAG",
      "selftune search-run --skill-path <path>",
    );
  }

  const surface = readSurface(values.surface);
  const maxCandidates = readMaxCandidates(values["max-candidates"]);
  const skillPath = resolveCreateSkillPath(skillPathArg).skill_path;
  const skill = values.skill?.trim() || inferSkillName(skillPath);
  const db = getDb();
  const surfacePlan = planVariantCounts(
    surface,
    maxCandidates,
    surface === "both" ? readMeasuredSurfaceWeakness(skill, db) : undefined,
  );
  let generatedVariants: SearchRunVariant[] = [];
  let cleanupGeneratedVariants: BoundedMutationResult[] = [];

  try {
    const preparedVariants = await generateSearchRunVariants(
      skillPath,
      skill,
      surfacePlan,
      values.agent,
      db,
    );
    generatedVariants = preparedVariants.generated_variants;
    cleanupGeneratedVariants = preparedVariants.cleanup_variants;

    const result = await runPackageSearch({
      skill_name: skill,
      candidate_paths: generatedVariants.map((variant) => ({
        skill_path: variant.skill_path,
        fingerprint: variant.fingerprint,
      })),
      max_candidates: maxCandidates,
      surface_plan: surfacePlan,
      agent: values.agent,
      evalSetPath: values["eval-set"],
      db,
    });

    const winnerApplication = values["apply-winner"]
      ? applySearchRunWinner(skill, skillPath, result.winner_candidate_id)
      : {
          applied_winner: false,
          applied_candidate_id: null,
          next_command: null,
          package_evaluation: null,
        };

    const payload: SearchRunPayload = {
      ...result,
      generated_variants: generatedVariants,
      improved: result.winner_candidate_id != null,
      surface_plan: surfacePlan,
      ...winnerApplication,
    };

    if (values.json || !process.stdout.isTTY) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(formatSearchRunSummary(payload));
    }
  } finally {
    cleanupVariants(cleanupGeneratedVariants);
  }

  process.exit(0);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
