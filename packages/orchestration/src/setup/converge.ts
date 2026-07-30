import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { writeConfig, type SelftuneConfig, type SelftunePreferences } from "@selftune/config";
import { agentTypeToCli, determineCliPath } from "@selftune/runtime/init/environment";
import { Effect } from "effect";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { countSyncedRecords, type SetupCapabilities } from "./capabilities.js";
import {
  inspectSetupState,
  resolveSetupConfigPath,
  type SetupEnvironment,
  type SetupState,
} from "./inspect.js";
import type { SetupPlan } from "./plan.js";
import { migrateLegacyOnboardingPreferences } from "./preferences.js";

export type SetupStepStatus = "satisfied" | "applied" | "failed" | "skipped";

export interface SetupStepResult {
  readonly step: string;
  readonly status: SetupStepStatus;
  readonly message?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installStatus(outcome: { ok: boolean; changed: boolean }): SetupStepStatus {
  if (!outcome.ok) return "failed";
  return outcome.changed ? "applied" : "satisfied";
}

function configsMatch(current: SelftuneConfig | null, desired: SelftuneConfig): boolean {
  if (!current) return false;
  return isDeepStrictEqual({ ...current, initialized_at: desired.initialized_at }, desired);
}

function desiredConfig(
  plan: SetupPlan,
  state: SetupState,
  env: SetupEnvironment,
  migratedPreferences?: SelftunePreferences,
): SelftuneConfig {
  let value: SelftuneConfig;
  if (plan.config.value) {
    value = structuredClone(plan.config.value);
    if (plan.hookHarnesses.includes("claude_code")) {
      value.hooks_installed = state.harnesses.claude_code.hooksInstalled;
    }
  } else if (state.config) {
    value = structuredClone(state.config);
  } else {
    const agentCli =
      state.agentCli ?? (plan.agentOverride ? agentTypeToCli(state.agentType) : null);
    if (!agentCli && !plan.preferences) {
      throw new Error(
        "No supported agent CLI detected (claude, codex, opencode). Install one, then rerun `selftune init`.",
      );
    }

    value = {
      agent_type: state.agentType,
      cli_path: determineCliPath(plan.cliPathOverride),
      llm_mode: "agent",
      agent_cli: agentCli,
      hooks_installed: state.harnesses.claude_code.hooksInstalled,
      initialized_at: (env.now ?? (() => new Date()))().toISOString(),
    };
  }
  const preferences = plan.preferences ?? value.preferences ?? migratedPreferences;
  if (preferences) value.preferences = preferences;
  return value;
}

async function persistConfig(path: string, config: SelftuneConfig): Promise<void> {
  await Effect.runPromise(writeConfig(path, config).pipe(Effect.provide(BunFileSystem.layer)));
}

export async function convergeSetup(
  plan: SetupPlan,
  capabilities: SetupCapabilities,
  env: SetupEnvironment = {},
): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = [];
  const homeDir = env.homeDir ?? homedir();
  const configPath = resolveSetupConfigPath(env);
  const migration = await migrateLegacyOnboardingPreferences(env);
  let state: SetupState;

  try {
    state = await inspectSetupState({
      ...env,
      agentOverride: plan.agentOverride ?? env.agentOverride,
      ignoreExistingConfig: plan.config.force || env.ignoreExistingConfig,
      scheduleFormat: plan.schedule.format ?? env.scheduleFormat,
    });
  } catch (error) {
    if (plan.config.enabled) throw error;
    state = await inspectSetupState({
      ...env,
      agentOverride: plan.agentOverride ?? env.agentOverride,
      ignoreExistingConfig: true,
      scheduleFormat: plan.schedule.format ?? env.scheduleFormat,
    });
  }

  let config = state.config;
  let targetConfig: SelftuneConfig | null = null;
  if (!plan.config.enabled) {
    results.push({ step: "config", status: "skipped" });
  } else {
    try {
      targetConfig = desiredConfig(plan, state, env, migration.preferences);
      if (!plan.config.force && configsMatch(config, targetConfig)) {
        config = state.config;
        results.push({ step: "config", status: "satisfied" });
      } else {
        await persistConfig(configPath, targetConfig);
        config = targetConfig;
        results.push({ step: "config", status: "applied" });
      }
      if (migration.legacyFound) await migrateLegacyOnboardingPreferences(env);
    } catch (error) {
      results.push({ step: "config", status: "failed", message: errorMessage(error) });
    }
  }

  if (!plan.agentFiles) {
    results.push({ step: "agent_files", status: "skipped" });
  } else if (state.agentFilesInstalled) {
    results.push({ step: "agent_files", status: "satisfied" });
  } else if (!capabilities.hooks.agentFiles) {
    results.push({
      step: "agent_files",
      status: "failed",
      message: "Agent-file installation is not configured for this runtime.",
    });
  } else {
    try {
      const outcome = await capabilities.hooks.agentFiles({
        homeDir,
        cliPath:
          targetConfig?.cli_path ?? config?.cli_path ?? determineCliPath(plan.cliPathOverride),
      });
      results.push({
        step: "agent_files",
        status: installStatus(outcome),
        message: outcome.message,
      });
    } catch (error) {
      results.push({ step: "agent_files", status: "failed", message: errorMessage(error) });
    }
  }

  for (const harnessId of plan.hookHarnesses) {
    const step = `hooks:${harnessId}`;
    if (state.harnesses[harnessId].hooksInstalled) {
      results.push({ step, status: "satisfied" });
      continue;
    }

    const installer = capabilities.hooks[harnessId];
    if (!installer) {
      results.push({
        step,
        status: "failed",
        message: `Hook installation for ${harnessId} is not configured for this runtime.`,
      });
      continue;
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- hook convergence is ordered and may update config for the next step
      const outcome = await installer({
        homeDir,
        cliPath:
          targetConfig?.cli_path ?? config?.cli_path ?? determineCliPath(plan.cliPathOverride),
      });
      const status = installStatus(outcome);
      results.push({ step, status, message: outcome.message });
      if (harnessId === "claude_code" && status === "applied" && config) {
        config.hooks_installed = true;
        // oxlint-disable-next-line no-await-in-loop -- persist the hook result before another installer can observe config
        await persistConfig(configPath, config);
      }
    } catch (error) {
      results.push({ step, status: "failed", message: errorMessage(error) });
    }
  }

  if (!plan.sourceSync) {
    results.push({ step: "source_sync", status: "skipped" });
  } else if (!capabilities.sourceSync) {
    results.push({
      step: "source_sync",
      status: "failed",
      message: "Source sync is not configured for this runtime.",
    });
  } else {
    try {
      const syncResult = await capabilities.sourceSync();
      results.push({
        step: "source_sync",
        status: countSyncedRecords(syncResult) > 0 ? "applied" : "satisfied",
      });
    } catch (error) {
      results.push({ step: "source_sync", status: "failed", message: errorMessage(error) });
    }
  }

  if (!plan.schedule.enabled) {
    results.push({ step: "schedule", status: "skipped" });
  } else if (state.schedule.installed) {
    results.push({ step: "schedule", status: "satisfied" });
  } else if (!capabilities.schedule) {
    results.push({
      step: "schedule",
      status: "failed",
      message: "Schedule installation is not configured for this runtime.",
    });
  } else {
    try {
      const outcome = await capabilities.schedule.install({
        format: plan.schedule.format,
        homeDir,
      });
      results.push({
        step: "schedule",
        status: installStatus(outcome),
        message: outcome.message,
      });
    } catch (error) {
      results.push({ step: "schedule", status: "failed", message: errorMessage(error) });
    }
  }

  return results;
}
