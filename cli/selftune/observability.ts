#!/usr/bin/env bun
/**
 * Observability and diagnosability surfaces for selftune.
 *
 * Provides:
 * - Structured health checks (doctor command)
 * - Log file integrity verification
 * - Hook installation checks
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR, REQUIRED_FIELDS } from "./constants.js";
import type { DoctorResult, HealthCheck, HealthStatus } from "./types.js";

const LOG_FILES: Record<string, string> = {
  session_telemetry: join(LOG_DIR, "session_telemetry_log.jsonl"),
  skill_usage: join(LOG_DIR, "skill_usage_log.jsonl"),
  all_queries: join(LOG_DIR, "all_queries_log.jsonl"),
  evolution_audit: join(LOG_DIR, "evolution_audit_log.jsonl"),
};

const HOOK_FILES = ["prompt-log.ts", "session-stop.ts", "skill-eval.ts"];

export function checkLogHealth(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  for (const [name, path] of Object.entries(LOG_FILES)) {
    const check: HealthCheck = { name: `log_${name}`, path, status: "pass", message: "" };

    if (!existsSync(path)) {
      check.status = "warn";
      check.message = "Log file does not exist yet (no sessions captured)";
    } else {
      let lineCount = 0;
      let parseErrors = 0;
      let schemaErrors = 0;
      const required = REQUIRED_FIELDS[name];

      const content = readFileSync(path, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineCount++;
        try {
          const record = JSON.parse(trimmed);
          const keys = new Set(Object.keys(record));
          for (const field of required) {
            if (!keys.has(field)) {
              schemaErrors++;
              break;
            }
          }
        } catch {
          parseErrors++;
        }
      }

      if (parseErrors > 0 || schemaErrors > 0) {
        check.status = "fail";
        check.message = `${lineCount} records, ${parseErrors} parse errors, ${schemaErrors} schema errors`;
      } else {
        check.status = "pass";
        check.message = `${lineCount} records, all valid`;
      }
    }

    checks.push(check);
  }

  return checks;
}

export function checkHookInstallation(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  for (const hook of HOOK_FILES) {
    const check: HealthCheck = { name: `hook_${hook}`, path: hook, status: "pass", message: "" };
    // Check if hook file exists relative to this module's directory
    const hookPath = join(import.meta.dir, "hooks", hook);
    if (existsSync(hookPath)) {
      check.status = "pass";
      check.message = "Hook file present";
    } else {
      check.status = "fail";
      check.message = "Hook file missing";
    }
    checks.push(check);
  }

  return checks;
}

export function checkEvolutionHealth(): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const auditPath = LOG_FILES.evolution_audit;
  const check: HealthCheck = {
    name: "evolution_audit",
    path: auditPath,
    status: "pass",
    message: "",
  };

  if (!existsSync(auditPath)) {
    check.status = "warn";
    check.message = "Evolution audit log does not exist yet (no evolution runs)";
  } else {
    let lineCount = 0;
    let parseErrors = 0;
    let schemaErrors = 0;
    const required = REQUIRED_FIELDS.evolution_audit;

    const content = readFileSync(auditPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineCount++;
      try {
        const record = JSON.parse(trimmed);
        const keys = new Set(Object.keys(record));
        for (const field of required) {
          if (!keys.has(field)) {
            schemaErrors++;
            break;
          }
        }
      } catch {
        parseErrors++;
      }
    }

    if (parseErrors > 0 || schemaErrors > 0) {
      check.status = "fail";
      check.message = `${lineCount} records, ${parseErrors} parse errors, ${schemaErrors} schema errors`;
    } else {
      check.status = "pass";
      check.message = `${lineCount} records, all valid`;
    }
  }

  checks.push(check);
  return checks;
}

export function doctor(): DoctorResult {
  const allChecks = [...checkLogHealth(), ...checkHookInstallation(), ...checkEvolutionHealth()];
  const passed = allChecks.filter((c) => c.status === "pass").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;
  const warned = allChecks.filter((c) => c.status === "warn").length;

  return {
    command: "doctor",
    timestamp: new Date().toISOString(),
    checks: allChecks,
    summary: { pass: passed, fail: failed, warn: warned, total: allChecks.length },
    healthy: failed === 0,
  };
}

if (import.meta.main) {
  const result = doctor();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.healthy ? 0 : 1);
}
