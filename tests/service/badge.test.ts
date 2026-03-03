import { describe, expect, it } from "bun:test";
import { aggregatedToBadgeData } from "../../service/aggregation/compute-badge.js";
import type { AggregatedSkillData } from "../../service/types.js";

describe("aggregatedToBadgeData", () => {
  it("returns gray badge for NO DATA", () => {
    const data: AggregatedSkillData = {
      skill_name: "test", weighted_pass_rate: 0, trend: "unknown",
      status: "NO DATA", contributor_count: 0, session_count: 0,
      last_updated: new Date().toISOString(),
    };
    const badge = aggregatedToBadgeData(data);
    expect(badge.color).toBe("#9f9f9f");
    expect(badge.message).toBe("no data");
    expect(badge.passRate).toBeNull();
  });

  it("returns green badge for high pass rate", () => {
    const data: AggregatedSkillData = {
      skill_name: "test", weighted_pass_rate: 0.92, trend: "up",
      status: "HEALTHY", contributor_count: 5, session_count: 50,
      last_updated: new Date().toISOString(),
    };
    const badge = aggregatedToBadgeData(data);
    expect(badge.color).toBe("#4c1");
    expect(badge.message).toContain("92%");
    expect(badge.message).toContain("\u2191");
  });

  it("returns yellow badge for moderate pass rate", () => {
    const data: AggregatedSkillData = {
      skill_name: "test", weighted_pass_rate: 0.72, trend: "stable",
      status: "HEALTHY", contributor_count: 3, session_count: 30,
      last_updated: new Date().toISOString(),
    };
    const badge = aggregatedToBadgeData(data);
    expect(badge.color).toBe("#dfb317");
  });

  it("returns red badge for low pass rate", () => {
    const data: AggregatedSkillData = {
      skill_name: "test", weighted_pass_rate: 0.45, trend: "down",
      status: "REGRESSED", contributor_count: 2, session_count: 20,
      last_updated: new Date().toISOString(),
    };
    const badge = aggregatedToBadgeData(data);
    expect(badge.color).toBe("#e05d44");
  });
});
