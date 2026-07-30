import type { DashboardActionResultSummary } from "../dashboard-contract.js";
import type { DashboardActionOutcome, DashboardActionOutcomeInput } from "./contracts.js";
import { extractDashboardActionSummary } from "./projection.js";

function isSuccessfulReplayDryRun(summary: DashboardActionResultSummary | null): boolean {
  if (!summary) return false;

  return (
    summary.reason === "Dry run - proposal validated but not deployed" &&
    summary.improved === true &&
    summary.deployed === false
  );
}

export function resolveDashboardActionOutcome(
  input: DashboardActionOutcomeInput,
): DashboardActionOutcome {
  const summary = extractDashboardActionSummary(input.action, input.stdout);

  if (input.action === "watch" && summary?.improved === false) {
    return {
      success: false,
      summary,
      error: summary.reason ?? input.stderr ?? "Watch detected a regression",
    };
  }

  if (input.exitCode === 0) {
    return { success: true, error: null, summary };
  }

  if (input.action === "replay-dry-run" && isSuccessfulReplayDryRun(summary)) {
    return { success: true, error: null, summary };
  }

  return {
    success: false,
    summary,
    error:
      input.stderr ||
      (input.exitCode == null ? "Unknown action failure" : `Exit code ${input.exitCode}`),
  };
}
