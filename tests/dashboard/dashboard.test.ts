import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD_PATH = join(import.meta.dir, "..", "..", "dashboard", "index.html");

describe("dashboard/index.html", () => {
  it("exists", () => {
    expect(existsSync(DASHBOARD_PATH)).toBe(true);
  });

  it("contains required elements", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("selftune");
    expect(html).toContain("dropZone");
    expect(html).toContain("session_telemetry_log.jsonl");
    expect(html).toContain("skill_usage_log.jsonl");
    expect(html).toContain("all_queries_log.jsonl");
    expect(html).toContain("evolution_audit_log.jsonl");
  });

  it("loads Chart.js from CDN", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("chart.js");
  });

  it("supports embedded data loading", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("embedded-data");
    expect(html).toContain("loadEmbeddedData");
  });

  it("waits for DOM content before trying to load embedded data", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("window.addEventListener('DOMContentLoaded'");
  });

  it("has skill health grid element", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("skill-health-grid");
  });

  it("handles computed data field", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("computed");
  });

  it("has drill-down panel element", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html.includes("drill-down") || html.includes("drillDown")).toBe(true);
  });

  it("has skill search input", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("skillSearchInput");
  });

  it("has evaluation feed table", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("drillEvalFeed");
  });

  it("has invocation breakdown chart", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("chartInvocationBreakdown");
  });

  it("has time period selector buttons", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("period-btn");
  });

  it("has 4-state badge classes", () => {
    const html = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(html).toContain("badge-warning");
    expect(html).toContain("badge-critical");
    expect(html).toContain("badge-healthy");
    expect(html).toContain("badge-unknown");
  });
});

describe("cli/selftune/dashboard.ts", () => {
  it("module exists", () => {
    const modPath = join(import.meta.dir, "..", "..", "cli", "selftune", "dashboard.ts");
    expect(existsSync(modPath)).toBe(true);
  });

  it("imports from constants (shared layer)", () => {
    const modPath = join(import.meta.dir, "..", "..", "cli", "selftune", "dashboard.ts");
    const src = readFileSync(modPath, "utf-8");
    expect(src).toContain("./constants");
  });

  it("imports from monitoring for snapshot computation", () => {
    const modPath = join(import.meta.dir, "..", "..", "cli", "selftune", "dashboard.ts");
    const src = readFileSync(modPath, "utf-8");
    expect(src).toContain("computeMonitoringSnapshot");
  });

  it("imports from evolution for audit trail", () => {
    const modPath = join(import.meta.dir, "..", "..", "cli", "selftune", "dashboard.ts");
    const src = readFileSync(modPath, "utf-8");
    expect(src).toContain("getLastDeployedProposal");
    expect(src).toContain("readAuditTrail");
  });
});
