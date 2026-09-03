import { app, autoUpdater as nativeUpdater, dialog } from "electron";
import updater from "electron-updater";

import type { DesktopUpdateStatus } from "./update-state";

const { autoUpdater } = updater;
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1_000;

interface UpdateInfo {
  readonly version: string;
}

interface DownloadProgress {
  readonly percent: number;
}

export interface DesktopUpdaterController {
  getStatus: () => DesktopUpdateStatus;
  check: (interactive?: boolean) => Promise<void>;
  install: () => Promise<void>;
  destroy: () => void;
}

export function createDesktopUpdater(
  onStatus: (status: DesktopUpdateStatus) => void,
  beforeInstall: () => Promise<void>,
  beforeUpdateQuit: () => void,
): DesktopUpdaterController {
  const updatesDisabled = process.env.SELFTUNE_TEST_DISABLE_UPDATES === "1";
  let status: DesktopUpdateStatus = { state: "idle" };
  let pendingVersion: string | null = null;
  let checkInFlight: Promise<void> | null = null;
  let promptOpen = false;

  const setStatus = (nextStatus: DesktopUpdateStatus): void => {
    status = nextStatus;
    onStatus(nextStatus);
  };

  const install = async (): Promise<void> => {
    if (updatesDisabled || !app.isPackaged || status.state !== "downloaded") return;
    await beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  };

  const promptForInstall = async (version: string): Promise<void> => {
    if (promptOpen) return;
    promptOpen = true;
    try {
      const response = await dialog.showMessageBox({
        type: "info",
        title: "SelfTune update ready",
        message: `SelfTune ${version} is ready to install.`,
        detail: "Restart now to apply it, or keep working and install it later from the menu bar.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response.response === 0) await install();
    } finally {
      promptOpen = false;
    }
  };

  const check = async (interactive = false): Promise<void> => {
    if (updatesDisabled) return;
    if (!app.isPackaged) {
      if (interactive) {
        await dialog.showMessageBox({
          type: "info",
          title: "Updates unavailable",
          message: "Automatic updates are enabled in installed SelfTune builds.",
        });
      }
      return;
    }
    if (status.state === "downloaded") {
      if (interactive) await promptForInstall(status.version);
      return;
    }
    if (checkInFlight) return checkInFlight;

    checkInFlight = (async () => {
      setStatus({ state: "checking" });
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable) {
          setStatus({ state: "idle" });
          if (interactive) {
            await dialog.showMessageBox({
              type: "info",
              title: "SelfTune is up to date",
              message: `You are running the latest version (${app.getVersion()}).`,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ state: "error", message });
        if (interactive) {
          await dialog.showMessageBox({
            type: "error",
            title: "Update check failed",
            message: "SelfTune could not reach the update server.",
            detail: message,
          });
        }
      } finally {
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  };

  if (app.isPackaged && !updatesDisabled) {
    nativeUpdater.on("before-quit-for-update", beforeUpdateQuit);
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      pendingVersion = info.version;
      setStatus({ state: "available", version: info.version });
    });
    autoUpdater.on("download-progress", (progress: DownloadProgress) => {
      if (!pendingVersion) return;
      setStatus({
        state: "downloading",
        version: pendingVersion,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      pendingVersion = info.version;
      setStatus({ state: "downloaded", version: info.version });
      void promptForInstall(info.version);
    });
    autoUpdater.on("error", (error: Error) => {
      setStatus({ state: "error", message: error.message });
    });
  }

  const interval = updatesDisabled
    ? null
    : setInterval(() => void check(false), UPDATE_INTERVAL_MS);
  interval?.unref();

  return {
    getStatus: () => status,
    check,
    install,
    destroy() {
      if (interval) clearInterval(interval);
      nativeUpdater.removeListener("before-quit-for-update", beforeUpdateQuit);
      autoUpdater.removeAllListeners();
    },
  };
}
