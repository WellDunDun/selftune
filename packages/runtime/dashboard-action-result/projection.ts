import type { DashboardActionName, DashboardActionResultSummary } from "../dashboard-contract.js";
import { extractJsonObject } from "../utils/json-output.js";
import { buildPackageEvaluationSummary } from "./package-summary.js";
import {
  readBoolean,
  readNumber,
  readObject,
  readPackageEfficiencySummary,
  readString,
} from "./package-readers.js";
import { extractSearchRunSummary } from "./search-summary.js";
import { buildWatchSummary } from "./watch-summary.js";

export function extractDashboardActionSummary(
  action: DashboardActionName,
  stdout: string,
): DashboardActionResultSummary | null {
  const parsed = extractJsonObject(stdout);
  if (!parsed) return null;

  if (action === "create-check") {
    const readiness = readObject(parsed["readiness"]);
    const specValidation = readObject(parsed["spec_validation"]);
    const ok = readBoolean(parsed["ok"]);
    const state = readString(parsed["state"]);
    const recommendedCommand = readString(readiness?.["recommended_command"]);

    return {
      reason:
        readString(readiness?.["summary"]) ??
        (ok === true
          ? "Draft package passed create check"
          : state
            ? `Draft package is in ${state.replaceAll("_", " ")} state`
            : null),
      improved: ok,
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: readString(specValidation?.["validator"]),
      recommended_command: recommendedCommand ?? undefined,
    };
  }

  if (action === "replay-dry-run") {
    return {
      reason: readString(parsed["reason"]),
      improved: readBoolean(parsed["improved"]),
      deployed: readBoolean(parsed["deployed"]),
      before_pass_rate: readNumber(parsed["before_pass_rate"]) ?? readNumber(parsed["before"]),
      after_pass_rate: readNumber(parsed["after_pass_rate"]) ?? readNumber(parsed["after"]),
      net_change: readNumber(parsed["net_change"]),
      validation_mode: readString(parsed["validation_mode"]),
    };
  }

  if (action === "search-run") {
    const searchRun = extractSearchRunSummary(parsed);
    const packageSummary = buildPackageEvaluationSummary(readObject(parsed["package_evaluation"]), {
      deployed: false,
      reason: readString(parsed["winner_rationale"]),
    });
    return {
      ...(packageSummary ?? {
        reason: readString(parsed["winner_rationale"]),
        improved: readBoolean(parsed["improved"]) ?? searchRun?.winner_candidate_id != null,
        deployed: null,
        before_pass_rate: null,
        after_pass_rate: null,
        net_change: null,
        validation_mode: null,
        recommended_command: readString(parsed["next_command"])
          ? readString(parsed["next_command"])
          : undefined,
      }),
      search_run: searchRun,
    };
  }

  if (action === "measure-baseline") {
    const packageEfficiency = readPackageEfficiencySummary(parsed["runtime_metrics"]);
    return {
      reason:
        readBoolean(parsed["adds_value"]) === false ? "Baseline gate failed" : "Baseline measured",
      improved: readBoolean(parsed["adds_value"]),
      deployed: null,
      before_pass_rate: readNumber(parsed["baseline_pass_rate"]),
      after_pass_rate: readNumber(parsed["with_skill_pass_rate"]),
      net_change: readNumber(parsed["lift"]),
      validation_mode: readString(parsed["mode"]) === "package" ? "host_replay" : null,
      package_efficiency: packageEfficiency ?? undefined,
    };
  }

  if (action === "report-package") {
    const report = readObject(parsed["report"]);
    const summary = readObject(parsed["summary"]) ?? readObject(report?.["summary"]);
    const status = readString(summary?.["status"]);
    const packageSummary = buildPackageEvaluationSummary(summary, {
      deployed: null,
      reason:
        status === "replay_failed"
          ? "Package report detected replay failures"
          : status === "baseline_failed"
            ? "Package report detected a baseline regression"
            : "Package report ready",
    });
    if (packageSummary) {
      return packageSummary;
    }

    const readiness = readObject(parsed["readiness"]);
    const verified = readBoolean(parsed["verified"]);
    const readinessState =
      readString(parsed["readiness_state"]) ?? readString(readiness?.["state"]);
    const recommendedCommand =
      readString(parsed["next_command"]) ?? readString(readiness?.["next_command"]);

    return {
      reason:
        readString(readiness?.["summary"]) ??
        (readinessState
          ? `Draft package is in ${readinessState.replaceAll("_", " ")} state`
          : null),
      improved: verified ?? readBoolean(readiness?.["ok"]),
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: null,
      recommended_command: recommendedCommand ?? undefined,
    };
  }

  if (action === "deploy-candidate" || action === "watch") {
    const packageEvaluation = readObject(parsed["package_evaluation"]);

    if (action === "watch") {
      const directWatchSummary = buildWatchSummary(parsed);
      if (directWatchSummary) return directWatchSummary;

      const nestedWatchResult = readObject(parsed["watch_result"]);
      const nestedWatchSummary = nestedWatchResult
        ? buildWatchSummary(
            nestedWatchResult,
            "Package evaluation passed and watch started",
            packageEvaluation,
          )
        : null;
      if (nestedWatchSummary) return nestedWatchSummary;
    }

    const status = readString(packageEvaluation?.["status"]);
    const published = readBoolean(parsed["published"]);
    const watchGatePassed =
      action === "watch"
        ? readString(parsed["alert"]) == null
        : (readBoolean(parsed["watch_gate_passed"]) ?? null);
    const baseSummary = buildPackageEvaluationSummary(packageEvaluation, {
      deployed: published,
      reason:
        status === "replay_failed"
          ? "Package replay failed"
          : status === "baseline_failed"
            ? "Package baseline failed"
            : action === "watch" && readBoolean(parsed["watch_started"])
              ? "Package evaluation passed and watch started"
              : published
                ? "Package evaluation passed"
                : null,
    });
    if (baseSummary) {
      return { ...baseSummary, watch_gate_passed: watchGatePassed };
    }
    return baseSummary;
  }

  return null;
}
