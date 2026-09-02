/**
 * Route handlers for the selftune dashboard server.
 *
 * Re-exports all route handler functions for clean imports.
 */

export type { ActionRunner } from "./actions.js";
export { handleAction, runAction } from "./actions.js";
export { handleAnalytics } from "./analytics.js";
export { handleBadge } from "./badge.js";
export { handleDoctor } from "./doctor.js";
export { createHookRoutes, type HookRunners } from "./hooks.js";
export {
  CorrectionStudyServiceError,
  createCorrectionStudyRoutes,
  type CorrectionStudyRouteOptions,
} from "./correction-studies.js";
export { handleOrchestrateRuns } from "./orchestrate-runs.js";
export {
  handleDashboardShell,
  handleOverview,
  handleTrayStatus,
  summarizeOverview,
  summarizeTrayStatus,
} from "./overview.js";
export { handleReport } from "./report.js";
export { handleSkillReport } from "./skill-report.js";
export { handleSkillSetCollisionReadiness } from "./skill-set-collision-readiness.js";
