/**
 * Route handlers for the selftune dashboard server.
 *
 * Re-exports all route handler functions for clean imports.
 */

export { handleOverview } from "./overview.js";
export { handleSkillReport } from "./skill-report.js";
export { handleOrchestrateRuns } from "./orchestrate-runs.js";
export { handleDoctor } from "./doctor.js";
export { handleBadge } from "./badge.js";
export { handleReport } from "./report.js";
export { handleAction, runAction } from "./actions.js";
export type { ActionRunner } from "./actions.js";
