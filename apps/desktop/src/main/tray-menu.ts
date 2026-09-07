import { Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from "electron";

import {
  harnessSummary,
  humanizeSchedule,
  remoteLibrarySummary,
  statusLabel,
  toggleScheduleJob,
  type TrayRemoteState,
  type TrayScheduleJobId,
  type TrayScheduleUpdateRequest,
  type TraySettingsResponse,
} from "./tray-state";
import { updateMenuEnabled, updateMenuLabel, type DesktopUpdateStatus } from "./update-state";

const REFRESH_INTERVAL_MS = 30_000;
const FEEDBACK_DURATION_MS = 8_000;

export interface TrayMenuControllerOptions {
  iconPath: string;
  canLaunchAtLogin: boolean;
  getLaunchAtLogin: () => boolean;
  setLaunchAtLogin: (enabled: boolean) => void;
  canManageBackgroundService: boolean;
  getBackgroundServiceEnabled: () => boolean;
  setBackgroundServiceEnabled: (enabled: boolean) => Promise<void>;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => void;
  loadState: () => Promise<TrayRemoteState>;
  runSync: () => Promise<void>;
  runRemoteSync: () => Promise<void>;
  updateSchedule: (request: TrayScheduleUpdateRequest) => Promise<TraySettingsResponse>;
  openDashboardPath: (pathname: string) => Promise<void>;
  openLogs: (path: string) => Promise<void>;
  quit: () => void;
}

export interface TrayMenuController {
  refresh: () => Promise<void>;
  setUpdateStatus: (status: DesktopUpdateStatus) => void;
  destroy: () => void;
}

function createTrayIcon(iconPath: string) {
  const sourceIcon = nativeImage.createFromPath(iconPath);
  if (sourceIcon.isEmpty()) throw new Error(`SelfTune menu-bar icon is missing: ${iconPath}`);

  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const pixelSize = 18 * scaleFactor;
    icon.addRepresentation({
      scaleFactor,
      buffer: sourceIcon.resize({ width: pixelSize, height: pixelSize, quality: "best" }).toPNG(),
    });
  }
  icon.setTemplateImage(true);
  return icon;
}

function harnessStatusLabel(status: "connected" | "detected" | "not_detected"): string {
  if (status === "connected") return "Connected";
  if (status === "detected") return "Setup needed";
  return "Not found";
}

export function createTrayMenuController(options: TrayMenuControllerOptions): TrayMenuController {
  const tray = new Tray(createTrayIcon(options.iconPath));
  let remoteState: TrayRemoteState | null = null;
  let operation: "sync" | "remote-sync" | "background-service" | TrayScheduleJobId | null = null;
  let updateStatus: DesktopUpdateStatus = { state: "idle" };
  let feedback: string | null = null;
  let refreshError: string | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  }

  function setFeedback(message: string): void {
    feedback = message;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedback = null;
      render();
    }, FEEDBACK_DURATION_MS);
  }

  function reportFailure(context: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    setFeedback(`${context}: ${message}`);
    notify("SelfTune action failed", message);
    render();
  }

  function openDashboard(pathname: string): void {
    void options.openDashboardPath(pathname).catch((cause: unknown) => {
      reportFailure("Could not open SelfTune", cause);
    });
  }

  async function perform(
    activeOperation: "sync" | "remote-sync" | "background-service" | TrayScheduleJobId,
    successMessage: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (operation) return;
    operation = activeOperation;
    feedback = null;
    render();
    try {
      await task();
      setFeedback(successMessage);
      notify("SelfTune", successMessage);
    } catch (error) {
      reportFailure("Action failed", error);
    } finally {
      operation = null;
      render();
    }
  }

  async function refresh(): Promise<void> {
    try {
      remoteState = await options.loadState();
      refreshError = null;
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  async function runSync(): Promise<void> {
    await perform("sync", "Session sync completed.", async () => {
      await options.runSync();
      await refresh();
    });
  }

  async function runRemoteSync(): Promise<void> {
    await perform("remote-sync", "Sync & Backup completed.", async () => {
      await options.runRemoteSync();
      await refresh();
    });
  }

  async function toggleAutomation(jobId: TrayScheduleJobId): Promise<void> {
    if (!remoteState) return;
    const currentJob = remoteState.settings.schedule.jobs.find((job) => job.id === jobId);
    if (!currentJob) return;
    const enabling = !currentJob.enabled;
    await perform(jobId, `${currentJob.label} ${enabling ? "enabled" : "disabled"}.`, async () => {
      if (!remoteState) return;
      const settings = await options.updateSchedule(toggleScheduleJob(remoteState.settings, jobId));
      remoteState = { ...remoteState, settings };
    });
  }

  function harnessMenu(): MenuItemConstructorOptions[] {
    if (!remoteState) return [{ label: "Loading harness status...", enabled: false }];
    return remoteState.settings.harnesses.map((harness) => ({
      label: `${harness.name}: ${harnessStatusLabel(harness.status)}`,
      enabled: harness.detected,
      click: () => openDashboard("/settings"),
    }));
  }

  function automationMenu(): MenuItemConstructorOptions[] {
    if (!remoteState) return [{ label: "Loading automation...", enabled: false }];
    if (!remoteState.settings.schedule.supported) {
      return [{ label: "Native scheduling is unavailable", enabled: false }];
    }
    return remoteState.settings.schedule.jobs.map((job) => ({
      type: "checkbox",
      label: `${job.label} (${humanizeSchedule(job.schedule)})`,
      checked: job.enabled,
      enabled: operation === null,
      click: () => void toggleAutomation(job.id),
    }));
  }

  function render(): void {
    if (destroyed) return;
    const reviewCount = remoteState
      ? remoteState.insights.counts.pending +
        remoteState.insights.counts.accepted +
        remoteState.insights.counts.drafted
      : 0;
    const loginItemLabel = options.canLaunchAtLogin
      ? "Launch at Login"
      : "Launch at Login (installed app only)";

    const template: MenuItemConstructorOptions[] = [
      {
        label: statusLabel(remoteState),
        click: () => openDashboard("/"),
      },
      {
        label: harnessSummary(remoteState?.settings ?? null),
        submenu: harnessMenu(),
      },
      {
        label: remoteLibrarySummary(remoteState?.settings ?? null),
        click: () => openDashboard("/settings"),
      },
      { type: "separator" },
      { label: "Open SelfTune", click: () => openDashboard("/") },
      {
        label:
          reviewCount > 0
            ? `Review ${reviewCount} candidate${reviewCount === 1 ? "" : "s"}`
            : "No attention needed",
        enabled: reviewCount > 0,
        click: () => openDashboard("/insights"),
      },
      {
        label: operation === "sync" ? "Syncing Sessions..." : "Sync Sessions Now",
        enabled: operation === null && remoteState !== null,
        click: () => void runSync(),
      },
      {
        label: operation === "remote-sync" ? "Syncing backup..." : "Sync & Backup Now",
        enabled: operation === null && remoteState?.settings.remote_library.configured === true,
        click: () => void runRemoteSync(),
      },
      { label: "Automation", submenu: automationMenu() },
      { type: "separator" },
      {
        type: "checkbox",
        label: loginItemLabel,
        checked: options.canLaunchAtLogin && options.getLaunchAtLogin(),
        enabled: options.canLaunchAtLogin,
        click: (menuItem) => {
          try {
            options.setLaunchAtLogin(menuItem.checked);
            setFeedback(`Launch at Login ${menuItem.checked ? "enabled" : "disabled"}.`);
            render();
          } catch (error) {
            reportFailure("Could not update Launch at Login", error);
          }
        },
      },
      {
        type: "checkbox",
        label: options.canManageBackgroundService
          ? "Keep Local Service Running"
          : "Keep Local Service Running (installed app only)",
        checked: options.canManageBackgroundService && options.getBackgroundServiceEnabled(),
        enabled: options.canManageBackgroundService && operation === null,
        click: (menuItem) => {
          const enabled = menuItem.checked;
          void perform(
            "background-service",
            `Background service ${enabled ? "enabled" : "disabled"}.`,
            () => options.setBackgroundServiceEnabled(enabled),
          );
        },
      },
      { label: "Settings...", click: () => openDashboard("/settings") },
      { label: "System Status...", click: () => openDashboard("/status") },
      {
        label: "Show Logs in Finder",
        enabled: Boolean(remoteState?.health.log_dir),
        click: () => {
          const path = remoteState?.health.log_dir;
          if (path) {
            void options.openLogs(path).catch((cause: unknown) => {
              reportFailure("Could not open logs", cause);
            });
          }
        },
      },
      {
        label: updateMenuLabel(updateStatus),
        enabled: updateMenuEnabled(updateStatus),
        click: () => {
          if (updateStatus.state === "downloaded") {
            options.installUpdate();
            return;
          }
          void options.checkForUpdates().catch((cause: unknown) => {
            reportFailure("Update check failed", cause);
          });
        },
      },
    ];

    if (operation && operation !== "sync") {
      template.push({ label: "Updating automation...", enabled: false });
    } else if (feedback) {
      template.push({ label: feedback, enabled: false });
    } else if (refreshError) {
      template.push({ label: `Status refresh failed: ${refreshError}`, enabled: false });
    }

    template.push({ type: "separator" }, { label: "Quit SelfTune", click: options.quit });
    tray.setToolTip(statusLabel(remoteState));
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  render();
  void refresh();
  const refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  return {
    refresh,
    setUpdateStatus(status) {
      updateStatus = status;
      render();
    },
    destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      if (feedbackTimer) clearTimeout(feedbackTimer);
      tray.destroy();
    },
  };
}
