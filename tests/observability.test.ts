import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

  test("evolution audit log check has correct status for file state", () => {
    const auditPath = join(homedir(), ".claude", "evolution_audit_log.jsonl");
    const fileExists = existsSync(auditPath);
    const checks = checkLogHealth();
    const evolutionCheck = checks.find((c) => c.name === "log_evolution_audit");
    expect(evolutionCheck).toBeDefined();
    if (fileExists) {
      // File exists -- should be "pass" (valid) or "fail" (corrupt)
      expect(["pass", "fail"]).toContain(evolutionCheck?.status);
    } else {
      // File missing -- should be "warn", never "fail"
      expect(evolutionCheck?.status).toBe("warn");
    }
  });
});

describe("checkHookInstallation", () => {
  test("returns checks for all hooks including settings", () => {
    const checks = checkHookInstallation();
    expect(checks.length).toBe(4);
  });

  test("reports hook files status against repo .git/hooks directory", () => {
    // Hooks are checked in .git/hooks/ (not bundled source), so in a
    // test environment they are typically absent and should report "fail"
    const checks = checkHookInstallation();
    const hookFileChecks = checks.filter(
      (c) => c.name.startsWith("hook_") && c.name !== "hook_settings",
    );
    expect(hookFileChecks.length).toBe(3);
    for (const check of hookFileChecks) {
      expect(["pass", "fail"]).toContain(check.status);
      // path should point to .git/hooks/, not bundled source
      expect(check.path).toContain(".git/hooks/");
    }
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

  test("evolution audit check has correct status for file state", () => {
    const auditPath = join(homedir(), ".claude", "evolution_audit_log.jsonl");
    const fileExists = existsSync(auditPath);
    const checks = checkEvolutionHealth();
    const auditCheck = checks.find((c) => c.name === "evolution_audit");
    expect(auditCheck).toBeDefined();
    if (fileExists) {
      // File exists -- should be "pass" (valid) or "fail" (corrupt)
      expect(["pass", "fail"]).toContain(auditCheck?.status);
    } else {
      // File missing -- should be "warn", never "fail"
      expect(auditCheck?.status).toBe("warn");
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
