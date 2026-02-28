#!/usr/bin/env bun
/**
 * Observability and diagnosability surfaces for selftune.
 *
 * Provides:
 * - Structured health checks (doctor command)
 * - Log file integrity verification
 * - Hook installation checks
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOG_DIR, REQUIRED_FIELDS, SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { DoctorResult, HealthCheck, HealthStatus, SelftuneConfig } from "./types.js";

const VALID_AGENT_TYPES = new Set(["claude_code", "codex", "opencode", "unknown"]);
const VALID_LLM_MODES = new Set(["agent", "api"]);

const LOG_FILES: Record<string, string> = {
  session_telemetry: join(LOG_DIR, "session_telemetry_log.jsonl"),
  skill_usage: join(LOG_DIR, "skill_usage_log.jsonl"),
  all_queries: join(LOG_DIR, "all_queries_log.jsonl"),
  evolution_audit: join(LOG_DIR, "evolution_audit_log.jsonl"),
};

const HOOK_FILES = ["prompt-log.ts", "session-stop.ts", "skill-eval.ts"];

/**
 * Validate a JSONL file: parse each line as JSON and check that all
 * `requiredFields` are present.  Returns a status/message pair suitable
 * for embedding in a {@link HealthCheck}.
 */
function validateJsonlFile(
  filePath: string,
  requiredFields: Set<string>,
): { status: HealthStatus; message: string } {
  let lineCount = 0;
  let parseErrors = 0;
  let schemaErrors = 0;

  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineCount++;
    try {
      const record = JSON.parse(trimmed);
      const keys = new Set(Object.keys(record));
      for (const field of requiredFields) {
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
    return {
      status: "fail",
      message: `${lineCount} records, ${parseErrors} parse errors, ${schemaErrors} schema errors`,
    };
  }
  return { status: "pass", message: `${lineCount} records, all valid` };
}

export function checkLogHealth(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  for (const [name, path] of Object.entries(LOG_FILES)) {
    const check: HealthCheck = { name: `log_${name}`, path, status: "pass", message: "" };

    if (!existsSync(path)) {
      check.status = "warn";
      check.message = "Log file does not exist yet (no sessions captured)";
    } else {
      const result = validateJsonlFile(path, REQUIRED_FIELDS[name]);
      check.status = result.status;
      check.message = result.message;
    }

    checks.push(check);
  }

  return checks;
}

export function checkHookInstallation(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // Resolve the repository root so we check the actual active hooks, not bundled source files
  let repoRoot: string;
  try {
    repoRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    // Not inside a git repo -- fall back to cwd
    repoRoot = process.cwd();
  }

  for (const hook of HOOK_FILES) {
    const hookPath = join(repoRoot, ".git", "hooks", hook);
    const check: HealthCheck = {
      name: `hook_${hook}`,
      path: hookPath,
      status: "pass",
      message: "",
    };
    if (existsSync(hookPath)) {
      check.status = "pass";
      check.message = "Hook file present";
    } else {
      check.status = "fail";
      check.message = "Hook file missing";
    }
    checks.push(check);
  }

  // Also check if hooks are configured in Claude Code settings
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settingsCheck: HealthCheck = {
    name: "hook_settings",
    path: settingsPath,
    status: "pass",
    message: "",
  };
  if (!existsSync(settingsPath)) {
    settingsCheck.status = "warn";
    settingsCheck.message = "Claude Code settings.json not found";
  } else {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      const hooks = settings?.hooks;
      if (!hooks || typeof hooks !== "object") {
        settingsCheck.status = "warn";
        settingsCheck.message = "No hooks section in settings.json";
      } else {
        const hookKeys = ["prompt-submit", "post-tool-use", "session-stop"];
        const missing = hookKeys.filter((k) => {
          const entries = hooks[k];
          if (!Array.isArray(entries) || entries.length === 0) return true;
          return !entries.some(
            (e: { command?: string }) =>
              typeof e.command === "string" && e.command.includes("selftune"),
          );
        });
        if (missing.length > 0) {
          settingsCheck.status = "warn";
          settingsCheck.message = `Selftune hooks not configured for: ${missing.join(", ")}`;
        } else {
          settingsCheck.status = "pass";
          settingsCheck.message = "All selftune hooks configured in settings.json";
        }
      }
    } catch {
      settingsCheck.status = "warn";
      settingsCheck.message = "Could not parse settings.json";
    }
  }
  checks.push(settingsCheck);

  return checks;
}

export function checkEvolutionHealth(): HealthCheck[] {
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
    const result = validateJsonlFile(auditPath, REQUIRED_FIELDS.evolution_audit);
    check.status = result.status;
    check.message = result.message;
  }

  return [check];
}

export function checkConfigHealth(): HealthCheck[] {
  const check: HealthCheck = {
    name: "config",
    path: SELFTUNE_CONFIG_PATH,
    status: "pass",
    message: "",
  };

  if (!existsSync(SELFTUNE_CONFIG_PATH)) {
    check.status = "warn";
    check.message = "Config not found. Run 'selftune init' to bootstrap.";
  } else {
    try {
      const raw = readFileSync(SELFTUNE_CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw) as SelftuneConfig;
      const errors: string[] = [];
      if (!config.agent_type || !VALID_AGENT_TYPES.has(config.agent_type)) {
        errors.push(`invalid agent_type: ${JSON.stringify(config.agent_type)}`);
      }
      if (!config.llm_mode || !VALID_LLM_MODES.has(config.llm_mode)) {
        errors.push(`invalid llm_mode: ${JSON.stringify(config.llm_mode)}`);
      }
      if (errors.length > 0) {
        check.status = "fail";
        check.message = errors.join("; ");
      } else {
        check.status = "pass";
        check.message = `agent_type=${config.agent_type}, llm_mode=${config.llm_mode}`;
      }
    } catch {
      check.status = "fail";
      check.message = "Config file exists but is not valid JSON";
    }
  }

  return [check];
}

export function doctor(): DoctorResult {
  const allChecks = [
    ...checkConfigHealth(),
    ...checkLogHealth(),
    ...checkHookInstallation(),
    ...checkEvolutionHealth(),
  ];
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
