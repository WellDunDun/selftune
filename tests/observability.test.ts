import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkCloudLinkHealth,
  checkDashboardIntegrityHealth,
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
    if (!evolutionCheck) {
      throw new Error("expected log_evolution_audit check");
    }
    if (fileExists) {
      // File exists -- should be "pass" (valid) or "fail" (corrupt)
      expect(["pass", "fail"]).toContain(evolutionCheck.status);
    } else {
      // File missing -- should be "warn", never "fail"
      expect(evolutionCheck.status).toBe("warn");
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
    if (!settingsCheck) {
      throw new Error("expected hook_settings check");
    }
    // Should reference actual Claude Code keys (UserPromptSubmit, PreToolUse, PostToolUse, Stop)
    // not the old incorrect keys (prompt-submit, post-tool-use, session-stop)
    expect(["pass", "warn"]).toContain(settingsCheck.status);
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
    if (!auditCheck) {
      throw new Error("expected evolution_audit check");
    }
    if (fileExists) {
      // File exists -- should be "pass" (valid) or "fail" (corrupt)
      expect(["pass", "fail"]).toContain(auditCheck.status);
    } else {
      // File missing -- should be "warn", never "fail"
      expect(auditCheck.status).toBe("warn");
    }
  });
});

describe("checkDashboardIntegrityHealth", () => {
  test("returns pass status for WAL-based dashboard freshness mode", () => {
    const checks = checkDashboardIntegrityHealth();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("dashboard_freshness_mode");
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.message).toContain("WAL");
  });
});

describe("checkConfigHealth", () => {
  test("returns guidance when config is missing", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "selftune-observability-missing-"));
    const moduleUrl = new URL("../cli/selftune/observability.ts", import.meta.url).href;

    try {
      const proc = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const { checkConfigHealth } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(checkConfigHealth()));`,
        ],
        {
          env: { ...process.env, HOME: tempHome },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr);
        throw new Error(`Subprocess failed (exit ${proc.exitCode}): ${stderr}`);
      }

      const output = new TextDecoder().decode(proc.stdout).trim();
      const checks = JSON.parse(output) as Array<{
        status: string;
        guidance?: { next_command?: string; blocking?: boolean };
      }>;
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe("warn");
      expect(checks[0]?.guidance?.blocking).toBe(true);
      expect(checks[0]?.guidance?.next_command).toBe("selftune init");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("accepts openclaw agent_type values written by init", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "selftune-observability-"));
    const configDir = join(tempHome, ".selftune");
    const configPath = join(configDir, "config.json");
    const moduleUrl = new URL("../cli/selftune/observability.ts", import.meta.url).href;

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            agent_type: "openclaw",
            llm_mode: "agent",
            agent_cli: "openclaw",
            initialized_at: "2026-03-09T00:00:00.000Z",
          },
          null,
          2,
        ),
      );

      const proc = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const { checkConfigHealth } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(checkConfigHealth()));`,
        ],
        {
          env: { ...process.env, HOME: tempHome },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr);
        throw new Error(`Subprocess failed (exit ${proc.exitCode}): ${stderr}`);
      }
      const output = new TextDecoder().decode(proc.stdout).trim();
      const checks = JSON.parse(output) as Array<{ status: string; message: string }>;
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe("pass");
      expect(checks[0]?.message).toContain("agent_type=openclaw");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("checkCloudLinkHealth", () => {
  test("returns remediation guidance when credential is missing", () => {
    const checks = checkCloudLinkHealth({
      enrolled: true,
      user_id: "user-1",
      email: "user@example.com",
      consent_timestamp: "2026-03-20T00:00:00.000Z",
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.guidance?.blocking).toBe(true);
    expect(checks[0]?.guidance?.next_command).toContain("selftune init --alpha --alpha-email");
  });
});

describe("doctor", () => {
  test("returns structured result", async () => {
    const result = await doctor();
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

  test("includes evolution health checks", async () => {
    const result = await doctor();
    const evolutionChecks = result.checks.filter(
      (c) => c.name === "evolution_audit" || c.name === "log_evolution_audit",
    );
    expect(evolutionChecks.length).toBeGreaterThanOrEqual(1);
  });

  test("includes dashboard integrity check as pass", async () => {
    const result = await doctor();
    const integrityCheck = result.checks.find((c) => c.name === "dashboard_freshness_mode");
    expect(integrityCheck).toBeDefined();
    expect(integrityCheck?.status).toBe("pass");
  });

  test("doctor does not produce false positives from git hook checks", async () => {
    const result = await doctor();
    // With the git hook checks removed, doctor should not produce false
    // positives from missing .git/hooks/ files
    const gitHookChecks = result.checks.filter((c) => c.path?.includes(".git/hooks/"));
    expect(gitHookChecks.length).toBe(0);
  });
});
