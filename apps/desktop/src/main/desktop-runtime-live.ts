import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app, dialog } from "electron";
import * as Schema from "effect/Schema";
import {
  getBackgroundServiceStatus,
  installBackgroundService,
  restartBackgroundService,
  stopBackgroundService,
  uninstallBackgroundService,
  type BackgroundServiceOptions,
} from "./background-service";
import { logRuntimeEvent } from "./diagnostics";
import {
  CONNECTION_MONITOR_INTERVAL_MS,
  CONNECTION_MONITOR_MISSES_BEFORE_RECOVERY,
  type DesktopRuntimeDependencies,
} from "./desktop-runtime";
import { announceBackup, confirmResetState, resetSelfTuneState } from "./reset-state";
import { installStableRuntime, installedRuntimeRoot } from "./runtime-install";
import { skipBackgroundServiceFirstRunPrompt } from "./runtime-ownership";
import {
  attachToExistingRuntime,
  attachToSupervisedSidecar,
  startSidecar,
  stopSidecar,
} from "./sidecar";

export function desktopConfigDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR ?? join(homedir(), ".selftune");
}

function backgroundPreferencePath(configDir: string): string {
  return join(configDir, "background-service.json");
}

function readBackgroundPreference(configDir: string): boolean | null {
  const path = backgroundPreferencePath(configDir);
  if (!existsSync(path)) return null;
  try {
    const value = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ enabled: Schema.Json })),
    )(readFileSync(path, "utf8"));
    return value.enabled === true;
  } catch {
    return null;
  }
}

function writeBackgroundPreference(configDir: string, enabled: boolean): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    backgroundPreferencePath(configDir),
    `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function backgroundServiceOptions(configDir: string): BackgroundServiceOptions {
  const resourceDir = installedRuntimeRoot();
  const executable = process.platform === "win32" ? "selftune.exe" : "selftune";
  return {
    executablePath: join(resourceDir, executable),
    resourceDir,
    configDir,
    version: app.getVersion(),
  };
}

export function makeLiveDesktopRuntimeDependencies(): DesktopRuntimeDependencies {
  const configDir = desktopConfigDir();
  const options = (): BackgroundServiceOptions => backgroundServiceOptions(configDir);
  return {
    announceBackup,
    attachExistingRuntime: attachToExistingRuntime,
    attachSupervisedSidecar: attachToSupervisedSidecar,
    canManageBackgroundService:
      app.isPackaged && ["darwin", "linux", "win32"].includes(process.platform),
    configDir,
    confirmReset: confirmResetState,
    fetch: (url, init) => fetch(url, init),
    getBackgroundStatus: () => getBackgroundServiceStatus(options()),
    installBackgroundService: () => installBackgroundService(options()),
    installRuntime: installStableRuntime,
    log: logRuntimeEvent,
    monitorFailureThreshold: CONNECTION_MONITOR_MISSES_BEFORE_RECOVERY,
    monitorIntervalMs: CONNECTION_MONITOR_INTERVAL_MS,
    platform: process.platform,
    promptForBackgroundService: async () => {
      const skipPrompt = skipBackgroundServiceFirstRunPrompt(
        process.env.SELFTUNE_TEST_SKIP_BACKGROUND_SERVICE,
      );
      if (skipPrompt) {
        return false;
      }
      const response = await dialog.showMessageBox({
        type: "question",
        title: "Keep SelfTune running in the background?",
        message: "Keep skill observability and automation available after you quit SelfTune?",
        detail:
          "SelfTune can install a lightweight local service that restarts after crashes and starts when you log in. You can turn it off from Settings or the menu bar.",
        buttons: ["Keep Running in Background", "Not Now"],
        defaultId: 0,
        cancelId: 1,
      });
      return response.response === 0;
    },
    readBackgroundPreference: () => readBackgroundPreference(configDir),
    resetState: () => resetSelfTuneState(configDir),
    restartBackgroundService: () => restartBackgroundService(options()),
    startSidecar,
    stopBackgroundService: () => stopBackgroundService(options()),
    stopSidecar,
    uninstallBackgroundService: () => uninstallBackgroundService(options()),
    version: app.getVersion(),
    writeBackgroundPreference: (enabled) => writeBackgroundPreference(configDir, enabled),
  };
}
