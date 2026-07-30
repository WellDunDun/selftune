import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PENDING_WINDOW_IPC_TEST_CHANNEL } from "../desktop-test-contract";
import { exportDiagnosticsInteractive } from "./diagnostics";
import {
  decodeBackgroundServiceEnabled,
  decodeDesktopBootstrapNoInput,
  decodeExistingAbsoluteDirectory,
} from "./desktop-ipc-input";
import type { DesktopInstallBootstrapController } from "./desktop-install-bootstrap";
import type { DesktopRuntimeError, DesktopRuntimeService } from "./desktop-runtime";
import type { DesktopShellController } from "./desktop-shell";
import type { DesktopWindowController } from "./desktop-window";
import { isSafeExternalUrl } from "./url-security";
import { createDesktopThisMacProfile } from "./this-mac-profile";

const IPC_CHANNELS = [
  "selftune:runtime",
  "selftune:this-mac-profile",
  "selftune:focus",
  "selftune:open-external",
  "selftune:open-folder",
  "selftune:choose-folder",
  "selftune:restart-service",
  "selftune:check-for-updates",
  "selftune:background-service",
  "selftune:set-background-service",
  "selftune:export-diagnostics",
  "selftune:reset-local-state",
  "selftune:install-bootstrap-state",
  "selftune:install-bootstrap-preview",
  PENDING_WINDOW_IPC_TEST_CHANNEL,
] as const;

export interface DesktopIpcOptions {
  readonly bootstrap: DesktopInstallBootstrapController;
  readonly configDir: string;
  readonly runRuntime: <A>(effect: Effect.Effect<A, DesktopRuntimeError>) => Promise<A>;
  readonly runtime: DesktopRuntimeService;
  readonly shell: DesktopShellController;
  readonly trustedBuild: boolean;
  readonly window: DesktopWindowController;
}

export interface DesktopIpcController {
  readonly destroy: () => void;
}

export function registerDesktopIpc(options: DesktopIpcOptions): DesktopIpcController {
  ipcMain.handle("selftune:runtime", (event) => {
    options.window.assertTrustedIpc(event);
    return {
      version: app.getVersion(),
      platform: process.platform,
    };
  });
  ipcMain.handle("selftune:this-mac-profile", async (event) => {
    options.window.assertTrustedIpc(event);
    const connection = await options.runRuntime(options.runtime.connection);
    return connection ? createDesktopThisMacProfile(connection) : null;
  });
  ipcMain.handle("selftune:focus", (event) => {
    options.window.assertTrustedIpc(event);
    return options.window.show();
  });
  if (process.env.SELFTUNE_DESKTOP_TEST_PENDING_WINDOW_IPC === "1") {
    ipcMain.handle(PENDING_WINDOW_IPC_TEST_CHANNEL, (event) =>
      options.window.assertTrustedIpc(event, true),
    );
  }
  ipcMain.handle("selftune:open-external", (event, input: unknown) => {
    options.window.assertTrustedIpc(event);
    let url: string;
    try {
      url = Schema.decodeUnknownSync(Schema.String)(input);
    } catch {
      throw new Error("Only HTTPS links can be opened outside SelfTune.");
    }
    if (!isSafeExternalUrl(url)) {
      throw new Error("Only HTTPS links can be opened outside SelfTune.");
    }
    return shell.openExternal(url);
  });
  ipcMain.handle("selftune:open-folder", async (event, input: unknown) => {
    options.window.assertTrustedIpc(event);
    const error = await shell.openPath(decodeExistingAbsoluteDirectory(input));
    if (error) throw new Error(error);
  });
  ipcMain.handle("selftune:choose-folder", async (event) => {
    options.window.assertTrustedIpc(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Could not open the folder picker for this window.");
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("selftune:restart-service", async (event) => {
    options.window.assertTrustedIpc(event);
    try {
      await options.runRuntime(options.runtime.restart);
    } catch (cause) {
      await options.window.showCrash(cause);
      throw cause;
    }
  });
  ipcMain.handle("selftune:check-for-updates", (event) => {
    options.window.assertTrustedIpc(event);
    return options.shell.checkForUpdates(true);
  });
  ipcMain.handle("selftune:background-service", (event) => {
    options.window.assertTrustedIpc(event);
    return options.runRuntime(options.runtime.backgroundServiceState);
  });
  ipcMain.handle("selftune:set-background-service", async (event, input: unknown) => {
    options.window.assertTrustedIpc(event);
    await options.runRuntime(
      options.runtime.setBackgroundServiceEnabled(decodeBackgroundServiceEnabled(input)),
    );
    return options.runRuntime(options.runtime.backgroundServiceState);
  });
  ipcMain.handle("selftune:export-diagnostics", (event) => {
    options.window.assertTrustedIpc(event);
    return exportDiagnosticsInteractive(options.configDir);
  });
  ipcMain.handle("selftune:reset-local-state", async (event) => {
    options.window.assertTrustedIpc(event);
    try {
      return await options.runRuntime(options.runtime.resetLocalState);
    } catch (cause) {
      await options.window.showCrash(cause);
      throw cause;
    }
  });
  if (options.trustedBuild) {
    ipcMain.handle("selftune:install-bootstrap-state", (event, ...input: unknown[]) => {
      options.window.assertTrustedIpc(event);
      decodeDesktopBootstrapNoInput(input);
      return options.bootstrap.publicState();
    });
    ipcMain.handle("selftune:install-bootstrap-preview", (event, ...input: unknown[]) => {
      options.window.assertTrustedIpc(event);
      decodeDesktopBootstrapNoInput(input);
      return options.bootstrap.preview();
    });
  }

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}
