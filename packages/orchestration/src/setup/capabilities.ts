import type { SourceSyncRunner, SyncResult } from "@selftune/source-management/sync";
import { checkAgentFiles, installAgentFiles } from "@selftune/runtime/claude-agents";
import { checkClaudeCodeHooks, installClaudeCodeHooks } from "@selftune/runtime/init/claude-hooks";
import {
  installSchedule,
  type ScheduleFormat,
  type ScheduleInstallResult,
} from "@selftune/runtime/scheduling";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HookHarnessId } from "./plan.js";

export interface SetupInstallResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly message?: string;
}

export interface HookInstallContext {
  readonly homeDir: string;
  readonly cliPath: string;
}

export type HookInstaller = (
  context: HookInstallContext,
) => SetupInstallResult | Promise<SetupInstallResult>;

export interface HookInstallers extends Partial<Record<HookHarnessId, HookInstaller>> {
  readonly agentFiles?: HookInstaller;
}

export interface ScheduleInstallRequest {
  readonly format?: string;
  readonly homeDir: string;
}

export interface ScheduleInstallOutcome extends SetupInstallResult {
  readonly format: ScheduleFormat;
  readonly activated: boolean;
  readonly files: ReadonlyArray<string>;
}

export interface ScheduleManager {
  readonly install: (
    request: ScheduleInstallRequest,
  ) => ScheduleInstallOutcome | Promise<ScheduleInstallOutcome>;
}

export type SourceSync = SourceSyncRunner;

export interface SetupCapabilities {
  readonly hooks: HookInstallers;
  readonly schedule?: ScheduleManager;
  readonly sourceSync?: SourceSync;
}

export interface DefaultCliSetupCapabilitiesOptions {
  readonly homeDir?: string;
  readonly sourceSync?: SourceSyncRunner;
  readonly installSchedule?: typeof installSchedule;
}

function scheduleOutcome(result: ScheduleInstallResult): ScheduleInstallOutcome {
  return {
    ok: result.activated,
    changed: result.activated,
    format: result.format,
    activated: result.activated,
    files: result.artifacts.map((artifact) => artifact.path),
  };
}

export function createDefaultCliSetupCapabilities(
  options: DefaultCliSetupCapabilitiesOptions = {},
): SetupCapabilities {
  const homeDir = options.homeDir ?? homedir();
  const scheduleInstaller = options.installSchedule ?? installSchedule;

  return {
    hooks: {
      agentFiles: () => {
        const wasInstalled = checkAgentFiles({ homeDir });
        const changedFiles = installAgentFiles({ homeDir });
        const installed = checkAgentFiles({ homeDir });
        return {
          ok: installed,
          changed: changedFiles.length > 0 || (!wasInstalled && installed),
          message:
            changedFiles.length > 0
              ? `[INFO] Synced ${changedFiles.length} selftune agent file(s) into ${join(homeDir, ".claude", "agents")}: ${changedFiles.join(", ")}`
              : undefined,
        };
      },
      claude_code: ({ cliPath }) => {
        const settingsPath = join(homeDir, ".claude", "settings.json");
        const wasInstalled = checkClaudeCodeHooks(settingsPath);
        const changedHookKeys = installClaudeCodeHooks({ settingsPath, cliPath });
        const installed = checkClaudeCodeHooks(settingsPath);
        return {
          ok: installed,
          changed: changedHookKeys.length > 0 || (!wasInstalled && installed),
          message:
            changedHookKeys.length > 0
              ? `[INFO] Installed/updated ${changedHookKeys.length} selftune hook(s) in ${settingsPath}: ${changedHookKeys.join(", ")}`
              : undefined,
        };
      },
    },
    schedule: {
      install: ({ format, homeDir: requestedHomeDir }) =>
        scheduleOutcome(scheduleInstaller({ format, homeDir: requestedHomeDir })),
    },
    sourceSync: options.sourceSync,
  };
}

export function countSyncedRecords(result: SyncResult): number {
  return (
    (result.sources.claude?.synced ?? 0) +
    (result.sources.codex?.synced ?? 0) +
    (result.sources.opencode?.synced ?? 0) +
    (result.sources.openclaw?.synced ?? 0) +
    (result.sources.pi?.synced ?? 0) +
    result.repair.repaired_records +
    result.creator_contributions.staged_signals
  );
}
