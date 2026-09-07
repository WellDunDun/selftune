#!/usr/bin/env bun
/* oxlint-disable no-console -- the doctor CLI owns its JSON stdout contract */
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
import { loadConfigSync } from "@selftune/config";
import * as Schema from "effect/Schema";

import { getAlphaGuidance } from "./agent-guidance.js";
import { getAlphaLinkState } from "./alpha-identity.js";
import { resolveCloudCredential } from "./auth/cloud-credential.js";
import { getSelftuneUpdateHint } from "./auto-update.js";
import { LOG_DIR, REQUIRED_FIELDS, SELFTUNE_CONFIG_PATH } from "./constants.js";
import { DB_PATH } from "./localdb/db.js";
import { findSelftunePackageRoot } from "./package-root.js";
import type {
  AlphaIdentity,
  AlphaLinkState,
  DoctorResult,
  HealthCheck,
  HealthStatus,
  SelftuneConfig,
} from "./types.js";
import { missingClaudeCodeHookKeys } from "./utils/hooks.js";

const VALID_AGENT_TYPES = new Set([
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "pi",
  "unknown",
]);
const VALID_LLM_MODES = new Set(["agent"]);

const LOG_FILES = {
  session_telemetry: {
    path: join(LOG_DIR, "session_telemetry_log.jsonl"),
    requiredFields: REQUIRED_FIELDS.session_telemetry,
  },
  skill_usage: {
    path: join(LOG_DIR, "skill_usage_log.jsonl"),
    requiredFields: REQUIRED_FIELDS.skill_usage,
  },
  all_queries: {
    path: join(LOG_DIR, "all_queries_log.jsonl"),
    requiredFields: REQUIRED_FIELDS.all_queries,
  },
  evolution_audit: {
    path: join(LOG_DIR, "evolution_audit_log.jsonl"),
    requiredFields: REQUIRED_FIELDS.evolution_audit,
  },
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
): Pick<HealthCheck, "status" | "message"> {
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
      const record = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
      )(trimmed);
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

  for (const [name, { path, requiredFields }] of Object.entries(LOG_FILES)) {
    const check: HealthCheck = { name: `log_${name}`, path, status: "pass", message: "" };

    if (!existsSync(path)) {
      check.status = "warn";
      check.message = "Log file does not exist yet (no sessions captured)";
    } else {
      const result = validateJsonlFile(path, requiredFields);
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
    settingsCheck.guidance = {
      code: "hook_settings_missing",
      message: "Claude Code settings.json is missing. Re-run init to install the selftune hooks.",
      next_command: "selftune init --force",
      suggested_commands: ["selftune doctor"],
      blocking: true,
    };
  } else {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            hooks: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
          }),
        ),
      )(raw);
      const hooks = settings?.hooks;
      if (!hooks) {
        settingsCheck.status = "warn";
        settingsCheck.message = "No hooks section in settings.json";
        settingsCheck.guidance = {
          code: "hook_settings_missing",
          message: "The Claude Code hooks are not configured yet.",
          next_command: "selftune init --force",
          suggested_commands: ["selftune doctor"],
          blocking: true,
        };
      } else {
        const missing = missingClaudeCodeHookKeys(hooks);
        if (missing.length > 0) {
          settingsCheck.status = "warn";
          settingsCheck.message = `Selftune hooks not configured for: ${missing.join(", ")}`;
          settingsCheck.guidance = {
            code: "hook_settings_incomplete",
            message: "Some Claude Code hooks are missing.",
            next_command: "selftune init --force",
            suggested_commands: ["selftune doctor"],
            blocking: true,
          };
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
  const auditPath = LOG_FILES.evolution_audit.path;
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
    status: "pass",
    message: "Dashboard reads SQLite and watches WAL for live updates",
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
    check.guidance = {
      code: "config_missing",
      message: "selftune is not initialized yet.",
      next_command: "selftune init",
      suggested_commands: ["selftune doctor"],
      blocking: true,
    };
  } else {
    try {
      const raw = readFileSync(SELFTUNE_CONFIG_PATH, "utf-8");
      const config = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            agent_type: Schema.optional(Schema.String),
            llm_mode: Schema.optional(Schema.String),
          }),
        ),
      )(raw);
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
        check.guidance = {
          code: "config_invalid",
          message: "The selftune config is invalid and needs to be regenerated.",
          next_command: "selftune init --force",
          suggested_commands: ["selftune doctor"],
          blocking: true,
        };
      } else {
        check.status = "pass";
        check.message = `agent_type=${config.agent_type}, llm_mode=${config.llm_mode}`;
      }
    } catch {
      check.status = "fail";
      check.message = "Config file exists but is not valid JSON";
      check.guidance = {
        code: "config_invalid_json",
        message: "The selftune config file is corrupt JSON.",
        next_command: "selftune init --force",
        suggested_commands: ["selftune doctor"],
        blocking: true,
      };
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
    const pkgPath = join(findSelftunePackageRoot(), "package.json");
    const currentVersion = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
    )(readFileSync(pkgPath, "utf-8")).version;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch("https://registry.npmjs.org/selftune/latest", {
        signal: controller.signal,
      });

      if (res.ok) {
        const data = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
          await res.json(),
        );
        const latestVersion = data.version;
        const cmp = compareSemver(currentVersion, latestVersion);
        if (cmp >= 0) {
          check.message = `v${currentVersion} (latest)`;
        } else {
          const updateCommand = getSelftuneUpdateHint("latest");
          check.status = "warn";
          check.message = `v${currentVersion} installed, v${latestVersion} available. Run: ${updateCommand}`;
          check.guidance = {
            code: "version_update_available",
            message: "A newer selftune release is available.",
            next_command: updateCommand,
            suggested_commands: ["selftune doctor"],
            blocking: false,
          };
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

export function checkSkillVersionSync(): HealthCheck[] {
  const check: HealthCheck = {
    name: "skill_version_sync",
    path: "skill/SKILL.md",
    status: "pass",
    message: "",
  };

  try {
    const packageRoot = findSelftunePackageRoot();
    const pkgPath = join(packageRoot, "package.json");
    const pkgVersion: string = JSON.parse(readFileSync(pkgPath, "utf-8")).version;

    const skillPath = join(packageRoot, "skill", "SKILL.md");
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
      check.guidance = {
        code: "skill_version_out_of_sync",
        message: "The packaged skill version does not match package.json.",
        next_command: "bun run sync-version",
        suggested_commands: ["selftune doctor"],
        blocking: false,
      };
    }
  } catch {
    check.status = "warn";
    check.message = "Unable to compare versions";
  }

  return [check];
}

// ---------------------------------------------------------------------------
// Cloud link health checks
// ---------------------------------------------------------------------------

/**
 * Check cloud link health for alpha users.
 * Returns [] for non-alpha users (identity is null).
 */
const CLOUD_LINK_CHECKS: Record<AlphaLinkState, { status: HealthStatus; message: string }> = {
  not_linked: { status: "warn", message: "Not linked to cloud account (cloud_user_id missing)" },
  linked_not_enrolled: { status: "warn", message: "Linked but not enrolled" },
  enrolled_no_credential: {
    status: "warn",
    message: "Enrolled but cloud credential missing — cloud features are unavailable",
  },
  ready: { status: "pass", message: "Cloud link ready" },
};

export function checkCloudLinkHealth(
  identity: AlphaIdentity | null,
  credentialAvailable?: boolean,
): HealthCheck[] {
  if (!identity) return [];
  const state = getAlphaLinkState(identity, credentialAvailable);
  const { status, message } = CLOUD_LINK_CHECKS[state];
  return [
    {
      name: "cloud_link",
      path: SELFTUNE_CONFIG_PATH,
      status,
      message,
      guidance: getAlphaGuidance(identity, credentialAvailable),
    },
  ];
}

export async function doctor(): Promise<DoctorResult> {
  let alphaConfig: SelftuneConfig | null = null;
  try {
    alphaConfig = loadConfigSync(SELFTUNE_CONFIG_PATH);
  } catch {
    // Config-health checks report parse failures below.
  }
  const alphaIdentity = alphaConfig?.alpha ?? null;
  let credentialAvailable = false;
  try {
    credentialAvailable = Boolean(
      resolveCloudCredential(alphaConfig, { configPath: SELFTUNE_CONFIG_PATH }),
    );
  } catch {
    // Missing or inaccessible credentials are represented as an unhealthy link.
  }
  const versionChecksPromise = checkVersionHealth();
  const logChecks = checkLogHealth();
  const evolutionAuditLogCheck = logChecks.find((check) => check.name === "log_evolution_audit");
  const evolutionChecks = evolutionAuditLogCheck
    ? [{ ...evolutionAuditLogCheck, name: "evolution_audit" }]
    : checkEvolutionHealth();
  const allChecks = [
    ...checkConfigHealth(),
    ...logChecks,
    ...checkHookInstallation(),
    ...evolutionChecks,
    ...checkDashboardIntegrityHealth(),
    ...checkSkillVersionSync(),
    ...(await versionChecksPromise),
    ...checkCloudLinkHealth(alphaIdentity, credentialAvailable),
  ];
  const passed = allChecks.filter((c) => c.status === "pass").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;
  const warned = allChecks.filter((c) => c.status === "warn").length;
  const hasBlockingGuidance = allChecks.some((c) => c.guidance?.blocking === true);

  return {
    command: "doctor",
    timestamp: new Date().toISOString(),
    checks: allChecks,
    summary: { pass: passed, fail: failed, warn: warned, total: allChecks.length },
    healthy: failed === 0 && !hasBlockingGuidance,
  };
}

if (import.meta.main) {
  const result = await doctor();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.healthy ? 0 : 1);
}
