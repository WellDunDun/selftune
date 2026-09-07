#!/usr/bin/env bun
/* oxlint-disable no-console -- the CLI adapter owns the established JSON stdout/stderr contract */
/**
 * selftune init — Bootstrap agent identity and write config.
 *
 * Detects the coding agent environment, resolves the CLI path,
 * determines LLM mode, checks hook installation, and writes
 * the result to ~/.selftune/config.json.
 *
 * Usage:
 *   selftune init [--agent <type>] [--cli-path <path>] [--force]
 *   selftune init [--no-sync] [--no-autonomy] [--schedule-format cron|launchd|systemd]
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfigSync } from "@selftune/config";
import type { SourceSyncRunner, SyncResult } from "@selftune/source-management/sync";
import { checkAlphaReadiness } from "@selftune/runtime/init";
import { ALPHA_CONSENT_NOTICE, readAlphaIdentity } from "@selftune/runtime/alpha-identity";
import { TELEMETRY_NOTICE } from "@selftune/runtime/analytics";
import {
  hasCloudCredentialMetadata,
  resolveCloudCredential,
} from "@selftune/runtime/auth/cloud-credential";
import { tryOpenUrl } from "@selftune/runtime/auth/device-code";
import { SELFTUNE_CONFIG_DIR, SELFTUNE_CONFIG_PATH } from "@selftune/runtime/constants";
import type { PlatformCredentialStore } from "@selftune/runtime/credential-store";
import { checkClaudeCodeHooks } from "@selftune/runtime/init/claude-hooks";
import {
  agentTypeToCli,
  detectAgentType,
  determineCliPath,
  determineLlmMode,
} from "@selftune/runtime/init/environment";
import { detectWorkspaceType } from "@selftune/runtime/init/workspace";
import type { AgentCommandGuidance, SelftuneConfig } from "@selftune/runtime/types";
import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";
import { detectAgent } from "@selftune/runtime/utils/llm-call";

import { liveSourceSyncRunner } from "./source-sync-live.js";
import {
  createDefaultCliSetupCapabilities,
  type ScheduleInstallOutcome,
} from "./setup/capabilities.js";
import { convergeSetup } from "./setup/converge.js";
import { inspectSetupState } from "./setup/inspect.js";
import { defaultSetupPlan } from "./setup/plan.js";
import { linkCloudAccount, type DeviceCodeTransport } from "./setup/link-account.js";

interface InitCliErrorPayload extends AgentCommandGuidance {
  error: string;
}

class InitCliError extends Error {
  payload: InitCliErrorPayload;

  constructor(payload: InitCliErrorPayload) {
    super(payload.message);
    this.name = "InitCliError";
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Init options (for testability)
// ---------------------------------------------------------------------------

export interface InitOptions {
  configDir: string;
  configPath: string;
  force: boolean;
  agentOverride?: string;
  cliPathOverride?: string;
  homeDir?: string;
  alpha?: boolean;
  noAlpha?: boolean;
  alphaEmail?: string;
  alphaName?: string;
  credentialStore?: PlatformCredentialStore;
  deviceCodeTransport?: DeviceCodeTransport;
}

function validateAlphaMetadataFlags(
  alpha: boolean | undefined,
  email?: string,
  name?: string,
): void {
  if ((email !== undefined || name !== undefined) && !alpha) {
    throw new Error("--alpha-email and --alpha-name require --alpha");
  }
}

// ---------------------------------------------------------------------------
// Core init logic
// ---------------------------------------------------------------------------

/**
 * Run the init flow. Returns the written (or existing) config.
 * Extracted as a pure function for testability.
 */
export async function runInit(opts: InitOptions): Promise<SelftuneConfig> {
  const { configDir, configPath, force } = opts;
  validateAlphaMetadataFlags(opts.alpha, opts.alphaEmail, opts.alphaName);

  // If config exists and no --force (and no alpha mutation), return existing
  const hasAlphaMutation =
    opts.alpha || opts.noAlpha || opts.alphaEmail !== undefined || opts.alphaName !== undefined;
  if (!force && !hasAlphaMutation && existsSync(configPath)) {
    try {
      let existingConfig = loadConfigSync(configPath);
      if (!existingConfig) throw new Error("Configuration is missing or invalid.");
      if (hasCloudCredentialMetadata(existingConfig.alpha ?? null)) {
        const decodedConfig = loadConfigSync(configPath);
        resolveCloudCredential(decodedConfig, {
          configPath,
          configRoot: configDir,
          credentialStore: opts.credentialStore,
        });
        existingConfig = loadConfigSync(configPath) ?? existingConfig;
      }
      if (existingConfig.agent_type === "claude_code") {
        await convergeSetup(
          defaultSetupPlan({ agentFiles: true, writeConfig: false }),
          createDefaultCliSetupCapabilities({ homeDir: opts.homeDir }),
          { configDir, configPath, homeDir: opts.homeDir },
        );
      }
      return existingConfig;
    } catch (err) {
      throw new Error(
        `Config file at ${configPath} contains invalid JSON. Delete it or use --force to reinitialize. Cause: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Capture existing alpha identity before overwriting config (for user_id preservation)
  let existingAlphaBeforeOverwrite = readAlphaIdentity(configPath);
  if (existingAlphaBeforeOverwrite) {
    try {
      const existingConfig = loadConfigSync(configPath);
      resolveCloudCredential(existingConfig, {
        configPath,
        configRoot: configDir,
        credentialStore: opts.credentialStore,
      });
      existingAlphaBeforeOverwrite =
        loadConfigSync(configPath)?.alpha ?? existingAlphaBeforeOverwrite;
    } catch {
      // Force-init still replaces corrupt configuration through the convergence step below.
    }
  }

  // Detect agent type
  const agentType = detectAgentType(opts.agentOverride, opts.homeDir);

  // Resolve CLI path
  const cliPath = determineCliPath(opts.cliPathOverride);

  // Detect agent CLI — when an override is provided, fall back to mapped CLI
  // name so init works in test/CI environments without agent binaries in PATH
  const agentCli = detectAgent() ?? (opts.agentOverride ? agentTypeToCli(agentType) : null);
  if (!agentCli) {
    throw new Error(
      "No supported agent CLI detected (claude, codex, opencode). Install one, then rerun `selftune init`.",
    );
  }

  // Determine LLM mode
  const { llm_mode, agent_cli } = determineLlmMode(agentCli);

  // Check hooks (Claude Code only)
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, ".claude", "settings.json");
  const hooksInstalled = agentType === "claude_code" ? checkClaudeCodeHooks(settingsPath) : false;

  let config: SelftuneConfig = {
    agent_type: agentType,
    cli_path: cliPath,
    llm_mode,
    agent_cli,
    hooks_installed: hooksInstalled,
    initialized_at: new Date().toISOString(),
  };

  if (existingAlphaBeforeOverwrite && !opts.alpha && !opts.noAlpha) {
    config.alpha = existingAlphaBeforeOverwrite;
  }

  if (opts.noAlpha) {
    if (existingAlphaBeforeOverwrite) {
      config.alpha = {
        ...existingAlphaBeforeOverwrite,
        enrolled: false,
      };
    }
  }

  let linkedAccount = false;
  if (opts.alpha) {
    process.stderr.write("[alpha] Starting device-code authentication flow...\n");
    const linked = await linkCloudAccount(
      {
        configPath,
        config,
        email: opts.alphaEmail,
        displayName: opts.alphaName,
      },
      {
        credentialStore: opts.credentialStore,
        transport: opts.deviceCodeTransport,
        events: {
          deviceCodeIssued: (grant, verificationUrlWithCode) => {
            console.log(
              JSON.stringify({
                level: "info",
                code: "device_code_issued",
                verification_url: grant.verification_url,
                verification_url_with_code: verificationUrlWithCode,
                user_code: grant.user_code,
                expires_in: grant.expires_in,
                message: `Open ${verificationUrlWithCode} to approve.`,
              }),
            );
          },
          pollingStarted: (_grant, verificationUrlWithCode) => {
            if (!process.env.BUN_ENV?.includes("test") && !process.env.SELFTUNE_NO_BROWSER) {
              if (tryOpenUrl(verificationUrlWithCode)) {
                process.stderr.write(`[alpha] Browser opened. Waiting for approval...\n`);
              } else {
                process.stderr.write(
                  `[alpha] Could not open browser. Visit ${verificationUrlWithCode} manually.\n`,
                );
              }
            } else {
              process.stderr.write(`[alpha] Visit ${verificationUrlWithCode} to approve.\n`);
            }
            process.stderr.write("[alpha] Polling");
          },
          approved: () => {
            process.stderr.write("\n[alpha] Approved!\n");
          },
        },
      },
    );
    config = linked.config;
    linkedAccount = true;
  }

  const setupResults = await convergeSetup(
    defaultSetupPlan({
      agentOverride: opts.agentOverride,
      cliPathOverride: opts.cliPathOverride,
      config,
      force,
      agentFiles: agentType === "claude_code",
      hookHarnesses: agentType === "claude_code" ? ["claude_code"] : [],
    }),
    createDefaultCliSetupCapabilities({ homeDir: home }),
    { configDir, configPath, homeDir: home },
  );
  const configStep = setupResults.find((result) => result.step === "config");
  if (configStep?.status === "failed") {
    throw new Error(configStep.message ?? `Failed to write config at ${configPath}.`);
  }
  for (const result of setupResults) {
    if (
      result.status === "applied" &&
      (result.step === "agent_files" || result.step === "hooks:claude_code") &&
      result.message
    ) {
      console.error(result.message);
    }
  }

  const writtenConfig = loadConfigSync(configPath);
  if (!writtenConfig) throw new Error(`Configuration at ${configPath} was not written correctly.`);
  if (linkedAccount) {
    const readiness = checkAlphaReadiness(configPath, {
      credentialStore: opts.credentialStore,
      configRoot: configDir,
    });
    console.error(JSON.stringify({ alpha_readiness: readiness }));
  }

  return writtenConfig;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(sourceSync: SourceSyncRunner = liveSourceSyncRunner): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      "cli-path": { type: "string" },
      force: { type: "boolean", default: false },
      "enable-autonomy": { type: "boolean", default: false },
      "no-sync": { type: "boolean", default: false },
      "no-autonomy": { type: "boolean", default: false },
      "schedule-format": { type: "string" },
      alpha: { type: "boolean", default: false },
      "no-alpha": { type: "boolean", default: false },
      "alpha-email": { type: "string" },
      "alpha-name": { type: "string" },
    },
    strict: true,
  });

  const configDir = SELFTUNE_CONFIG_DIR;
  const configPath = SELFTUNE_CONFIG_PATH;
  const force = values.force ?? false;
  // Sync and autonomy are on by default; opt out with --no-sync / --no-autonomy
  const enableSync = !(values["no-sync"] ?? false);
  // --enable-autonomy is a backward-compatible alias (now default behavior)
  const enableAutonomy = !values["no-autonomy"];
  try {
    validateAlphaMetadataFlags(values.alpha, values["alpha-email"], values["alpha-name"]);
  } catch (error) {
    throw new CLIError(
      error instanceof Error ? error.message : String(error),
      "INVALID_FLAG",
      "Pass --alpha along with --alpha-email and --alpha-name.",
    );
  }

  // Check for existing config without force
  const hasAlphaMutation = !!(
    values.alpha ||
    values["no-alpha"] ||
    values["alpha-email"] ||
    values["alpha-name"]
  );
  let existingConfigDetected = false;
  if (!force && !enableAutonomy && !hasAlphaMutation && existsSync(configPath)) {
    try {
      const existing = loadConfigSync(configPath);
      if (!existing) throw new Error("Configuration is missing or invalid.");
      console.log(JSON.stringify(existing, null, 2));
      console.error("Already initialized. Use --force to reinitialize.");
      process.exit(0);
    } catch (err) {
      console.error(
        `[WARN] Config at ${configPath} is corrupted: ${err instanceof Error ? err.message : String(err)}. Reinitializing...`,
      );
    }
  }
  if (!force && !hasAlphaMutation && existsSync(configPath)) {
    try {
      existingConfigDetected = loadConfigSync(configPath) !== null;
    } catch {
      existingConfigDetected = false;
    }
  }

  const config = await runInit({
    configDir,
    configPath,
    force,
    agentOverride: values.agent,
    cliPathOverride: values["cli-path"],
    alpha: values.alpha ?? false,
    noAlpha: values["no-alpha"] ?? false,
    alphaEmail: values["alpha-email"],
    alphaName: values["alpha-name"],
  });

  // Redact api_key before printing to stdout
  const safeConfig = structuredClone(config);
  if (safeConfig.alpha?.credential || safeConfig.alpha?.api_key) {
    safeConfig.alpha.api_key = "<redacted>";
  }
  console.log(JSON.stringify(safeConfig, null, 2));
  if (existingConfigDetected) {
    console.error("Already initialized. Use --force to reinitialize.");
  }

  // Alpha enrollment output
  if (values.alpha) {
    console.log(
      JSON.stringify({
        level: "info",
        code: "alpha_enrolled",
        user_id: config.alpha?.user_id,
        email: config.alpha?.email,
        enrolled: true,
      }),
    );
    console.log(
      JSON.stringify({
        level: "info",
        code: "alpha_upload_ready",
        message:
          "Alpha enrollment complete. Uploads will run automatically during 'selftune run'. To enable scheduled background sync (includes evolve + watch + upload), run: selftune cron setup",
        next_command: "selftune alpha upload",
        optional_autonomy: "selftune cron setup",
      }),
    );
    console.error(ALPHA_CONSENT_NOTICE);
  } else if (values["no-alpha"]) {
    console.log(
      JSON.stringify({
        level: "info",
        code: "alpha_unenrolled",
        enrolled: false,
      }),
    );
  }

  // Detect workspace type and report
  const workspace = detectWorkspaceType(process.cwd());
  console.log(
    JSON.stringify({
      level: "info",
      code: "workspace_detected",
      type: workspace.type,
      skills: workspace.skillCount,
      monorepo: workspace.isMonorepo,
      suggestedTemplate: workspace.suggestedTemplate
        ? `templates/${workspace.suggestedTemplate}-settings.json`
        : null,
    }),
  );

  // Print telemetry disclosure
  console.error(TELEMETRY_NOTICE);

  // Run doctor as post-check
  const { doctor } = await import("@selftune/runtime/observability");
  const doctorResult = await doctor();
  console.log(
    JSON.stringify({
      level: "info",
      code: "doctor_result",
      pass: doctorResult.summary.pass,
      total: doctorResult.summary.total,
    }),
  );

  // Backfill historical transcripts into SQLite
  if (enableSync) {
    let syncResult: SyncResult | undefined;
    const syncCapabilities = createDefaultCliSetupCapabilities({
      sourceSync: sourceSync
        ? async (request) => {
            syncResult = await sourceSync(request);
            return syncResult;
          }
        : undefined,
    });
    const syncSteps = await convergeSetup(
      defaultSetupPlan({ sourceSync: true, writeConfig: false }),
      syncCapabilities,
      { configDir, configPath },
    );
    const syncStep = syncSteps.find((result) => result.step === "source_sync");
    if (syncStep?.status === "failed" || !syncResult) {
      console.log(
        JSON.stringify({
          level: "warn",
          code: "sync_failed",
          error: syncStep?.message ?? "Source sync is not configured for this runtime.",
        }),
      );
    } else {
      const totalSynced =
        (syncResult.sources.claude?.synced ?? 0) +
        (syncResult.sources.codex?.synced ?? 0) +
        (syncResult.sources.opencode?.synced ?? 0) +
        (syncResult.sources.openclaw?.synced ?? 0) +
        (syncResult.sources.pi?.synced ?? 0);

      console.log(
        JSON.stringify({
          level: "info",
          code: "sync_complete",
          sessions_synced: totalSynced,
          repaired_records: syncResult.repair.repaired_records,
          elapsed_ms: syncResult.total_elapsed_ms,
        }),
      );
    }
  }

  if (enableAutonomy) {
    try {
      let scheduleOutcome: ScheduleInstallOutcome | undefined;
      const baseCapabilities = createDefaultCliSetupCapabilities();
      const scheduleCapabilities = {
        ...baseCapabilities,
        schedule: baseCapabilities.schedule
          ? {
              install: async (request: Parameters<typeof baseCapabilities.schedule.install>[0]) => {
                scheduleOutcome = await baseCapabilities.schedule?.install(request);
                if (!scheduleOutcome) {
                  throw new Error("Schedule installation is not configured for this runtime.");
                }
                return scheduleOutcome;
              },
            }
          : undefined,
      };
      const scheduleSteps = await convergeSetup(
        defaultSetupPlan({
          scheduleEnabled: true,
          scheduleFormat: values["schedule-format"],
          writeConfig: false,
        }),
        scheduleCapabilities,
        { configDir, configPath },
      );
      const scheduleStep = scheduleSteps.find((result) => result.step === "schedule");
      if (scheduleStep?.status === "failed") {
        if (scheduleStep.message) throw new Error(scheduleStep.message);
        throw new CLIError(
          "Failed to activate the autonomous scheduler.",
          "OPERATION_FAILED",
          "Re-run with --schedule-format or use `selftune schedule --install --dry-run` to inspect the generated artifacts first.",
        );
      }

      if (!scheduleOutcome) {
        const setupState = await inspectSetupState({
          configDir,
          configPath,
          scheduleFormat: values["schedule-format"],
        });
        if (!setupState.schedule.format) {
          throw new Error("Failed to resolve the autonomous scheduler format.");
        }
        scheduleOutcome = {
          ok: setupState.schedule.installed,
          changed: false,
          format: setupState.schedule.format,
          activated: setupState.schedule.installed,
          files: setupState.schedule.artifacts,
        };
      }

      if (!scheduleOutcome.activated) {
        throw new CLIError(
          "Failed to activate the autonomous scheduler.",
          "OPERATION_FAILED",
          "Re-run with --schedule-format or use `selftune schedule --install --dry-run` to inspect the generated artifacts first.",
        );
      }

      console.log(
        JSON.stringify({
          level: "info",
          code: "autonomy_enabled",
          format: scheduleOutcome.format,
          activated: scheduleOutcome.activated,
          files: scheduleOutcome.files,
        }),
      );
    } catch (err) {
      throw new CLIError(
        `Failed to enable autonomy: ${err instanceof Error ? err.message : String(err)}`,
        "OPERATION_FAILED",
        "Re-run with --schedule-format or use `selftune schedule --install --dry-run` to inspect artifacts.",
      );
    }
  }
}

// Guard: only run when invoked directly
const isMain = import.meta.main === true || process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  cliMain().catch((err) => {
    if (err instanceof InitCliError) {
      console.error(JSON.stringify(err.payload));
      process.exit(1);
    }
    handleCLIError(err);
  });
}
