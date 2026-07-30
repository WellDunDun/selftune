import type {
  CatalogExpansionProjectSignals,
  SkillIntelligenceSessionRow,
} from "@selftune/skill-intelligence";

export const RECENT_PROJECT_SIGNAL_SESSION_LIMIT = 500;

export function recentSessionWorkspacePaths(
  sessions: ReadonlyArray<SkillIntelligenceSessionRow>,
): string[] {
  return sessions.slice(0, RECENT_PROJECT_SIGNAL_SESSION_LIMIT).map((session) => session.cwd);
}

/**
 * Build bounded project context from newest-first session telemetry.
 *
 * Explicit workspace paths describe current caller context and remain intact. Historical
 * telemetry is sampled because catalog expansion only needs recent intent and workspace
 * signals; normalizing the entire session corpus makes report memory grow without bound.
 */
export function buildRecentProjectSignals(
  sessions: ReadonlyArray<SkillIntelligenceSessionRow>,
  workspacePaths?: ReadonlyArray<string>,
): CatalogExpansionProjectSignals {
  const recentSessions = sessions.slice(0, RECENT_PROJECT_SIGNAL_SESSION_LIMIT);
  return {
    project_root: null,
    files: workspacePaths ?? recentSessionWorkspacePaths(recentSessions),
    intents: recentSessions.map((session) => session.last_user_query),
  };
}
