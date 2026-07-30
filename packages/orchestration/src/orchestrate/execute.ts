import {
  deriveExpectationsFromSkill,
  gradeSession,
  resolveLatestSessionForSkill,
} from "@selftune/runtime/grading/grade-session";
import type { readGradingResultsForSkill } from "@selftune/runtime/grading/results";
import {
  writeGradingBaseline,
  writeGradingResultToDb,
} from "@selftune/runtime/localdb/direct-write";
import type { watch as watchSkill } from "@selftune/runtime/monitoring/watch";
import type { EvolveOptions, evolve as evolveSkill } from "@selftune/runtime/evolution/evolve";
import type { ReplayValidationOptions } from "@selftune/runtime/evolution/engines/replay-engine";
import { buildRuntimeReplayValidationOptions } from "@selftune/runtime/evolution/validate-host-replay";
import { findRecentlyDeployedSkills } from "./plan.js";
import type { OrchestrateOptions, PackageSearchResult, SkillAction } from "../orchestrate.js";
import type {
  EvolutionAuditEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";
import { readExcerpt } from "@selftune/runtime/utils/transcript";

export interface ReplayOptionBuildInput {
  skillName: string;
  skillPath: string;
  agent: string | null;
}

export function buildReplayValidationOptions(
  input: ReplayOptionBuildInput,
): ReplayValidationOptions | undefined {
  const { skillName, skillPath, agent } = input;
  if (!agent) return undefined;

  return buildRuntimeReplayValidationOptions({
    skillName,
    skillPath,
    agent,
    contentTarget: "description",
  });
}

export interface RunEvolutionPhaseInput {
  evolveCandidates: SkillAction[];
  agent: string | null;
  options: Pick<OrchestrateOptions, "approvalMode" | "dryRun">;
  resolveSkillPath: (skillName: string) => string | undefined;
  readGradingResults: typeof readGradingResultsForSkill;
  evolve: typeof evolveSkill;
  buildReplayOptions: typeof buildReplayValidationOptions;
  evolveDefaults: Pick<
    EvolveOptions,
    | "paretoEnabled"
    | "candidateCount"
    | "tokenEfficiencyEnabled"
    | "withBaseline"
    | "validationModel"
    | "cheapLoop"
    | "gateModel"
    | "adaptiveGate"
    | "proposalModel"
  >;
}

export async function runEvolutionPhase(input: RunEvolutionPhaseInput): Promise<SkillAction[]> {
  const {
    evolveCandidates,
    agent,
    options,
    resolveSkillPath,
    readGradingResults,
    evolve,
    buildReplayOptions,
    evolveDefaults,
  } = input;

  if (!agent) return [];

  for (const candidate of evolveCandidates) {
    if (candidate.action === "skip") continue;

    const skillPath = resolveSkillPath(candidate.skill);
    if (!skillPath) {
      candidate.action = "skip";
      candidate.reason = `SKILL.md not found for "${candidate.skill}"`;
      console.error(`  ⊘ ${candidate.skill}: ${candidate.reason}`);
      continue;
    }

    const effectiveDryRun = options.dryRun || options.approvalMode === "review";
    console.error(
      `[orchestrate] Evolving "${candidate.skill}"${effectiveDryRun ? " (dry-run)" : ""}...`,
    );

    try {
      const evolveResult = await evolve({
        skillName: candidate.skill,
        skillPath,
        agent,
        dryRun: effectiveDryRun,
        confidenceThreshold: 0.6,
        maxIterations: 3,
        gradingResults: readGradingResults(candidate.skill),
        syncFirst: false,
        replayOptions: buildReplayOptions({
          skillName: candidate.skill,
          skillPath,
          agent,
        }),
        ...evolveDefaults,
      });

      candidate.evolveResult = evolveResult;

      if (evolveResult.deployed) {
        console.error(`  ✓ ${candidate.skill}: deployed (${evolveResult.reason})`);
      } else {
        console.error(`  ✗ ${candidate.skill}: not deployed (${evolveResult.reason})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      candidate.action = "skip";
      candidate.reason = `evolve error: ${msg}`;
      console.error(`  ✗ ${candidate.skill}: error — ${msg}`);
    }
  }

  return evolveCandidates.filter(
    (candidate) => candidate.action === "evolve" && candidate.evolveResult?.deployed,
  );
}

export interface AutoGradeFreshDeploysInput {
  freshlyDeployedCandidates: SkillAction[];
  dryRun: boolean;
  agent: string | null;
  detectAgent: () => string | null;
  readTelemetry: () => SessionTelemetryRecord[];
  readSkillRecords: () => SkillUsageRecord[];
}

export async function autoGradeFreshDeploys(input: AutoGradeFreshDeploysInput): Promise<void> {
  const { freshlyDeployedCandidates, dryRun, agent, detectAgent, readTelemetry, readSkillRecords } =
    input;

  if (dryRun || freshlyDeployedCandidates.length === 0) return;

  const gradeAgent = agent ?? detectAgent();
  if (!gradeAgent) return;

  for (const candidate of freshlyDeployedCandidates) {
    try {
      const freshTelemetry = readTelemetry();
      const freshSkillUsage = readSkillRecords();
      let gradedCount = 0;
      const gradingPassRates: number[] = [];

      const resolved = resolveLatestSessionForSkill(
        freshTelemetry,
        freshSkillUsage,
        candidate.skill,
      );
      if (resolved) {
        const derived = deriveExpectationsFromSkill(candidate.skill);
        let transcriptExcerpt = "(no transcript)";
        if (resolved.transcriptPath) {
          try {
            transcriptExcerpt = readExcerpt(resolved.transcriptPath);
          } catch {
            transcriptExcerpt = "(no transcript)";
          }
        }

        const result = await gradeSession({
          expectations: derived.expectations,
          telemetry: resolved.telemetry,
          sessionId: resolved.sessionId,
          skillName: candidate.skill,
          transcriptExcerpt,
          transcriptPath: resolved.transcriptPath,
          agent: gradeAgent,
        });

        const persisted = writeGradingResultToDb(result);
        if (persisted) {
          gradedCount++;
          gradingPassRates.push(result.summary.pass_rate);
        }
      }

      if (gradedCount > 0) {
        const avgPassRate =
          gradingPassRates.reduce((sum, passRate) => sum + passRate, 0) / gradingPassRates.length;
        const proposalId = candidate.evolveResult?.auditEntries?.find(
          (entry: { action: string }) => entry.action === "deployed",
        )?.proposal_id;

        writeGradingBaseline({
          skill_name: candidate.skill,
          proposal_id: proposalId ?? null,
          measured_at: new Date().toISOString(),
          pass_rate: avgPassRate,
          mean_score: null,
          sample_size: gradedCount,
          grading_results_json: JSON.stringify(gradingPassRates),
        });

        console.error(
          `  [post-deploy] ${candidate.skill}: graded ${gradedCount} session(s), baseline pass_rate=${avgPassRate.toFixed(2)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [post-deploy] ${candidate.skill}: auto-grade error — ${msg}`);
    }
  }
}

export interface WatchRecentDeploysInput {
  candidates: SkillAction[];
  freshlyDeployedCandidates: SkillAction[];
  skillFilter?: string;
  recentWindowHours: number;
  readAuditEntries: () => EvolutionAuditEntry[];
  resolveSkillPath: (skillName: string) => string | undefined;
  watch: typeof watchSkill;
}

export async function watchRecentDeploys(
  input: WatchRecentDeploysInput,
): Promise<{ freshAuditEntries: EvolutionAuditEntry[]; freshlyWatchedSkills: string[] }> {
  const {
    candidates,
    freshlyDeployedCandidates,
    skillFilter,
    recentWindowHours,
    readAuditEntries,
    resolveSkillPath,
    watch,
  } = input;

  const freshAuditEntries = readAuditEntries();
  const recentlyEvolved = findRecentlyDeployedSkills(freshAuditEntries, recentWindowHours);

  for (const candidate of freshlyDeployedCandidates) {
    recentlyEvolved.add(candidate.skill);
  }

  const freshlyWatchedSkills: string[] = [];

  for (const skillName of recentlyEvolved) {
    if (skillFilter && skillName !== skillFilter) continue;

    const skillPath = resolveSkillPath(skillName);
    if (!skillPath) continue;

    const isFreshlyDeployed = freshlyDeployedCandidates.some(
      (candidate) => candidate.skill === skillName,
    );
    const label = isFreshlyDeployed ? "freshly deployed" : "recently evolved";
    console.error(`[orchestrate] Watching "${skillName}" (${label})...`);

    try {
      const watchResult = await watch({
        skillName,
        skillPath,
        windowSessions: 20,
        regressionThreshold: 0.1,
        autoRollback: true,
        enableGradeWatch: true,
        syncFirst: false,
      });

      if (isFreshlyDeployed) {
        const existingCandidate = candidates.find(
          (candidate) => candidate.skill === skillName && candidate.action === "evolve",
        );
        if (existingCandidate) {
          existingCandidate.watchResult = watchResult;
        }
        freshlyWatchedSkills.push(skillName);
      } else {
        candidates.push({
          skill: skillName,
          action: "watch",
          reason: watchResult.alert ?? "stable",
          watchResult,
        });
      }

      console.error(
        `  ${watchResult.alert ? "⚠" : "✓"} ${skillName}: ${watchResult.recommendation}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${skillName}: watch error — ${msg}`);
    }
  }

  return { freshAuditEntries, freshlyWatchedSkills };
}

// ---------------------------------------------------------------------------
// Package Search Phase
// ---------------------------------------------------------------------------

export interface RunPackageSearchPhaseInput {
  packageSearchCandidates: SkillAction[];
  dryRun: boolean;
  agent: string | null;
  resolveSkillPath: (skillName: string) => string | undefined;
  deps?: RunPackageSearchPhaseDeps;
}

export interface RunPackageSearchPhaseDeps {
  generateReflectiveRoutingMutations?: typeof import("@selftune/runtime/evolution/bounded-mutations").generateReflectiveRoutingMutations;
  generateReflectiveBodyMutations?: typeof import("@selftune/runtime/evolution/bounded-mutations").generateReflectiveBodyMutations;
  generateRoutingMutations?: typeof import("@selftune/runtime/evolution/bounded-mutations").generateRoutingMutations;
  generateBodyMutations?: typeof import("@selftune/runtime/evolution/bounded-mutations").generateBodyMutations;
  generateTargetedRoutingMutations?: typeof import("@selftune/runtime/evolution/bounded-mutations").generateTargetedRoutingMutations;
  generateTargetedBodyMutations?: typeof import("@selftune/runtime/evolution/bounded-mutations").generateTargetedBodyMutations;
  extractMutationWeaknesses?: typeof import("@selftune/runtime/evolution/bounded-mutations").extractMutationWeaknesses;
  cleanupVariants?: typeof import("@selftune/runtime/evolution/bounded-mutations").cleanupVariants;
  computeCreatePackageFingerprint?: typeof import("@selftune/runtime/create/package-fingerprint").computeCreatePackageFingerprint;
  runPackageSearch?: typeof import("@selftune/runtime/create/package-search").runPackageSearch;
  applySearchRunWinner?: typeof import("../search-run.js").applySearchRunWinner;
  getDb?: typeof import("@selftune/local-store").getDb;
}

/**
 * Runs bounded package search for candidates tagged with action "package-search".
 *
 * For each candidate:
 * 1. Resolves skill path
 * 2. Generates routing + body mutations (bounded variants)
 * 3. Fingerprints each variant
 * 4. Runs package search evaluation across variants
 * 5. Applies the winning candidate if found
 * 6. Cleans up temporary variant files
 *
 * Returns candidates where a winner was found and applied.
 */
export async function runPackageSearchPhase(
  input: RunPackageSearchPhaseInput,
): Promise<SkillAction[]> {
  const { packageSearchCandidates, dryRun, agent, resolveSkillPath, deps = {} } = input;

  if (packageSearchCandidates.length === 0) return [];

  console.error(
    `[orchestrate] Package search: ${packageSearchCandidates.length} candidate(s)${dryRun ? " (dry-run)" : ""}`,
  );

  // Pre-resolve skill paths and handle dry-run before loading optional modules
  const resolved: Array<{ candidate: SkillAction; skillPath: string }> = [];
  for (const candidate of packageSearchCandidates) {
    const skillPath = resolveSkillPath(candidate.skill);
    if (!skillPath) {
      candidate.action = "skip";
      candidate.reason = `SKILL.md not found for "${candidate.skill}"`;
      console.error(`  [pkg-search] ${candidate.skill}: ${candidate.reason}`);
      continue;
    }

    if (dryRun) {
      candidate.packageSearchResult = {
        searched: false,
        winnerApplied: false,
        candidateCount: 0,
      };
      console.error(`  [pkg-search] ${candidate.skill}: skipped (dry-run)`);
      continue;
    }

    resolved.push({ candidate, skillPath });
  }

  // Nothing left to process after path resolution and dry-run filtering
  if (resolved.length === 0) return [];

  // Lazy-load package search dependencies. These modules are optional and may
  // not exist yet if the package-search feature is still being built.
  let generateRoutingMutations: typeof import("@selftune/runtime/evolution/bounded-mutations").generateRoutingMutations;
  let generateBodyMutations: typeof import("@selftune/runtime/evolution/bounded-mutations").generateBodyMutations;
  let generateReflectiveRoutingMutations: typeof import("@selftune/runtime/evolution/bounded-mutations").generateReflectiveRoutingMutations;
  let generateReflectiveBodyMutations: typeof import("@selftune/runtime/evolution/bounded-mutations").generateReflectiveBodyMutations;
  let generateTargetedRoutingMutations: typeof import("@selftune/runtime/evolution/bounded-mutations").generateTargetedRoutingMutations;
  let generateTargetedBodyMutations: typeof import("@selftune/runtime/evolution/bounded-mutations").generateTargetedBodyMutations;
  let extractMutationWeaknesses: typeof import("@selftune/runtime/evolution/bounded-mutations").extractMutationWeaknesses;
  let cleanupVariants: typeof import("@selftune/runtime/evolution/bounded-mutations").cleanupVariants;
  let computeCreatePackageFingerprint: typeof import("@selftune/runtime/create/package-fingerprint").computeCreatePackageFingerprint;
  let runPackageSearch: typeof import("@selftune/runtime/create/package-search").runPackageSearch;
  let applySearchRunWinner: typeof import("../search-run.js").applySearchRunWinner;
  let getDb: typeof import("@selftune/local-store").getDb;

  try {
    if (
      deps.generateReflectiveRoutingMutations &&
      deps.generateReflectiveBodyMutations &&
      deps.generateRoutingMutations &&
      deps.generateBodyMutations &&
      deps.generateTargetedRoutingMutations &&
      deps.generateTargetedBodyMutations &&
      deps.extractMutationWeaknesses &&
      deps.cleanupVariants &&
      deps.computeCreatePackageFingerprint &&
      deps.runPackageSearch &&
      deps.applySearchRunWinner &&
      deps.getDb
    ) {
      generateReflectiveRoutingMutations = deps.generateReflectiveRoutingMutations;
      generateReflectiveBodyMutations = deps.generateReflectiveBodyMutations;
      generateRoutingMutations = deps.generateRoutingMutations;
      generateBodyMutations = deps.generateBodyMutations;
      generateTargetedRoutingMutations = deps.generateTargetedRoutingMutations;
      generateTargetedBodyMutations = deps.generateTargetedBodyMutations;
      extractMutationWeaknesses = deps.extractMutationWeaknesses;
      cleanupVariants = deps.cleanupVariants;
      computeCreatePackageFingerprint = deps.computeCreatePackageFingerprint;
      runPackageSearch = deps.runPackageSearch;
      applySearchRunWinner = deps.applySearchRunWinner;
      getDb = deps.getDb;
    } else {
      const boundedMutations = await import("@selftune/runtime/evolution/bounded-mutations");
      generateReflectiveRoutingMutations = boundedMutations.generateReflectiveRoutingMutations;
      generateReflectiveBodyMutations = boundedMutations.generateReflectiveBodyMutations;
      generateRoutingMutations = boundedMutations.generateRoutingMutations;
      generateBodyMutations = boundedMutations.generateBodyMutations;
      generateTargetedRoutingMutations = boundedMutations.generateTargetedRoutingMutations;
      generateTargetedBodyMutations = boundedMutations.generateTargetedBodyMutations;
      extractMutationWeaknesses = boundedMutations.extractMutationWeaknesses;
      cleanupVariants = boundedMutations.cleanupVariants;

      const fingerprint = await import("@selftune/runtime/create/package-fingerprint");
      computeCreatePackageFingerprint = fingerprint.computeCreatePackageFingerprint;

      const packageSearch = await import("@selftune/runtime/create/package-search");
      runPackageSearch = packageSearch.runPackageSearch;

      const searchRun = await import("../search-run.js");
      applySearchRunWinner = searchRun.applySearchRunWinner;

      const localdb = await import("@selftune/local-store");
      getDb = localdb.getDb;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrate] Package search modules not available — skipping. ${msg}`);
    for (const { candidate } of resolved) {
      candidate.action = "skip";
      candidate.reason = `package-search modules unavailable: ${msg}`;
    }
    return [];
  }

  const improved: SkillAction[] = [];

  for (const { candidate, skillPath } of resolved) {
    let allMutations: Array<{
      variantSkillPath: string;
      mutationSurface: "routing" | "body";
      mutationDescription: string;
      parentFingerprint: string;
    }> = [];
    try {
      console.error(`  [pkg-search] ${candidate.skill}: generating bounded mutations...`);
      const db = getDb();
      const weaknesses = extractMutationWeaknesses(candidate.skill, db);

      // Generate reflective, targeted, and deterministic mutations in
      // priority order. Reflective variants consume measured evaluator evidence
      // first, then bounded heuristics fill the remaining space.
      const [
        routingMutations,
        bodyMutations,
        reflectiveRoutingMutations,
        reflectiveBodyMutations,
        targetedRoutingMutations,
        targetedBodyMutations,
      ] = await Promise.all([
        generateRoutingMutations(skillPath),
        generateBodyMutations(skillPath),
        agent
          ? Promise.resolve(
              generateReflectiveRoutingMutations(skillPath, weaknesses, {
                maxVariants: 1,
                skillName: candidate.skill,
                agent,
              }).catch(() => []),
            )
          : Promise.resolve([]),
        agent
          ? Promise.resolve(
              generateReflectiveBodyMutations(skillPath, weaknesses, {
                maxVariants: 1,
                skillName: candidate.skill,
                agent,
              }).catch(() => []),
            )
          : Promise.resolve([]),
        Promise.resolve(generateTargetedRoutingMutations(skillPath, weaknesses)),
        Promise.resolve(generateTargetedBodyMutations(skillPath, weaknesses)),
      ]);

      allMutations = [
        ...reflectiveRoutingMutations,
        ...reflectiveBodyMutations,
        ...targetedRoutingMutations,
        ...targetedBodyMutations,
        ...routingMutations,
        ...bodyMutations,
      ];
      if (allMutations.length === 0) {
        candidate.packageSearchResult = {
          searched: false,
          winnerApplied: false,
          candidateCount: 0,
        };
        candidate.reason = "no mutations generated";
        console.error(`  [pkg-search] ${candidate.skill}: no mutations generated`);
        continue;
      }

      // Fingerprint and deduplicate each variant.
      const candidatePaths: Array<{ skill_path: string; fingerprint: string }> = [];
      const seenFingerprints = new Set<string>();
      for (const mutation of allMutations) {
        const fp = computeCreatePackageFingerprint(mutation.variantSkillPath);
        if (fp && !seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          candidatePaths.push({ skill_path: mutation.variantSkillPath, fingerprint: fp });
        }
      }

      if (candidatePaths.length === 0) {
        cleanupVariants(allMutations);
        candidate.packageSearchResult = {
          searched: false,
          winnerApplied: false,
          candidateCount: 0,
        };
        candidate.reason = "no fingerprints computed";
        console.error(`  [pkg-search] ${candidate.skill}: no fingerprints computed`);
        continue;
      }

      console.error(
        `  [pkg-search] ${candidate.skill}: searching ${candidatePaths.length} variant(s)...`,
      );

      // Run the package search
      const searchResult = await runPackageSearch({
        skill_name: candidate.skill,
        candidate_paths: candidatePaths,
        agent: agent ?? undefined,
        db: getDb(),
      });

      const searchedResult: PackageSearchResult = {
        searched: true,
        winnerApplied: false,
        candidateCount: candidatePaths.length,
      };

      // Apply winner if found
      if (searchResult.winner_candidate_id) {
        console.error(`  [pkg-search] ${candidate.skill}: winner found, applying...`);
        const applyResult = applySearchRunWinner(
          candidate.skill,
          skillPath,
          searchResult.winner_candidate_id,
        );
        searchedResult.winnerApplied = applyResult.applied_winner;
        searchedResult.winnerCandidateId = searchResult.winner_candidate_id;

        if (applyResult.applied_winner) {
          console.error(`  [pkg-search] ${candidate.skill}: winner applied successfully`);
          improved.push(candidate);
        } else {
          console.error(`  [pkg-search] ${candidate.skill}: winner could not be applied`);
        }
      } else {
        console.error(`  [pkg-search] ${candidate.skill}: no winner found`);
      }

      candidate.packageSearchResult = searchedResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      candidate.action = "skip";
      candidate.reason = `package-search error: ${msg}`;
      console.error(`  [pkg-search] ${candidate.skill}: error — ${msg}`);
    } finally {
      if (allMutations.length > 0) {
        cleanupVariants(allMutations);
      }
    }
  }

  return improved;
}
