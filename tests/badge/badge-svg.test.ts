/**
 * Tests for badge data computation and SVG rendering.
 *
 * Validates color thresholds, trend arrows, SVG structure,
 * markdown/URL output formats, and boundary conditions.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { computeBadgeData, findSkillBadgeData } from "../../cli/selftune/badge/badge-data.js";
import { formatBadgeOutput, renderBadgeSvg } from "../../cli/selftune/badge/badge-svg.js";
import { makeSkillStatus, makeStatusResult, resetFixtureCounter } from "./fixtures.js";

beforeEach(() => {
  resetFixtureCounter();
});

// ---------------------------------------------------------------------------
// computeBadgeData — color thresholds
// ---------------------------------------------------------------------------

describe("computeBadgeData", () => {
  test("green badge: passRate > 0.8 produces color #4c1", () => {
    const skill = makeSkillStatus({ passRate: 0.87, status: "HEALTHY" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#4c1");
    expect(badge.status).toBe("HEALTHY");
    expect(badge.passRate).toBe(0.87);
  });

  test("yellow badge: passRate 0.6-0.8 produces color #dfb317", () => {
    const skill = makeSkillStatus({ passRate: 0.72, status: "HEALTHY" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#dfb317");
  });

  test("red badge: passRate < 0.6 produces color #e05d44", () => {
    const skill = makeSkillStatus({ passRate: 0.45, status: "CRITICAL" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#e05d44");
  });

  test("gray badge: passRate null produces color #9f9f9f and message 'no data'", () => {
    const skill = makeSkillStatus({ passRate: null, status: "UNKNOWN", trend: "unknown" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#9f9f9f");
    expect(badge.message).toBe("no data");
    expect(badge.passRate).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Trend arrows
  // ---------------------------------------------------------------------------

  test("trend up produces up arrow in message", () => {
    const skill = makeSkillStatus({ passRate: 0.9, trend: "up" });
    const badge = computeBadgeData(skill);

    expect(badge.message).toContain("\u2191");
    expect(badge.trend).toBe("up");
  });

  test("trend down produces down arrow in message", () => {
    const skill = makeSkillStatus({ passRate: 0.75, trend: "down" });
    const badge = computeBadgeData(skill);

    expect(badge.message).toContain("\u2193");
    expect(badge.trend).toBe("down");
  });

  test("trend stable produces right arrow in message", () => {
    const skill = makeSkillStatus({ passRate: 0.85, trend: "stable" });
    const badge = computeBadgeData(skill);

    expect(badge.message).toContain("\u2192");
    expect(badge.trend).toBe("stable");
  });

  // ---------------------------------------------------------------------------
  // Boundary conditions
  // ---------------------------------------------------------------------------

  test("boundary: 0% passRate produces red badge", () => {
    const skill = makeSkillStatus({ passRate: 0, status: "CRITICAL" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#e05d44");
    expect(badge.message).toContain("0%");
  });

  test("boundary: 80% exact is yellow (>80% is green)", () => {
    const skill = makeSkillStatus({ passRate: 0.8 });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#dfb317");
  });

  test("boundary: 100% passRate produces green badge", () => {
    const skill = makeSkillStatus({ passRate: 1.0, trend: "up" });
    const badge = computeBadgeData(skill);

    expect(badge.color).toBe("#4c1");
    expect(badge.message).toContain("100%");
  });

  // ---------------------------------------------------------------------------
  // Message format
  // ---------------------------------------------------------------------------

  test("message format: percentage with trend arrow", () => {
    const skill = makeSkillStatus({ passRate: 0.87, trend: "up" });
    const badge = computeBadgeData(skill);

    expect(badge.message).toBe("87% \u2191");
  });

  test("label is always 'Skill Health'", () => {
    const skill = makeSkillStatus();
    const badge = computeBadgeData(skill);

    expect(badge.label).toBe("Skill Health");
  });
});

// ---------------------------------------------------------------------------
// findSkillBadgeData
// ---------------------------------------------------------------------------

describe("findSkillBadgeData", () => {
  test("returns null for missing skill", () => {
    const result = makeStatusResult({ skills: [makeSkillStatus({ name: "api-skill" })] });
    const badge = findSkillBadgeData(result, "nonexistent-skill");

    expect(badge).toBeNull();
  });

  test("returns BadgeData for found skill", () => {
    const skill = makeSkillStatus({ name: "api-skill", passRate: 0.92, trend: "up" });
    const result = makeStatusResult({ skills: [skill] });
    const badge = findSkillBadgeData(result, "api-skill");

    expect(badge).not.toBeNull();
    expect(badge?.color).toBe("#4c1");
    expect(badge?.message).toBe("92% \u2191");
  });
});

// ---------------------------------------------------------------------------
// renderBadgeSvg
// ---------------------------------------------------------------------------

describe("renderBadgeSvg", () => {
  test("SVG contains valid xml structure", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.85, trend: "stable" }));
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  test("SVG contains the badge label text", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.85 }));
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("Skill Health");
  });

  test("SVG contains the badge message text", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.85, trend: "up" }));
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("85%");
  });

  test("SVG uses the correct badge color", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.9 }));
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("#4c1");
  });

  test("SVG contains image element for logo", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.85 }));
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("<image");
    expect(svg).toContain('x="3" y="3"');
    expect(svg).toContain('width="14" height="14"');
  });

  test("SVG contains base64 logo data URI", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.85 }));
    const svg = renderBadgeSvg(badge);

    expect(svg).toContain("data:image/svg+xml;base64,");
  });
});

// ---------------------------------------------------------------------------
// formatBadgeOutput
// ---------------------------------------------------------------------------

describe("formatBadgeOutput", () => {
  test("svg format returns SVG string", () => {
    const badge = computeBadgeData(makeSkillStatus({ passRate: 0.85 }));
    const output = formatBadgeOutput(badge, "my-skill", "svg");

    expect(output).toContain("<svg");
    expect(output).toContain("</svg>");
  });

  test("markdown format returns shields.io markdown image", () => {
    const badge = computeBadgeData(
      makeSkillStatus({ passRate: 0.85, trend: "stable", name: "api-skill" }),
    );
    const output = formatBadgeOutput(badge, "api-skill", "markdown");

    expect(output).toContain("![Skill Health: api-skill]");
    expect(output).toContain("https://img.shields.io/badge/");
    expect(output).toContain("Skill%20Health");
  });

  test("url format returns shields.io URL", () => {
    const badge = computeBadgeData(
      makeSkillStatus({ passRate: 0.85, trend: "stable", name: "api-skill" }),
    );
    const output = formatBadgeOutput(badge, "api-skill", "url");

    expect(output).toStartWith("https://img.shields.io/badge/");
    expect(output).toContain("Skill%20Health");
    expect(output).not.toContain("![");
  });
});
