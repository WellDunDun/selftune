import type { CliJsonOutput } from "../utils/json-output.js";
import type { DashboardActionResultSummary } from "../dashboard-contract.js";
import {
  readBoolean,
  readCandidateAcceptanceDecision,
  readNumber,
  readObject,
  readPackageBodySummary,
  readPackageEfficiencySummary,
  readPackageEvaluationSource,
  readPackageEvidenceSummary,
  readPackageGradingSummary,
  readPackageReplaySummary,
  readPackageUnitTestSummary,
  readString,
} from "./package-readers.js";
import { readCreatePackageEvaluationWatchSummary } from "./watch-summary.js";

export function buildPackageEvaluationSummary(
  packageEvaluation: CliJsonOutput | null,
  options: {
    deployed: boolean | null;
    reason: string | null;
  },
): DashboardActionResultSummary | null {
  if (!packageEvaluation) return null;

  const replay = readObject(packageEvaluation["replay"]);
  const baseline = readObject(packageEvaluation["baseline"]);
  const recommendedCommand = readString(packageEvaluation["next_command"]);
  const packageEvaluationSource = readPackageEvaluationSource(
    packageEvaluation["evaluation_source"],
  );
  const packageCandidateId = readString(packageEvaluation["candidate_id"]);
  const packageParentCandidateId = readString(packageEvaluation["parent_candidate_id"]);
  const packageCandidateGeneration = readNumber(packageEvaluation["candidate_generation"]);
  const packageCandidateAcceptance = readObject(packageEvaluation["candidate_acceptance"]);
  const packageCandidateAcceptanceDecision = readCandidateAcceptanceDecision(
    packageCandidateAcceptance?.["decision"],
  );
  const packageCandidateAcceptanceRationale = readString(packageCandidateAcceptance?.["rationale"]);
  const packageEvidence = readPackageEvidenceSummary(packageEvaluation["evidence"]);
  const packageEfficiency = readPackageEfficiencySummary(packageEvaluation["efficiency"]);
  const packageRouting = readPackageReplaySummary(packageEvaluation["routing"]);
  const packageBody = readPackageBodySummary(packageEvaluation["body"]);
  const packageGrading = readPackageGradingSummary(packageEvaluation["grading"]);
  const packageUnitTests = readPackageUnitTestSummary(packageEvaluation["unit_tests"]);
  const packageWatch = readCreatePackageEvaluationWatchSummary(packageEvaluation["watch"]);

  return {
    reason: options.reason,
    improved: readBoolean(packageEvaluation["evaluation_passed"]),
    deployed: options.deployed,
    before_pass_rate: readNumber(baseline?.["baseline_pass_rate"]),
    after_pass_rate: readNumber(baseline?.["with_skill_pass_rate"]),
    net_change: readNumber(baseline?.["lift"]),
    validation_mode: readString(replay?.["validation_mode"]),
    recommended_command: recommendedCommand ?? undefined,
    package_evaluation_source: packageEvaluationSource ?? undefined,
    package_candidate_id: packageCandidateId ?? undefined,
    package_parent_candidate_id: packageParentCandidateId ?? undefined,
    package_candidate_generation: packageCandidateGeneration ?? undefined,
    package_candidate_acceptance_decision: packageCandidateAcceptanceDecision ?? undefined,
    package_candidate_acceptance_rationale: packageCandidateAcceptanceRationale ?? undefined,
    package_evidence: packageEvidence ?? undefined,
    package_efficiency: packageEfficiency ?? undefined,
    package_routing: packageRouting ?? undefined,
    package_body: packageBody ?? undefined,
    package_grading: packageGrading ?? undefined,
    package_unit_tests: packageUnitTests ?? undefined,
    package_watch: packageWatch ?? undefined,
  };
}
