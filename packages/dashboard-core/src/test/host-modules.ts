import type { DashboardHostModules } from "../host";

const unavailable = { access: "unavailable", reason: "Not used by this test." } as const;

export function hostModules(overrides: Partial<DashboardHostModules> = {}): DashboardHostModules {
  return {
    capability: { host: "local", plan: "oss", features: {} },
    skillSets: { projects: unavailable, library: unavailable },
    skills: { host: "local", library: unavailable, decisions: unavailable },
    plugins: {},
    recipientShares: {},
    teamCollaboration: {},
    ...overrides,
  };
}
