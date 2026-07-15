import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { exportDiagnosticsInteractive } from "./diagnostics";
import type { DesktopRuntimeError, DesktopRuntimeService } from "./desktop-runtime";
import type { DesktopWindowController } from "./desktop-window";
import { createTrayMenuController, type TrayMenuController } from "./tray-menu";
import {
  TrayHealthResponseSchema,
  TrayInsightsResponseSchema,
  TrayOverviewResponseSchema,
  TraySettingsResponseSchema,
  type TrayRemoteState,
  type TrayScheduleUpdateRequest,
  type TraySettingsResponse,
} from "./tray-state";
import { createDesktopUpdater, type DesktopUpdaterController } from "./updater";

const SyncResultSchema = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export interface DesktopShellOptions {
  readonly configDir: string;
  readonly runRuntime: <A>(effect: Effect.Effect<A, DesktopRuntimeError>) => Promise<A>;
  readonly runtime: DesktopRuntimeService;
  readonly window: DesktopWindowController;
}

export interface DesktopShellController {
  readonly checkForUpdates: (interactive: boolean) => Promise<void>;
  readonly createTray: () => Promise<void>;
  readonly destroy: () => void;
  readonly installUpdate: () => Promise<void>;
  readonly refreshTray: () => Promise<void>;
  readonly start: () => void;
}

export function createDesktopShell(options: DesktopShellOptions): DesktopShellController {
  let backgroundServiceEnabled = false;
  let trayController: TrayMenuController | null = null;
  let updaterController: DesktopUpdaterController | null = null;
  let started = false;

  async function loadTrayState(): Promise<TrayRemoteState> {
    const [settings, overview, health, insights] = await Promise.all([
      options.runRuntime(
        options.runtime.requestJson("/api/v2/settings", TraySettingsResponseSchema),
      ),
      options.runRuntime(
        options.runtime.requestJson("/api/v2/overview", TrayOverviewResponseSchema),
      ),
      options.runRuntime(options.runtime.requestJson("/api/health", TrayHealthResponseSchema)),
      options.runRuntime(
        options.runtime.requestJson("/api/v2/insights", TrayInsightsResponseSchema),
      ),
    ]);
    return { settings, overview, health, insights };
  }

  async function runTraySync(): Promise<void> {
    const result = await options.runRuntime(
      options.runtime.requestJson("/api/actions/sync", SyncResultSchema, {
        method: "POST",
        body: "{}",
      }),
    );
    if (!result.success) throw new Error(result.error || "Session sync failed.");
  }

  async function runTrayRemoteSync(): Promise<void> {
    await options.runRuntime(
      options.runtime.requestJson("/api/v2/settings/remote-library/sync", Schema.Unknown, {
        method: "POST",
        body: "{}",
      }),
    );
  }

  function updateTraySchedule(request: TrayScheduleUpdateRequest): Promise<TraySettingsResponse> {
    return options.runRuntime(
      options.runtime.requestJson("/api/v2/settings/schedule", TraySettingsResponseSchema, {
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  }

  function installApplicationMenu(): void {
    const isMac = process.platform === "darwin";
    const appMenu: MenuItemConstructorOptions = {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => void updaterController?.check(true),
        },
        {
          label: "Restart Local Service",
          click: () =>
            void options
              .runRuntime(options.runtime.restart)
              .catch((cause: unknown) => options.window.showCrash(cause)),
        },
        {
          label: "Export Diagnostics...",
          click: () => void exportDiagnosticsInteractive(options.configDir),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    };
    const template: MenuItemConstructorOptions[] = [
      ...(isMac ? [appMenu] : []),
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function start(): void {
    if (started) return;
    started = true;
    updaterController = createDesktopUpdater(
      (status) => trayController?.setUpdateStatus(status),
      () => options.runRuntime(options.runtime.prepareForUpdate),
    );
    installApplicationMenu();
  }

  async function createTray(): Promise<void> {
    if (process.platform !== "darwin" || trayController) return;
    const backgroundState = await options.runRuntime(options.runtime.backgroundServiceState);
    backgroundServiceEnabled = backgroundState.enabled;
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, "tray-icon.png")
      : fileURLToPath(new URL("../../build/icon.png", import.meta.url));
    trayController = createTrayMenuController({
      iconPath,
      canLaunchAtLogin: app.isPackaged,
      getLaunchAtLogin: () => app.getLoginItemSettings().openAtLogin,
      setLaunchAtLogin: (enabled) =>
        app.setLoginItemSettings({
          openAtLogin: enabled,
          openAsHidden: enabled,
        }),
      canManageBackgroundService: backgroundState.supported,
      getBackgroundServiceEnabled: () => backgroundServiceEnabled,
      setBackgroundServiceEnabled: async (enabled) => {
        await options.runRuntime(options.runtime.setBackgroundServiceEnabled(enabled));
        const nextState = await options.runRuntime(options.runtime.backgroundServiceState);
        backgroundServiceEnabled = nextState.enabled;
      },
      checkForUpdates: () => updaterController?.check(true) ?? Promise.resolve(),
      installUpdate: () => void updaterController?.install(),
      loadState: loadTrayState,
      runSync: runTraySync,
      runRemoteSync: runTrayRemoteSync,
      updateSchedule: updateTraySchedule,
      openDashboardPath: options.window.openDashboardPath,
      openLogs: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      quit: () => app.quit(),
    });
    if (updaterController) trayController.setUpdateStatus(updaterController.getStatus());
  }

  return {
    checkForUpdates: (interactive) => updaterController?.check(interactive) ?? Promise.resolve(),
    createTray,
    destroy() {
      trayController?.destroy();
      trayController = null;
      updaterController?.destroy();
      updaterController = null;
      Menu.setApplicationMenu(null);
    },
    installUpdate: () => updaterController?.install() ?? Promise.resolve(),
    refreshTray: () => trayController?.refresh() ?? Promise.resolve(),
    start,
  };
}
