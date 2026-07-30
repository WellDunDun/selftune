import type { DashboardActionName, DashboardActionResultSummary } from "../dashboard-contract.js";

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
