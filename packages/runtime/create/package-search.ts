/**
 * Bounded package search runner.
 *
 * Orchestrates a minibatch of candidate evaluations against the accepted
 * frontier parent. Candidates are passed in (mutation is external);
 * this module only evaluates, compares, and persists results.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { randomUUIDv7 } from "bun";
import type { Database } from "bun:sqlite";
import type { PackageSearchProvenance, PackageSearchRunResult } from "../types.js";
import { parseSkillSections, replaceSection } from "../evolution/deploy-proposal.js";
import {
  listAcceptedPackageFrontierCandidates,
  readPackageCandidateArtifactByFingerprint,
  selectAcceptedPackageFrontierCandidate,
} from "./package-candidate-state.js";
import { computeCreatePackageFingerprint } from "./package-fingerprint.js";
import {
  runCreatePackageEvaluation,
  type CreatePackageEvaluationDeps,
} from "./package-evaluator.js";

// ---------------------------------------------------------------------------
// Search options
// ---------------------------------------------------------------------------

export interface PackageSearchOptions {
  /** Skill name to search packages for. */
  skill_name: string;
  /** Candidate variant paths to evaluate this run. */
  candidate_paths: Array<{
    skill_path: string;
    fingerprint: string;
    mutation_surface?: "routing" | "body" | "merged";
  }>;
  /** Maximum candidates to evaluate per run (minibatch size). Default 5. */
  max_candidates?: number;
  /** Optional measured routing/body budget used to build this search run. */
  surface_plan?: PackageSearchProvenance["surface_plan"];
  /** Database handle. */
  db: Database;
  /** Agent identifier for replay. */
  agent?: string;
  /** Optional eval-set override for package evaluation. */
  evalSetPath?: string;
  /** Optional evaluator dependency overrides. */
  evaluator_deps?: CreatePackageEvaluationDeps;
}

type EvaluatedCandidate = {
  candidateId: string;
  decision: string;
  rationale: string;
  skillPath: string;
  fingerprint: string;
  mutationSurface: "routing" | "body" | "merged" | null;
  evaluation: Awaited<ReturnType<typeof runCreatePackageEvaluation>>;
};

function mergeComplementarySkillCandidates(
  routingSkillPath: string,
  bodySkillPath: string,
): string {
  const routingContent = readFileSync(routingSkillPath, "utf-8");
  const bodyContent = readFileSync(bodySkillPath, "utf-8");
  const routingSection = parseSkillSections(routingContent).sections["Workflow Routing"] ?? "";
  if (!routingSection.trim()) {
    throw new Error(
      `Routing variant at ${routingSkillPath} does not contain a Workflow Routing section`,
    );
  }

  const mergedContent = replaceSection(bodyContent, "Workflow Routing", routingSection.trim());
  const bodyVariantDir = dirname(bodySkillPath);
  const mergedVariantDir = join(
    mkdtempSync(join(tmpdir(), "selftune-package-search-merged-")),
    basename(bodyVariantDir),
  );
  cpSync(bodyVariantDir, mergedVariantDir, { recursive: true });

  const mergedSkillPath = join(mergedVariantDir, basename(bodySkillPath));
  writeFileSync(mergedSkillPath, mergedContent, "utf-8");
  return mergedSkillPath;
}

function pickBestAcceptedCandidate(
  candidates: EvaluatedCandidate[],
  surface: "routing" | "body",
): EvaluatedCandidate | null {
  const matching = candidates.filter(
    (candidate) => candidate.decision === "accepted" && candidate.mutationSurface === surface,
  );
  if (matching.length === 0) return null;

  return matching.toSorted((left, right) => {
    if (surface === "routing") {
      const leftScore =
        left.evaluation.summary.routing?.pass_rate ?? left.evaluation.summary.replay.pass_rate;
      const rightScore =
        right.evaluation.summary.routing?.pass_rate ?? right.evaluation.summary.replay.pass_rate;
      return rightScore - leftScore;
    }

    const leftBody = left.evaluation.summary.body;
    const rightBody = right.evaluation.summary.body;
    const leftValid = leftBody?.valid ? 1 : 0;
    const rightValid = rightBody?.valid ? 1 : 0;
    if (rightValid !== leftValid) {
      return rightValid - leftValid;
    }

    return (rightBody?.quality_score ?? -1) - (leftBody?.quality_score ?? -1);
  })[0]!;
}

// ---------------------------------------------------------------------------
// Search persistence
// ---------------------------------------------------------------------------

/** Persist a search run result to the package_search_runs table. */
export function insertSearchRun(db: Database, result: PackageSearchRunResult): void {
  db.run(
    `INSERT INTO package_search_runs
       (search_id, skill_name, parent_candidate_id, winner_candidate_id,
        winner_rationale, candidates_evaluated, provenance_json,
        started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      result.search_id,
      result.skill_name,
      result.parent_candidate_id,
      result.winner_candidate_id,
      result.winner_rationale,
      result.candidates_evaluated,
      JSON.stringify(result.provenance),
      result.started_at,
      result.completed_at,
    ],
  );
}

/** Read all search runs for a skill, newest first. */
export function readSearchRuns(db: Database, skillName: string): PackageSearchRunResult[] {
  const rows = db
    .query(
      `SELECT search_id, skill_name, parent_candidate_id, winner_candidate_id,
              winner_rationale, candidates_evaluated, provenance_json,
              started_at, completed_at
       FROM package_search_runs
       WHERE skill_name = ?
       ORDER BY started_at DESC`,
    )
    .all(skillName) as Array<{
    search_id: string;
    skill_name: string;
    parent_candidate_id: string | null;
    winner_candidate_id: string | null;
    winner_rationale: string | null;
    candidates_evaluated: number;
    provenance_json: string;
    started_at: string;
    completed_at: string;
  }>;

  return rows.map((r) => ({
    search_id: r.search_id,
    skill_name: r.skill_name,
    parent_candidate_id: r.parent_candidate_id,
    candidates_evaluated: r.candidates_evaluated,
    winner_candidate_id: r.winner_candidate_id,
    winner_rationale: r.winner_rationale,
    started_at: r.started_at,
    completed_at: r.completed_at,
    provenance: JSON.parse(r.provenance_json) as PackageSearchProvenance,
  }));
}

function selectWinningCandidate(
  skillName: string,
  evaluatedCandidateIds: Set<string>,
  db: Database,
): {
  winnerCandidateId: string | null;
  winnerRationale: string | null;
} {
  if (evaluatedCandidateIds.size === 0) {
    return {
      winnerCandidateId: null,
      winnerRationale: null,
    };
  }

  const winner =
    listAcceptedPackageFrontierCandidates(skillName, db).find((candidate) =>
      evaluatedCandidateIds.has(candidate.candidate_id),
    ) ?? null;

  return {
    winnerCandidateId: winner?.candidate_id ?? null,
    winnerRationale: winner?.summary.candidate_acceptance?.rationale ?? null,
  };
}

// ---------------------------------------------------------------------------
// Search runner
// ---------------------------------------------------------------------------

/**
 * Run a bounded package search.
 *
 * 1. Reads the accepted frontier for the skill
 * 2. Selects a parent from the frontier (or null for first-ever run)
 * 3. Evaluates each candidate (up to max_candidates) through the evaluator
 * 4. Compares results, picks the best accepted winner using frontier ranking
 * 5. Persists the search run with full provenance
 */
export async function runPackageSearch(
  opts: PackageSearchOptions,
): Promise<PackageSearchRunResult> {
  const startedAt = new Date().toISOString();
  const searchId = randomUUIDv7();
  const maxCandidates = opts.max_candidates ?? 5;

  // 1. Read frontier and select parent
  const frontier = listAcceptedPackageFrontierCandidates(opts.skill_name, opts.db);
  const parent = selectAcceptedPackageFrontierCandidate(opts.skill_name, { db: opts.db });

  // 2. Filter candidates: skip already-evaluated fingerprints, cap at maxCandidates
  const candidatesToEvaluate = opts.candidate_paths
    .filter((c) => {
      const existing = readPackageCandidateArtifactByFingerprint(opts.skill_name, c.fingerprint, {
        db: opts.db,
      });
      return existing === null;
    })
    .slice(0, maxCandidates);

  // 3. Evaluate each candidate through the shared package evaluator
  const evaluationSummaries: PackageSearchProvenance["evaluation_summaries"] = [];
  const acceptedCandidateIds = new Set<string>();
  const evaluatedCandidates: EvaluatedCandidate[] = [];

  const deps: CreatePackageEvaluationDeps = {
    ...opts.evaluator_deps,
    getDb: () => opts.db,
  };

  for (const candidate of candidatesToEvaluate) {
    const evaluation = await runCreatePackageEvaluation(
      {
        skillPath: candidate.skill_path,
        skillName: opts.skill_name,
        mode: "package",
        agent: opts.agent,
        evalSetPath: opts.evalSetPath,
      },
      deps,
    );

    const acceptance = evaluation.summary.candidate_acceptance;
    const decision = acceptance?.decision ?? "rejected";
    const rationale = acceptance?.rationale ?? "No acceptance summary produced.";
    const candidateId = evaluation.summary.candidate_id ?? candidate.fingerprint;
    const mutationSurface = candidate.mutation_surface ?? null;

    evaluationSummaries.push({
      candidate_id: candidateId,
      decision,
      rationale,
    });
    evaluatedCandidates.push({
      candidateId,
      decision,
      rationale,
      skillPath: candidate.skill_path,
      fingerprint: candidate.fingerprint,
      mutationSurface,
      evaluation,
    });
    if (decision === "accepted") {
      acceptedCandidateIds.add(candidateId);
    }
  }

  const acceptedRoutingCandidate = pickBestAcceptedCandidate(evaluatedCandidates, "routing");
  const acceptedBodyCandidate = pickBestAcceptedCandidate(evaluatedCandidates, "body");

  if (acceptedRoutingCandidate && acceptedBodyCandidate) {
    const mergedVariantPath = mergeComplementarySkillCandidates(
      acceptedRoutingCandidate.skillPath,
      acceptedBodyCandidate.skillPath,
    );

    const mergedFingerprint = computeCreatePackageFingerprint(mergedVariantPath);
    if (mergedFingerprint) {
      const mergedEvaluation = await runCreatePackageEvaluation(
        {
          skillPath: mergedVariantPath,
          skillName: opts.skill_name,
          mode: "package",
          agent: opts.agent,
          evalSetPath: opts.evalSetPath,
        },
        deps,
      );

      const mergedAcceptance = mergedEvaluation.summary.candidate_acceptance;
      const mergedDecision = mergedAcceptance?.decision ?? "rejected";
      const mergedRationalePrefix = `Merged accepted routing ${acceptedRoutingCandidate.candidateId} with accepted body ${acceptedBodyCandidate.candidateId}.`;
      const mergedRationale = mergedAcceptance?.rationale
        ? `${mergedRationalePrefix} ${mergedAcceptance.rationale}`
        : mergedRationalePrefix;
      const mergedCandidateId = mergedEvaluation.summary.candidate_id ?? mergedFingerprint;

      evaluationSummaries.push({
        candidate_id: mergedCandidateId,
        decision: mergedDecision,
        rationale: mergedRationale,
      });
      evaluatedCandidates.push({
        candidateId: mergedCandidateId,
        decision: mergedDecision,
        rationale: mergedRationale,
        skillPath: mergedVariantPath,
        fingerprint: mergedFingerprint,
        mutationSurface: "merged",
        evaluation: mergedEvaluation,
      });
      candidatesToEvaluate.push({
        skill_path: mergedVariantPath,
        fingerprint: mergedFingerprint,
        mutation_surface: "merged",
      });
      if (mergedDecision === "accepted") {
        acceptedCandidateIds.add(mergedCandidateId);
      }
    }
  }

  const completedAt = new Date().toISOString();
  const { winnerCandidateId, winnerRationale } = selectWinningCandidate(
    opts.skill_name,
    acceptedCandidateIds,
    opts.db,
  );

  // 4. Build result with provenance
  const provenance: PackageSearchProvenance = {
    frontier_size: frontier.length,
    parent_selection_method: parent ? "highest_ranked_frontier" : "none_first_run",
    candidate_fingerprints: candidatesToEvaluate.map((c) => c.fingerprint),
    ...(opts.surface_plan ? { surface_plan: opts.surface_plan } : {}),
    evaluation_summaries: evaluationSummaries,
  };

  const result: PackageSearchRunResult = {
    search_id: searchId,
    skill_name: opts.skill_name,
    parent_candidate_id: parent?.candidate_id ?? null,
    candidates_evaluated: candidatesToEvaluate.length,
    winner_candidate_id: winnerCandidateId,
    winner_rationale: winnerRationale,
    started_at: startedAt,
    completed_at: completedAt,
    provenance,
  };

  // 5. Persist the search run
  insertSearchRun(opts.db, result);

  return result;
}
