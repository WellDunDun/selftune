import { describe, expect, it } from "vitest";

import type { DashboardHostAdapter } from "./adapter";
import { capabilitiesFromAdapter, featureAccessFromAdapter } from "./capabilities";

function adapter(
  input: Pick<DashboardHostAdapter, "host" | "plan" | "features">,
): DashboardHostAdapter {
  return {
    ...input,
    authentication: { useSession: () => ({ status: "authenticated" }) },
    queries: {
      fetchOverview: async () => ({
        version: "test",
        summary: {
          totalSkills: 0,
          avgPassRate30d: null,
          unmatchedCount30d: 0,
          sessionsCount30d: 0,
          pendingCount: 0,
          evidenceCount: 0,
        },
        autonomy: {
          level: "observe",
          summary: "",
          attentionRequired: false,
          skillsObserved: 0,
          pendingReviews: 0,
          lastRunAt: null,
        },
        skillCards: [],
        watchlist: [],
        attention: [],
        decisions: [],
        activity: [],
        jobs: [],
        signals: null,
      }),
      fetchSkills: async () => ({ items: [] }),
      fetchAnalytics: async () => ({
        summary: {
          activeSkills: 0,
          totalChecks30d: 0,
          totalEvolutions: 0,
          avgImprovement: 0,
        },
        passRateTrend: [],
        skillRankings: [],
        dailyActivity: [],
        evolutionImpact: [],
      }),
    },
    navigation: { upgrade: "/upgrade", openUpgrade() {} },
    mutations: {},
    permissions: { can: () => true },
    library: { access: "unavailable", reason: "Not used by this capability test." },
    projects: { access: "unavailable", reason: "Not used by this capability test." },
    decisions: { access: "unavailable", reason: "Not used by this capability test." },
  };
}

describe("adapter-derived dashboard capabilities", () => {
  it("derives usable and discoverable features without a separate host matrix", () => {
    const selfhost = adapter({
      host: "selfhost",
      plan: "team",
      features: {
        analytics: { access: "available" },
        registry: { access: "upgrade", href: "/upgrade/registry" },
      },
    });
    const capabilities = capabilitiesFromAdapter(selfhost);

    expect(capabilities.host).toBe("selfhost");
    expect(capabilities.features.analytics).toBe(true);
    expect(capabilities.features.registry).toBe(false);
    expect(capabilities.discoverable.registry).toBe(true);
    expect(capabilities.features.proposals).toBe(false);
    expect(capabilities.discoverable.proposals).toBe(false);
    expect(featureAccessFromAdapter(selfhost, "registry")).toEqual({
      access: "upgrade",
      href: "/upgrade/registry",
    });
    expect(featureAccessFromAdapter(selfhost, "proposals")).toEqual({
      access: "unavailable",
      reason: "This server does not provide this capability.",
    });
  });
});
