import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  ApplyOnboardingRequest,
  ApplyOnboardingResponse,
  HarnessId,
  OnboardingInstallResult,
} from "./dashboard-contract.js";
import { installPackagedClaudeHooks } from "./desktop-claude-hooks.js";
import {
  detectHarnessConnections,
  loadDesktopSettings,
  type SettingsEnvironment,
  updateDesktopSchedule,
} from "./desktop-settings.js";
import { normalizeOnboardingRequest, saveOnboardingPreferences } from "./onboarding-preferences.js";
import { resolveSelftuneBin } from "./binary-resolution.js";

type HookHarnessId = Exclude<HarnessId, "openclaw">;
const HOOK_HARNESS_IDS: ReadonlyArray<HookHarnessId> = ["claude_code", "codex", "opencode", "pi"];

interface HookInstallOutcome {
  ok: boolean;
  message: string;
}

export interface OnboardingEnvironment extends SettingsEnvironment {
  resourceDir?: string;
  installHarness?: (harnessId: HookHarnessId, binPath: string) => HookInstallOutcome;
}

function installClaudeHooks(
  binPath: string,
  resourceDir?: string,
  platform: NodeJS.Platform = process.platform,
): HookInstallOutcome {
  const packagedResourceDir =
    resourceDir ?? process.env.SELFTUNE_DESKTOP_RESOURCE_DIR?.trim() ?? null;
  if (!packagedResourceDir) {
    const result = spawnSync(
      binPath,
      ["init", "--agent", "claude_code", "--no-sync", "--no-autonomy"],
      {
        encoding: "utf8",
      },
    );
    return result.status === 0
      ? { ok: true, message: "Claude Code hooks installed." }
      : { ok: false, message: result.stderr || "Claude Code hook installation failed." };
  }

  const snippetPath = join(packagedResourceDir, "settings_snippet.json");

  const requiredPaths = [snippetPath, binPath];
  if (requiredPaths.some((path) => !existsSync(path))) {
    return {
      ok: false,
      message: "The desktop hook runtime is missing. Reinstall SelfTune.",
    };
  }

  const changed = installPackagedClaudeHooks({ snippetPath, executablePath: binPath, platform });
  return {
    ok: true,
    message:
      changed.length > 0
        ? `Installed ${changed.length} Claude Code hook groups.`
        : `Claude Code hooks already use ${binPath}.`,
  };
}

function installPlatformHooks(harnessId: HookHarnessId, binPath: string): HookInstallOutcome {
  if (harnessId === "claude_code") {
    return installClaudeHooks(binPath);
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
      message: output || `The ${harnessId} hook installer exited with status ${result.status}.`,
    };
  }
  return { ok: true, message: output || "Hooks installed." };
}

export function applyDesktopOnboarding(
  input: ApplyOnboardingRequest | unknown,
  options: OnboardingEnvironment = {},
): ApplyOnboardingResponse {
  const preferences = normalizeOnboardingRequest(input);
  const binPath = options.binPath ?? resolveSelftuneBin();
  const harnessesBefore = detectHarnessConnections(options);
  const installer =
    options.installHarness ??
    ((harnessId: HookHarnessId, path: string) =>
      harnessId === "claude_code"
        ? installClaudeHooks(path, options.resourceDir, options.platform)
        : installPlatformHooks(harnessId, path));
  const installResults: OnboardingInstallResult[] = [];

  for (const id of HOOK_HARNESS_IDS) {
    if (!preferences.hook_harnesses[id]) continue;
    const harness = harnessesBefore.find((entry) => entry.id === id);
    if (!harness?.detected) {
      installResults.push({
        harness_id: id,
        status: "failed",
        message: `${harness?.name ?? id} is not installed on this computer.`,
      });
      continue;
    }
    const outcome = installer(id, binPath);
    installResults.push({
      harness_id: id,
      status: outcome.ok ? (harness.hooks_installed ? "already_installed" : "installed") : "failed",
      message: outcome.message,
    });
  }

  const currentSettings = loadDesktopSettings(options);
  updateDesktopSchedule(
    {
      jobs: currentSettings.schedule.jobs.map((job) => ({
        id: job.id,
        schedule: job.schedule,
        enabled:
          job.id === "selftune-sync"
            ? preferences.features.observability
            : job.id === "selftune-status"
              ? preferences.features.health_recommendations
              : preferences.features.autonomous_improvement,
      })),
    },
    options,
  );
  saveOnboardingPreferences(input, options.configDir);

  return {
    ...loadDesktopSettings(options),
    install_results: installResults,
  };
}
