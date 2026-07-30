import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ApplyOnboardingRequest,
  ApplyOnboardingResponse,
  DesktopScheduleJobId,
  HarnessId,
  OnboardingInstallResult,
} from "@selftune/runtime/dashboard-contract";
import type { SourceSyncRunner } from "@selftune/source-management/sync";
import { resolveSelftuneBin } from "@selftune/runtime/binary-resolution";
import { installPackagedClaudeHooks } from "@selftune/runtime/desktop-claude-hooks";
import {
  detectHarnessConnections,
  loadDesktopSettings,
  updateDesktopSchedule,
  type SettingsEnvironment,
} from "@selftune/runtime/desktop-settings";
import {
  normalizeOnboardingRequest,
  persistedPreferences,
} from "@selftune/runtime/onboarding-preferences";

import {
  convergeSetup,
  defaultSetupPlan,
  migrateLegacyOnboardingPreferences,
  type HookHarnessId,
  type ScheduleInstallOutcome,
  type SetupCapabilities,
  type SetupInstallResult,
  type SetupStepResult,
} from "./setup/index.js";
import { liveSourceSyncRunner } from "./source-sync-live.js";

const HOOK_HARNESS_IDS: ReadonlyArray<HookHarnessId> = [
  "claude_code",
  "cline",
  "codex",
  "opencode",
  "pi",
];

export interface OnboardingEnvironment extends SettingsEnvironment {
  readonly resourceDir?: string;
  readonly sourceSync?: SourceSyncRunner;
  readonly installHarness?: (
    harnessId: HookHarnessId,
    binPath: string,
  ) => SetupInstallResult | Promise<SetupInstallResult>;
}

function installClaudeHooks(binPath: string, options: OnboardingEnvironment): SetupInstallResult {
  const resourceDir = options.resourceDir ?? process.env.SELFTUNE_DESKTOP_RESOURCE_DIR?.trim();
  const homeDir = options.homeDir ?? homedir();
  const harness = detectHarnessConnections(options).find((entry) => entry.id === "claude_code");
  if (!harness?.detected) {
    return {
      ok: false,
      changed: false,
      message: `${harness?.name ?? "Claude Code"} is not installed on this computer.`,
    };
  }

  if (!resourceDir) {
    const result = spawnSync(
      binPath,
      ["init", "--agent", "claude_code", "--no-sync", "--no-autonomy"],
      { encoding: "utf8" },
    );
    return result.status === 0
      ? {
          ok: true,
          changed: !harness.hooks_installed,
          message: "Claude Code hooks installed.",
        }
      : {
          ok: false,
          changed: false,
          message: result.stderr || "Claude Code hook installation failed.",
        };
  }

  const snippetPath = join(resourceDir, "settings_snippet.json");
  if ([snippetPath, binPath].some((path) => !existsSync(path))) {
    return {
      ok: false,
      changed: false,
      message: "The desktop hook runtime is missing. Reinstall SelfTune.",
    };
  }

  const changed = installPackagedClaudeHooks({
    snippetPath,
    executablePath: binPath,
    platform: options.platform,
    settingsPath: join(homeDir, ".claude", "settings.json"),
  });
  return {
    ok: true,
    changed: changed.length > 0,
    message:
      changed.length > 0
        ? `Installed ${changed.length} Claude Code hook groups.`
        : `Claude Code hooks already use ${binPath}.`,
  };
}

function installPlatformHooks(
  harnessId: HookHarnessId,
  binPath: string,
  options: OnboardingEnvironment,
): SetupInstallResult {
  if (harnessId === "claude_code") return installClaudeHooks(binPath, options);
  const harness = detectHarnessConnections(options).find((entry) => entry.id === harnessId);
  if (!harness?.detected) {
    return {
      ok: false,
      changed: false,
      message: `${harness?.name ?? harnessId} is not installed on this computer.`,
    };
  }

  const result = spawnSync(binPath, [harnessId, "install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SELFTUNE_INSTALL_CLI_PATH: binPath,
    },
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    return {
      ok: false,
      changed: false,
      message: output || `The ${harnessId} hook installer exited with status ${result.status}.`,
    };
  }
  return {
    ok: true,
    changed: !harness.hooks_installed,
    message: output || "Hooks installed.",
  };
}

function desktopScheduleFormat(platform: NodeJS.Platform): "launchd" | "systemd" {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new Error(`Desktop scheduling is not supported on ${platform}.`);
}

function createDesktopScheduleManager(
  preferences: ReturnType<typeof normalizeOnboardingRequest>,
  options: OnboardingEnvironment,
): SetupCapabilities["schedule"] {
  return {
    install: (): ScheduleInstallOutcome => {
      const current = loadDesktopSettings(options);
      const enabledByJob: Record<DesktopScheduleJobId, boolean> = {
        "selftune-sync": preferences.features.observability,
        "selftune-status": preferences.features.health_recommendations,
        "selftune-orchestrate": preferences.features.autonomous_improvement,
      };
      const jobs = current.schedule.jobs.map((job) => ({
        id: job.id,
        schedule: job.schedule,
        enabled: enabledByJob[job.id],
      }));
      const changed = current.schedule.jobs.some(
        (job) => job.enabled !== enabledByJob[job.id] || job.active !== enabledByJob[job.id],
      );
      const format = desktopScheduleFormat(options.platform ?? process.platform);
      if (!changed) {
        return {
          ok: true,
          changed: false,
          format,
          activated: true,
          files: [current.schedule.settings_path],
          message: "Desktop schedule already matches onboarding preferences.",
        };
      }

      const updated = updateDesktopSchedule({ jobs }, options);
      const activated = updated.schedule.jobs.every((job) => !enabledByJob[job.id] || job.active);
      return {
        ok: activated,
        changed: true,
        format,
        activated,
        files: [updated.schedule.settings_path],
        message: activated
          ? "Desktop schedule updated."
          : "One or more desktop schedule jobs could not be activated.",
      };
    },
  };
}

export function createDesktopSetupCapabilities(
  preferences: ReturnType<typeof normalizeOnboardingRequest>,
  options: OnboardingEnvironment = {},
): SetupCapabilities {
  const binPath = options.binPath ?? resolveSelftuneBin();
  const install = (harnessId: HookHarnessId) => () =>
    options.installHarness?.(harnessId, binPath) ??
    installPlatformHooks(harnessId, binPath, options);
  return {
    hooks: {
      claude_code: install("claude_code"),
      cline: install("cline"),
      codex: install("codex"),
      opencode: install("opencode"),
      pi: install("pi"),
    },
    sourceSync: options.sourceSync ?? liveSourceSyncRunner,
    schedule: createDesktopScheduleManager(preferences, options),
  };
}

export async function loadDesktopSettingsWithMigration(
  options: OnboardingEnvironment = {},
): Promise<ReturnType<typeof loadDesktopSettings>> {
  const migration = await migrateLegacyOnboardingPreferences({
    configDir: options.configDir,
    homeDir: options.homeDir,
  });
  if (migration.legacyFound && !migration.migrated && migration.preferences) {
    const results = await convergeSetup(
      defaultSetupPlan({
        cliPathOverride: options.binPath ?? resolveSelftuneBin(),
        preferences: migration.preferences,
      }),
      { hooks: {} },
      {
        configDir: options.configDir,
        homeDir: options.homeDir,
        platform: options.platform,
        which: options.which,
      },
    );
    const configResult = results.find((result) => result.step === "config");
    if (configResult?.status === "failed") {
      throw new Error(configResult.message ?? "Could not migrate desktop onboarding preferences.");
    }
  }
  return loadDesktopSettings(options);
}

function installResult(
  harnessId: Exclude<HarnessId, "openclaw">,
  result: SetupStepResult,
): OnboardingInstallResult {
  return {
    harness_id: harnessId,
    status:
      result.status === "applied"
        ? "installed"
        : result.status === "satisfied"
          ? "already_installed"
          : "failed",
    message: result.message ?? (result.status === "failed" ? "Hook installation failed." : ""),
  };
}

export async function applyDesktopOnboarding(
  input: ApplyOnboardingRequest | unknown,
  options: OnboardingEnvironment = {},
): Promise<ApplyOnboardingResponse> {
  const preferences = normalizeOnboardingRequest(input);
  const binPath = options.binPath ?? resolveSelftuneBin();
  const selectedHooks = HOOK_HARNESS_IDS.filter((id) => preferences.hook_harnesses[id]);
  const results = await convergeSetup(
    defaultSetupPlan({
      cliPathOverride: binPath,
      preferences: persistedPreferences(preferences),
      hookHarnesses: selectedHooks,
      scheduleEnabled: true,
      sourceSync: Object.values(preferences.import_sources).some(Boolean),
    }),
    createDesktopSetupCapabilities(preferences, options),
    {
      configDir: options.configDir,
      homeDir: options.homeDir,
      platform: options.platform,
      which: options.which,
      reconcileHookHarnesses: selectedHooks,
      reconcileSchedule: true,
    },
  );
  const byStep = new Map(results.map((result) => [result.step, result]));
  const sourceSync = byStep.get("source_sync");
  const installResults = selectedHooks.map((harnessId) => {
    const result: SetupStepResult = byStep.get(`hooks:${harnessId}`) ?? {
      step: `hooks:${harnessId}`,
      status: "failed",
      message: "Hook convergence did not return a result.",
    };
    return installResult(harnessId, result);
  });

  return {
    ...loadDesktopSettings(options),
    install_results: installResults,
    source_sync: {
      status:
        sourceSync?.status === "applied"
          ? "processed"
          : sourceSync?.status === "satisfied"
            ? "no_changes"
            : sourceSync?.status === "failed"
              ? "failed"
              : "skipped",
      message: sourceSync?.message ?? null,
    },
  };
}
