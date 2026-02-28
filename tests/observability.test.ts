import { describe, expect, test } from "bun:test";
import {
  checkEvolutionHealth,
  checkHookInstallation,
  checkLogHealth,
  doctor,
} from "../cli/selftune/observability.js";

describe("checkLogHealth", () => {
  test("returns checks for all four log files", () => {
    const checks = checkLogHealth();
    expect(checks.length).toBe(4);
    const names = checks.map((c) => c.name);
    expect(names).toContain("log_session_telemetry");
    expect(names).toContain("log_skill_usage");
    expect(names).toContain("log_all_queries");
    expect(names).toContain("log_evolution_audit");
  });

  test("each check has required fields", () => {
    const checks = checkLogHealth();
    for (const check of checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("path");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("message");
      expect(["pass", "fail", "warn"]).toContain(check.status);
    }
  });

  test("evolution audit log check has warn status when missing", () => {
    const checks = checkLogHealth();
    const evolutionCheck = checks.find((c) => c.name === "log_evolution_audit");
    expect(evolutionCheck).toBeDefined();
    // Evolution audit log is optional until first evolution run,
    // so it should be "warn" when the file does not exist
    if (evolutionCheck && evolutionCheck.status !== "pass") {
      expect(evolutionCheck.status).toBe("warn");
    }
  });
});

describe("checkHookInstallation", () => {
  test("returns checks for all three hooks", () => {
    const checks = checkHookInstallation();
    expect(checks.length).toBe(3);
  });

  test("finds installed hook files", () => {
    // The hooks should exist since we created them
    const checks = checkHookInstallation();
    const passing = checks.filter((c) => c.status === "pass");
    expect(passing.length).toBe(3);
  });
});

describe("checkEvolutionHealth", () => {
  test("returns at least 1 check", () => {
    const checks = checkEvolutionHealth();
    expect(checks.length).toBeGreaterThanOrEqual(1);
  });

  test("each check has required health check fields", () => {
    const checks = checkEvolutionHealth();
    for (const check of checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("path");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("message");
      expect(["pass", "fail", "warn"]).toContain(check.status);
    }
  });

  test("evolution audit check uses warn when log is missing", () => {
    const checks = checkEvolutionHealth();
    const auditCheck = checks.find((c) => c.name === "evolution_audit");
    expect(auditCheck).toBeDefined();
    // If the evolution audit log does not exist, it should warn (not fail)
    if (auditCheck && auditCheck.status !== "pass") {
      expect(auditCheck.status).toBe("warn");
    }
  });
});

describe("doctor", () => {
  test("returns structured result", () => {
    const result = doctor();
    expect(result.command).toBe("doctor");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("checks");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("healthy");
    expect(typeof result.healthy).toBe("boolean");
    expect(result.summary.total).toBe(result.checks.length);
    expect(result.summary.pass + result.summary.fail + result.summary.warn).toBe(
      result.summary.total,
    );
  });

  test("includes evolution health checks", () => {
    const result = doctor();
    const evolutionChecks = result.checks.filter(
      (c) => c.name === "evolution_audit" || c.name === "log_evolution_audit",
    );
    expect(evolutionChecks.length).toBeGreaterThanOrEqual(1);
  });
});
