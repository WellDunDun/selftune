/**
 * Integration tests for selftune badge feature.
 *
 * Validates badge data computation, SVG rendering, format output,
 * skill lookup from StatusResult, and edge cases for pass rate boundaries.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { SkillStatus, StatusResult } from "../../cli/selftune/status.js";
import { computeBadgeData, findSkillBadgeData } from "../../cli/selftune/badge/badge-data.js";
import { formatBadgeOutput, renderBadgeSvg } from "../../cli/selftune/badge/badge-svg.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

let fixtureCounter = 0;

beforeEach(() => {
  fixtureCounter = 0;
});

function makeSkillStatus(overrides: Partial<SkillStatus> = {}): SkillStatus {
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

function makeStatusResult(skills: SkillStatus[] = []): StatusResult {
  return {
    skills,
    unmatchedQueries: 0,
    pendingProposals: 0,
    lastSession: null,
    system: { healthy: true, pass: 3, fail: 0, warn: 0 },
  };
}

// ---------------------------------------------------------------------------
// Integration: multi-skill StatusResult pipeline
// ---------------------------------------------------------------------------

describe("integration: multi-skill badge pipeline", () => {
  it("produces correct badge for each skill in a multi-skill StatusResult", () => {
    const healthy = makeSkillStatus({ name: "api-skill", passRate: 0.92, status: "HEALTHY", trend: "up" });
    const regressed = makeSkillStatus({ name: "db-skill", passRate: 0.45, status: "REGRESSED", trend: "down" });
    const noData = makeSkillStatus({ name: "new-skill", passRate: null, status: "NO DATA", trend: "unknown" });
    const result = makeStatusResult([healthy, regressed, noData]);

    const apiBadge = findSkillBadgeData(result, "api-skill");
    const dbBadge = findSkillBadgeData(result, "db-skill");
    const newBadge = findSkillBadgeData(result, "new-skill");

    expect(apiBadge).not.toBeNull();
    expect(apiBadge!.color).toBe("#4c1");
    expect(apiBadge!.message).toBe("92% \u2191");
    expect(apiBadge!.status).toBe("HEALTHY");

    expect(dbBadge).not.toBeNull();
    expect(dbBadge!.color).toBe("#e05d44");
    expect(dbBadge!.message).toBe("45% \u2193");
    expect(dbBadge!.status).toBe("REGRESSED");

    expect(newBadge).not.toBeNull();
    expect(newBadge!.color).toBe("#9f9f9f");
    expect(newBadge!.message).toBe("no data");
    expect(newBadge!.status).toBe("NO DATA");
  });

  it("regressed skill produces red badge with down trend", () => {
    const skill = makeSkillStatus({
      name: "regressed-skill",
      passRate: 0.35,
      status: "REGRESSED",
      trend: "down",
    });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#e05d44");
    expect(badge.message).toContain("\u2193");
    expect(badge.status).toBe("REGRESSED");
    expect(badge.trend).toBe("down");
  });

  it("no-data skill produces gray badge with 'no data' message", () => {
    const skill = makeSkillStatus({
      name: "empty-skill",
      passRate: null,
      status: "NO DATA",
      trend: "unknown",
    });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#9f9f9f");
    expect(badge.message).toBe("no data");
    expect(badge.passRate).toBeNull();
    expect(badge.status).toBe("NO DATA");
  });
});

// ---------------------------------------------------------------------------
// Integration: full pipeline to SVG
// ---------------------------------------------------------------------------

describe("integration: full pipeline to SVG", () => {
  it("SkillStatus -> computeBadgeData -> renderBadgeSvg produces valid SVG", () => {
    const skill = makeSkillStatus({ name: "svg-skill", passRate: 0.87, trend: "up" });
    const badge = computeBadgeData(skill);
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("xmlns=\"http://www.w3.org/2000/svg\"");
    expect(svg).toContain("Skill Health");
    expect(svg).toContain("87%");
    expect(svg).toContain("\u2191");
    expect(svg).toContain("role=\"img\"");
    expect(svg).toContain("aria-label=");
  });
});

// ---------------------------------------------------------------------------
// Integration: full pipeline to markdown
// ---------------------------------------------------------------------------

describe("integration: full pipeline to markdown", () => {
  it("SkillStatus -> computeBadgeData -> formatBadgeOutput markdown contains markdown image syntax", () => {
    const skill = makeSkillStatus({ name: "md-skill", passRate: 0.75, trend: "stable" });
    const badge = computeBadgeData(skill);
    const md = formatBadgeOutput(badge, "md-skill", "markdown");

    expect(md).toStartWith("![Skill Health: md-skill]");
    expect(md).toContain("https://img.shields.io/badge/");
    expect(md).toContain("75%25");
  });

  it("SkillStatus -> computeBadgeData -> formatBadgeOutput url produces valid URL", () => {
    const skill = makeSkillStatus({ name: "url-skill", passRate: 0.93, trend: "up" });
    const badge = computeBadgeData(skill);
    const url = formatBadgeOutput(badge, "url-skill", "url");

    expect(url).toStartWith("https://img.shields.io/badge/");
    expect(url).toContain("Skill%20Health");
    expect(url).not.toContain("![");
  });
});

// ---------------------------------------------------------------------------
// findSkillBadgeData
// ---------------------------------------------------------------------------

describe("findSkillBadgeData", () => {
  it("returns null for skill name not in StatusResult", () => {
    const result = makeStatusResult([makeSkillStatus({ name: "existing-skill" })]);
    const badge = findSkillBadgeData(result, "nonexistent-skill");

    expect(badge).toBeNull();
  });

  it("returns BadgeData for skill name that exists", () => {
    const skill = makeSkillStatus({ name: "my-skill", passRate: 0.88, trend: "up" });
    const result = makeStatusResult([skill]);
    const badge = findSkillBadgeData(result, "my-skill");

    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Skill Health");
    expect(badge!.passRate).toBe(0.88);
    expect(badge!.color).toBe("#4c1");
    expect(badge!.message).toBe("88% \u2191");
  });

  it("uses case-sensitive matching (different case returns null)", () => {
    const skill = makeSkillStatus({ name: "My-Skill" });
    const result = makeStatusResult([skill]);

    expect(findSkillBadgeData(result, "my-skill")).toBeNull();
    expect(findSkillBadgeData(result, "MY-SKILL")).toBeNull();
    expect(findSkillBadgeData(result, "My-Skill")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases: pass rate boundaries
// ---------------------------------------------------------------------------

describe("edge cases: pass rate boundaries", () => {
  it("passRate exactly 0.0 produces red badge with '0%'", () => {
    const skill = makeSkillStatus({ passRate: 0.0, trend: "stable" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#e05d44");
    expect(badge.message).toBe("0% \u2192");
  });

  it("passRate exactly 1.0 produces green badge with '100%'", () => {
    const skill = makeSkillStatus({ passRate: 1.0, trend: "stable" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#4c1");
    expect(badge.message).toBe("100% \u2192");
  });

  it("passRate exactly 0.8 produces yellow badge (>0.8 is green, so 0.8 is yellow)", () => {
    const skill = makeSkillStatus({ passRate: 0.8, trend: "stable" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#dfb317");
    expect(badge.message).toBe("80% \u2192");
  });

  it("passRate exactly 0.6 produces yellow badge (>=0.6 is yellow)", () => {
    const skill = makeSkillStatus({ passRate: 0.6, trend: "stable" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#dfb317");
    expect(badge.message).toBe("60% \u2192");
  });

  it("passRate 0.599 produces red badge", () => {
    const skill = makeSkillStatus({ passRate: 0.599, trend: "stable" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#e05d44");
    expect(badge.message).toBe("60% \u2192");
  });
});
