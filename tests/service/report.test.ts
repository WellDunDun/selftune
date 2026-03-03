import { describe, expect, it } from "bun:test";
import { renderReportHTML } from "../../service/report/report-html.js";
import type { AggregatedSkillData } from "../../service/types.js";

describe("renderReportHTML", () => {
  const testData: AggregatedSkillData = {
    skill_name: "test-skill",
    weighted_pass_rate: 0.85,
    trend: "up",
    status: "HEALTHY",
    contributor_count: 5,
    session_count: 42,
    last_updated: "2026-01-15T00:00:00Z",
  };

  it("returns valid HTML", () => {
    const html = renderReportHTML(testData);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("includes skill name in title", () => {
    const html = renderReportHTML(testData);
    expect(html).toContain("test-skill");
  });

  it("embeds badge image", () => {
    const html = renderReportHTML(testData);
    expect(html).toContain('/badge/test-skill"');
  });

  it("shows pass rate", () => {
    const html = renderReportHTML(testData);
    expect(html).toContain("85%");
  });

  it("shows contributor count", () => {
    const html = renderReportHTML(testData);
    expect(html).toContain("5");
  });

  it("includes embed code", () => {
    const html = renderReportHTML(testData);
    expect(html).toContain("selftune.dev/badge/test-skill");
  });

  it("escapes HTML in skill names", () => {
    const xssData = { ...testData, skill_name: '<script>alert("xss")</script>' };
    const html = renderReportHTML(xssData);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain("&lt;script&gt;");
  });
});
