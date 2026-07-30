/** Public dashboard action-result projection API. */
export type {
  DashboardActionOutcome,
  DashboardActionOutcomeInput,
} from "./dashboard-action-result/contracts.js";
export { resolveDashboardActionOutcome } from "./dashboard-action-result/outcome.js";
export { extractDashboardActionSummary } from "./dashboard-action-result/projection.js";
export { readCreatePackageEvaluationWatchSummary } from "./dashboard-action-result/watch-summary.js";
