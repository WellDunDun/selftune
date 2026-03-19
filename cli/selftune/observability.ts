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
import { homedir } from "node:os";
import { join } from "node:path";
import { LOG_DIR, REQUIRED_FIELDS, SELFTUNE_CONFIG_PATH } from "./constants.js";
import { DB_PATH } from "./localdb/db.js";
import type { DoctorResult, HealthCheck, HealthStatus, SelftuneConfig } from "./types.js";
import { missingClaudeCodeHookKeys } from "./utils/hooks.js";

const VALID_AGENT_TYPES = new Set(["claude_code", "codex", "opencode", "openclaw", "unknown"]);
const VALID_LLM_MODES = new Set(["agent"]);

const LOG_FILES: Record<string, string> = {
  session_telemetry: join(LOG_DIR, "session_telemetry_log.jsonl"),
  skill_usage: join(LOG_DIR, "skill_usage_log.jsonl"),
  all_queries: join(LOG_DIR, "all_queries_log.jsonl"),
  evolution_audit: join(LOG_DIR, "evolution_audit_log.jsonl"),
};

/**
 * Maximum number of lines to validate in a JSONL health check.
 * Large log files (60k+ lines) can take many seconds to fully parse,
 * so we sample the first N lines for the health check.
 */
const MAX_VALIDATION_LINES = 500;

/**
 * Validate a JSONL file: parse each line as JSON and check that all
 * `requiredFields` are present.  Returns a status/message pair suitable
 * for embedding in a {@link HealthCheck}.
 *
 * For performance, only the first {@link MAX_VALIDATION_LINES} non-blank
 * lines are validated.  The total line count still reflects the full file.
 */
function validateJsonlFile(
  filePath: string,
  requiredFields: Set<string>,
): { status: HealthStatus; message: string } {
  let lineCount = 0;
  let parseErrors = 0;
  let schemaErrors = 0;
  let validatedCount = 0;

  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineCount++;
    if (validatedCount >= MAX_VALIDATION_LINES) continue;
    validatedCount++;
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
      message: `${lineCount} records (${validatedCount} validated), ${parseErrors} parse errors, ${schemaErrors} schema errors`,
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

  // Check if hooks are configured in Claude Code settings.json
  // Claude Code uses hook keys: UserPromptSubmit, PreToolUse, PostToolUse, Stop
  // (not the old kebab-case names like prompt-submit, post-tool-use, session-stop)
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
        const missing = missingClaudeCodeHookKeys(hooks as Record<string, unknown>);
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

export function checkDashboardIntegrityHealth(): HealthCheck[] {
  const check: HealthCheck = {
    name: "dashboard_freshness_mode",
    path: DB_PATH,
    status: "warn",
    message:
      "Dashboard reads SQLite, but live refresh still relies on JSONL watcher invalidation instead of SQLite WAL. Expect freshness gaps for SQLite-only writes and export before destructive recovery.",
  };

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

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b, 0 if equal, 1 if a > b.
 * Handles standard x.y.z versions; pre-release tags are not compared.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** Check if the installed version is the latest on npm. Non-blocking, warns on stale. */
export async function checkVersionHealth(): Promise<HealthCheck[]> {
  const check: HealthCheck = {
    name: "version_up_to_date",
    path: "package.json",
    status: "pass",
    message: "",
  };

  try {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const currentVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch("https://registry.npmjs.org/selftune/latest", {
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as { version: string };
        const latestVersion = data.version;
        const cmp = compareSemver(currentVersion, latestVersion);
        if (cmp >= 0) {
          check.message = `v${currentVersion} (latest)`;
        } else {
          check.status = "warn";
          check.message = `v${currentVersion} installed, v${latestVersion} available. Run: npx skills add selftune-dev/selftune`;
        }
      } else {
        check.message = `v${currentVersion} (unable to check npm registry)`;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    check.message = "Unable to check latest version (network unavailable)";
  }

  return [check];
}

// ---------------------------------------------------------------------------
// Alpha upload queue health checks
// ---------------------------------------------------------------------------

const ALPHA_STUCK_THRESHOLD_SECONDS = 3600; // 1 hour
const ALPHA_FAILURE_THRESHOLD = 50;

export interface AlphaQueueCheckOptions {
  stuckThresholdSeconds?: number;
  failureThreshold?: number;
}

/**
 * Check alpha upload queue health.
 * Returns empty array when not enrolled (checks are skipped).
 */
export async function checkAlphaQueueHealth(
  db: import("bun:sqlite").Database,
  enrolled: boolean,
  opts?: AlphaQueueCheckOptions,
): Promise<HealthCheck[]> {
  if (!enrolled) return [];

  const { getQueueStats } = await import("./alpha-upload/queue.js");
  const { getOldestPendingAge } = await import("./localdb/queries.js");

  const checks: HealthCheck[] = [];
  const stuckThreshold = opts?.stuckThresholdSeconds ?? ALPHA_STUCK_THRESHOLD_SECONDS;
  const failureThreshold = opts?.failureThreshold ?? ALPHA_FAILURE_THRESHOLD;

  // Check for stuck pending items
  const stuckCheck: HealthCheck = {
    name: "alpha_queue_stuck",
    path: "upload_queue",
    status: "pass",
    message: "",
  };

  const oldestAge = getOldestPendingAge(db);
  if (oldestAge !== null && oldestAge > stuckThreshold) {
    stuckCheck.status = "warn";
    const hours = Math.floor(oldestAge / 3600);
    const minutes = Math.floor((oldestAge % 3600) / 60);
    stuckCheck.message = `Oldest pending upload is ${hours}h ${minutes}m old (threshold: ${Math.floor(stuckThreshold / 3600)}h)`;
  } else {
    stuckCheck.message =
      oldestAge !== null
        ? `Oldest pending item: ${Math.floor(oldestAge / 60)}m old`
        : "No pending items";
  }
  checks.push(stuckCheck);

  // Check for excessive failures
  const failCheck: HealthCheck = {
    name: "alpha_queue_failures",
    path: "upload_queue",
    status: "pass",
    message: "",
  };

  const stats = getQueueStats(db);
  if (stats.failed > failureThreshold) {
    failCheck.status = "warn";
    failCheck.message = `${stats.failed} failed uploads (threshold: ${failureThreshold})`;
  } else {
    failCheck.message = `${stats.failed} failed uploads`;
  }
  checks.push(failCheck);

  return checks;
}

export function checkSkillVersionSync(): HealthCheck[] {
  const check: HealthCheck = {
    name: "skill_version_sync",
    path: "skill/SKILL.md",
    status: "pass",
    message: "",
  };

  try {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkgVersion: string = JSON.parse(readFileSync(pkgPath, "utf-8")).version;

    const skillPath = join(import.meta.dir, "../../skill/SKILL.md");
    if (!existsSync(skillPath)) {
      check.status = "warn";
      check.message = "skill/SKILL.md not found (may be running from installed package)";
      return [check];
    }

    const skillContent = readFileSync(skillPath, "utf-8");
    const versionMatch = skillContent.match(/^\s*version:\s*(.+)$/m);
    if (!versionMatch) {
      check.status = "warn";
      check.message = "No version field found in SKILL.md frontmatter";
      return [check];
    }

    const skillVersion = versionMatch[1].trim();
    if (skillVersion === pkgVersion) {
      check.message = `v${pkgVersion} (in sync)`;
    } else {
      check.status = "warn";
      check.message = `SKILL.md has v${skillVersion} but package.json has v${pkgVersion}. Run: bun run sync-version`;
    }
  } catch {
    check.status = "warn";
    check.message = "Unable to compare versions";
  }

  return [check];
}

export async function doctor(): Promise<DoctorResult> {
  const allChecks = [
    ...checkConfigHealth(),
    ...checkLogHealth(),
    ...checkHookInstallation(),
    ...checkEvolutionHealth(),
    ...checkDashboardIntegrityHealth(),
    ...checkSkillVersionSync(),
    ...(await checkVersionHealth()),
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
  const result = await doctor();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.healthy ? 0 : 1);
}
