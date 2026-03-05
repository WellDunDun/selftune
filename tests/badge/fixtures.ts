/**
 * Shared fixture factories for badge tests.
 */

import type { SkillStatus, StatusResult } from "../../cli/selftune/status.js";

export let fixtureCounter = 0;

export function resetFixtureCounter(): void {
  fixtureCounter = 0;
}

export function makeSkillStatus(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name: `skill-${++fixtureCounter}`,
    passRate: 0.85,
    trend: "stable" as const,
    missedQueries: 0,
    status: "HEALTHY" as const,
    snapshot: null,
    ...overrides,
  };
}

export function makeStatusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    skills: [],
    unmatchedQueries: 0,
    pendingProposals: 0,
    lastSession: null,
    system: { healthy: true, pass: 9, fail: 0, warn: 0 },
    ...overrides,
  };
}
