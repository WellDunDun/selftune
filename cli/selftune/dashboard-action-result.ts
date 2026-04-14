import type { DashboardActionName, DashboardActionResultSummary } from "./dashboard-contract.js";

export interface DashboardActionOutcomeInput {
  action: DashboardActionName;
  stdout: string;
  stderr: string | null;
  exitCode: number | null;
}

export interface DashboardActionOutcome {
  success: boolean;
  error: string | null;
  summary: DashboardActionResultSummary | null;
}

function extractJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function extractDashboardActionSummary(
  action: DashboardActionName,
  stdout: string,
): DashboardActionResultSummary | null {
  if (action !== "replay-dry-run") return null;

  const parsed = extractJsonObject(stdout);
  if (!parsed) return null;

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
