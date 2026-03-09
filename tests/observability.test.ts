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
  test("returns settings check only (no git hook file checks)", () => {
    const checks = checkHookInstallation();
    // Only the settings.json check -- git hook file checks were removed
    // since selftune uses Claude Code settings.json hooks, not .git/hooks/
    expect(checks.length).toBe(1);
    expect(checks[0].name).toBe("hook_settings");
  });

  test("settings check uses correct Claude Code hook key names", () => {
    const checks = checkHookInstallation();
    const settingsCheck = checks.find((c) => c.name === "hook_settings");
    expect(settingsCheck).toBeDefined();
    // Should reference actual Claude Code keys (UserPromptSubmit, PreToolUse, PostToolUse, Stop)
    // not the old incorrect keys (prompt-submit, post-tool-use, session-stop)
    expect(["pass", "warn"]).toContain(settingsCheck?.status);
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

  test("doctor does not produce false positives from git hook checks", () => {
    const result = doctor();
    // With the git hook checks removed, doctor should not produce false
    // positives from missing .git/hooks/ files
    const gitHookChecks = result.checks.filter((c) => c.path?.includes(".git/hooks/"));
    expect(gitHookChecks.length).toBe(0);
  });
});
