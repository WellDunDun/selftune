import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { readCreatePackageEvaluationWatchSummary } from "../dashboard-action-result.js";
import type { WatchResult } from "../monitoring/watch.js";
import { computeWatchTrustScore } from "../monitoring/watch.js";
import {
  readCanonicalPackageEvaluationArtifact,
  writeCanonicalPackageEvaluation,
} from "../testing-readiness.js";
import type {
  CreatePackageEvaluationSummary,
  CreatePackageEvaluationWatchSummary,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { extractJsonObject } from "../utils/json-output.js";
import { resolveSelftuneCliEntrypoint } from "../package-root.js";
import { refreshPackageCandidateEvaluationObservation } from "./package-candidate-state.js";
import {
  attachCreatePackageWatchSummary,
  runCreatePackageEvaluation,
} from "./package-evaluator.js";
import { computeCreateCheckResult } from "./readiness.js";

export interface CreatePublishResult {
  skill: string;
  skill_path: string;
  published: boolean;
  watch_started: boolean;
  watch_gate_blocked: boolean;
  next_command: string | null;
  package_evaluation: CreatePackageEvaluationSummary | null;
  replay_exit_code: number | null;
  baseline_exit_code: number | null;
  watch_exit_code: number | null;
  watch_result: WatchResult | null;
  watch_stdout: string;
  watch_stderr: string;
  watch_gate_passed: boolean | null;
  watch_gate_warnings: string[];
  watch_trust_score: number | null;
  watch_gate_bypassed: boolean;
}

export interface CreatePublishDeps {
  spawnSync?: typeof Bun.spawnSync;
  computeCreateCheckResult?: typeof computeCreateCheckResult;
  runCreatePackageEvaluation?: typeof runCreatePackageEvaluation;
  refreshPackageCandidateEvaluationObservation?: typeof refreshPackageCandidateEvaluationObservation;
  writeCanonicalPackageEvaluation?: typeof writeCanonicalPackageEvaluation;
}

export interface RunCreatePublishOptions {
  skillPath: string;
  watch?: boolean;
  ignoreWatchAlerts?: boolean;
  evalSetPath?: string;
}

function hydrateWatchResult(summary: CreatePackageEvaluationWatchSummary): WatchResult {
  return {
    snapshot: summary.snapshot,
    alert: summary.alert,
    rolledBack: summary.rolled_back,
    recommendation: summary.recommendation,
    recommended_command: summary.recommended_command,
    gradeAlert: summary.grade_alert,
    gradeRegression: summary.grade_regression,
    ...(summary.efficiency_alert || summary.efficiency_regression
      ? {
          efficiencyAlert: summary.efficiency_alert ?? null,
          efficiencyRegression: summary.efficiency_regression ?? null,
        }
      : {}),
  };
}

function runSelftuneCommand(
  command: string[],
  deps: CreatePublishDeps = {},
): { exitCode: number | null; stdout: string; stderr: string } {
  const spawnSync = deps.spawnSync ?? Bun.spawnSync;
  const indexPath = resolveSelftuneCliEntrypoint();
  const result = spawnSync(["bun", "run", indexPath, ...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  };
}

function parseWatchResult(stdout: string): WatchResult | null {
  const parsed = extractJsonObject(stdout);
  if (!parsed) return null;
  const summary = readCreatePackageEvaluationWatchSummary(parsed);
  return summary ? hydrateWatchResult(summary) : null;
}

export async function runCreatePublish(
  options: RunCreatePublishOptions,
  deps: CreatePublishDeps = {},
): Promise<CreatePublishResult> {
  const check = await (deps.computeCreateCheckResult ?? computeCreateCheckResult)(
    options.skillPath,
  );
  if (check.state !== "ready_to_publish") {
    throw new CLIError(
      `Draft package "${check.skill}" is not ready to publish (${check.state}).`,
      "INVALID_STATUS",
      check.next_command ?? `selftune create check --skill-path ${check.skill_path}`,
    );
  }

  const evaluation = await (deps.runCreatePackageEvaluation ?? runCreatePackageEvaluation)({
    skillPath: check.skill_path,
    evalSetPath: options.evalSetPath,
  });
  const replayExitCode = evaluation.replay.failed === 0 ? 0 : 1;
  const baselineExitCode =
    evaluation.summary.status === "replay_failed" ? null : evaluation.baseline.adds_value ? 0 : 1;

  if (!evaluation.summary.evaluation_passed) {
    return {
      skill: check.skill,
      skill_path: check.skill_path,
      published: false,
      watch_started: false,
      watch_gate_blocked: false,
      next_command: evaluation.summary.next_command,
      package_evaluation: evaluation.summary,
      replay_exit_code: replayExitCode,
      baseline_exit_code: baselineExitCode,
      watch_exit_code: null,
      watch_result: null,
      watch_stdout: "",
      watch_stderr: "",
      watch_gate_passed: null,
      watch_gate_warnings: [],
      watch_trust_score: null,
      watch_gate_bypassed: false,
    };
  }

  if (!options.watch) {
    return {
      skill: check.skill,
      skill_path: check.skill_path,
      published: true,
      watch_started: false,
      watch_gate_blocked: false,
      next_command: `selftune watch --skill ${check.skill} --skill-path ${check.skill_path}`,
      package_evaluation: evaluation.summary,
      replay_exit_code: replayExitCode,
      baseline_exit_code: baselineExitCode,
      watch_exit_code: null,
      watch_result: null,
      watch_stdout: "",
      watch_stderr: "",
      watch_gate_passed: null,
      watch_gate_warnings: [],
      watch_trust_score: null,
      watch_gate_bypassed: false,
    };
  }

  const priorWatch = readCanonicalPackageEvaluationArtifact(check.skill)?.summary.watch;
  const watch = runSelftuneCommand(
    ["watch", "--skill", check.skill, "--skill-path", check.skill_path, "--sync-first"],
    deps,
  );
  const watchResult = parseWatchResult(watch.stdout);
  const packageEvaluationResult = watchResult
    ? {
        ...evaluation,
        summary: attachCreatePackageWatchSummary(evaluation.summary, watchResult),
      }
    : evaluation;
  const packageEvaluation = packageEvaluationResult.summary;

  if (watchResult) {
    try {
      (
        deps.refreshPackageCandidateEvaluationObservation ??
        refreshPackageCandidateEvaluationObservation
      )(packageEvaluationResult);
    } catch {
      // Fail-open: candidate observation refresh should not block publish/watch results.
    }
  }

  const recentWatchResults = [
    ...(priorWatch ? [hydrateWatchResult(priorWatch)] : []),
    ...(watchResult ? [watchResult] : []),
  ];
  const baseWatchGate = checkPublishWatchGate({
    skillName: check.skill,
    recentWatchResults,
    ignoreWatchAlerts: options.ignoreWatchAlerts,
  });
  const watchGate =
    watchResult == null
      ? {
          passed: options.ignoreWatchAlerts === true,
          warnings: [
            `Watch for "${check.skill}" did not return structured JSON output${watch.exitCode != null ? ` (exit ${watch.exitCode})` : ""}. Re-run watch before publishing.`,
            ...baseWatchGate.warnings,
          ],
          trustScore: baseWatchGate.trustScore,
          bypassed: options.ignoreWatchAlerts === true,
        }
      : baseWatchGate;

  try {
    (deps.writeCanonicalPackageEvaluation ?? writeCanonicalPackageEvaluation)(
      check.skill,
      packageEvaluation,
    );
  } catch {
    // Fail-open: post-watch persistence should not block publish/watch results.
  }

  const watchGateBlocked = !watchGate.passed;
  const watchRemediationCommand = `selftune watch --skill ${check.skill} --skill-path ${check.skill_path}`;

  return {
    skill: check.skill,
    skill_path: check.skill_path,
    published: !watchGateBlocked,
    watch_started: watch.exitCode === 0 && watchResult != null,
    watch_gate_blocked: watchGateBlocked,
    next_command: watchGateBlocked
      ? watchRemediationCommand
      : watch.exitCode === 0
        ? null
        : (watchResult?.recommended_command ?? watchRemediationCommand),
    package_evaluation: packageEvaluation,
    replay_exit_code: replayExitCode,
    baseline_exit_code: baselineExitCode,
    watch_exit_code: watch.exitCode,
    watch_result: watchResult,
    watch_stdout: watch.stdout,
    watch_stderr: watch.stderr,
    watch_gate_passed: watchGate.passed,
    watch_gate_warnings: watchGate.warnings,
    watch_trust_score: watchGate.trustScore,
    watch_gate_bypassed: watchGate.bypassed,
  };
}

export function formatCreatePublishResult(result: CreatePublishResult): string {
  const replayStatus =
    result.package_evaluation == null
      ? "not run"
      : result.package_evaluation.replay.failed === 0
        ? "passed"
        : "failed";
  const baselineStatus =
    result.package_evaluation == null
      ? "not run"
      : result.package_evaluation.baseline.adds_value
        ? "passed"
        : "failed";

  return [
    `Skill: ${result.skill}`,
    result.package_evaluation
      ? `Evaluation source: ${
          result.package_evaluation.evaluation_source === "artifact_cache"
            ? "cached artifact"
            : result.package_evaluation.evaluation_source === "candidate_cache"
              ? "accepted candidate cache"
              : "fresh"
        }`
      : "Evaluation source: n/a",
    result.package_evaluation?.candidate_id
      ? `Package candidate: ${result.package_evaluation.candidate_id} (generation ${result.package_evaluation.candidate_generation ?? 0}, parent ${result.package_evaluation.parent_candidate_id ?? "root"})`
      : "Package candidate: n/a",
    result.package_evaluation?.candidate_acceptance
      ? `Candidate acceptance: ${result.package_evaluation.candidate_acceptance.decision} vs ${result.package_evaluation.candidate_acceptance.compared_to_candidate_id ?? "root"} | ${result.package_evaluation.candidate_acceptance.rationale}`
      : "Candidate acceptance: n/a",
    `Package replay: ${replayStatus}`,
    `Package baseline: ${baselineStatus}`,
    result.package_evaluation
      ? `Package lift: ${result.package_evaluation.baseline.lift.toFixed(3)}`
      : "Package lift: n/a",
    result.package_evaluation?.evidence
      ? `Package wins: ${result.package_evaluation.evidence.baseline_wins} | Replay failures: ${result.package_evaluation.evidence.replay_failures}`
      : "Package wins: n/a",
    result.package_evaluation?.efficiency
      ? `Package runtime: ${(result.package_evaluation.efficiency.with_skill.total_duration_ms / 1000).toFixed(1)}s with skill / ${(result.package_evaluation.efficiency.without_skill.total_duration_ms / 1000).toFixed(1)}s without skill`
      : "Package runtime: n/a",
    result.watch_result
      ? `Watch pass rate: ${result.watch_result.snapshot.pass_rate.toFixed(3)} vs baseline ${result.watch_result.snapshot.baseline_pass_rate.toFixed(3)}`
      : "Watch pass rate: n/a",
    result.watch_result?.alert
      ? `Watch alert: ${result.watch_result.alert}`
      : result.watch_result
        ? `Watch alert: none (${result.watch_result.recommendation})`
        : "Watch alert: n/a",
    result.watch_gate_passed != null
      ? `Watch gate: ${result.watch_gate_passed ? "passed" : result.watch_gate_bypassed ? "alert bypassed" : "alert"}`
      : "Watch gate: n/a",
    result.watch_trust_score != null
      ? `Watch trust score: ${result.watch_trust_score.toFixed(2)}`
      : "Watch trust score: n/a",
    ...result.watch_gate_warnings.map(
      (warning, index) => `Watch gate warning ${index + 1}: ${warning}`,
    ),
    ...(result.watch_gate_blocked ? ["Watch gate blocked publish: yes"] : []),
    `Published: ${result.published ? "yes" : "no"}`,
    `Watch started: ${result.watch_started ? "yes" : "no"}`,
    result.next_command ? `Next command: ${result.next_command}` : "Next command: none",
  ].join("\n");
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "skill-path": { type: "string" },
      watch: { type: "boolean", default: false },
      "ignore-watch-alerts": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createPublish));
    process.exit(0);
  }

  const result = await runCreatePublish({
    skillPath: values["skill-path"] ?? "",
    watch: values.watch,
    ignoreWatchAlerts: values["ignore-watch-alerts"],
  });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCreatePublishResult(result));
  }

  process.exit(result.published ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}

// ---------------------------------------------------------------------------
// Publish watch gate — advisory gate before publish
// ---------------------------------------------------------------------------

export interface PublishWatchGateOptions {
  skillName: string;
  /** Recent watch results to evaluate. Empty array means no watch data. */
  recentWatchResults: WatchResult[];
  /** Bypass watch alerts (expert use). */
  ignoreWatchAlerts?: boolean;
}

export interface PublishWatchGateResult {
  /** Whether the gate passed (true = safe to publish). */
  passed: boolean;
  /** Warning messages for the user (empty if passed cleanly). */
  warnings: string[];
  /** The computed trust score from the most recent watch, or null if no data. */
  trustScore: number | null;
  /** Whether the user bypassed alerts with --ignore-watch-alerts. */
  bypassed: boolean;
}

/** Skills below this trust score get a publish warning. */
const PUBLISH_TRUST_WARNING_THRESHOLD = 0.7;

/**
 * Check whether recent watch results indicate safe-to-publish.
 *
 * This is the publish-time watch safety gate. Active watch alerts produce
 * warnings that block publish unless --ignore-watch-alerts is set. Missing or
 * malformed watch output is handled by the caller as a hard publish failure.
 */
export function checkPublishWatchGate(options: PublishWatchGateOptions): PublishWatchGateResult {
  const { skillName, recentWatchResults, ignoreWatchAlerts = false } = options;

  // No watch data — pass with advisory
  if (recentWatchResults.length === 0) {
    return {
      passed: true,
      warnings: [
        `No watch data for "${skillName}". Consider running "selftune watch" before publishing.`,
      ],
      trustScore: null,
      bypassed: false,
    };
  }

  const latestWatch = recentWatchResults[recentWatchResults.length - 1]!;
  const trustScore = computeWatchTrustScore(latestWatch);
  const warnings: string[] = [];

  // Check for active alerts in any recent watch result
  const activeAlerts = recentWatchResults.filter((r) => r.alert != null).map((r) => r.alert!);

  if (activeAlerts.length > 0) {
    warnings.push(
      `Active watch alerts for "${skillName}":\n${activeAlerts.map((a) => `  - ${a}`).join("\n")}`,
    );
  }

  // Check trust score threshold
  if (trustScore < PUBLISH_TRUST_WARNING_THRESHOLD) {
    warnings.push(
      `Watch trust score for "${skillName}" is ${trustScore.toFixed(2)}, below threshold ${PUBLISH_TRUST_WARNING_THRESHOLD.toFixed(2)}.`,
    );
  }

  // Check for recent rollbacks
  const hasRollback = recentWatchResults.some((r) => r.rolledBack);
  if (hasRollback) {
    warnings.push(
      `"${skillName}" was recently rolled back. Ensure the issue is resolved before publishing.`,
    );
  }

  const passed = warnings.length === 0 || ignoreWatchAlerts;

  return {
    passed,
    warnings,
    trustScore,
    bypassed: ignoreWatchAlerts && warnings.length > 0,
  };
}
