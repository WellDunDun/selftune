import { contextBridge, ipcRenderer } from "electron";

import { PENDING_WINDOW_IPC_TEST_CHANNEL } from "../desktop-test-contract";

type PendingWindowIpcProbe =
  | { readonly ok: true; readonly source: unknown }
  | { readonly ok: false; readonly message: string };

function createPendingWindowIpcProbe(): Promise<PendingWindowIpcProbe> {
  return new Promise((resolveProbe) => {
    const runProbe = (): void => {
      void ipcRenderer.invoke(PENDING_WINDOW_IPC_TEST_CHANNEL).then(
        (source: unknown) => resolveProbe({ ok: true, source }),
        (cause: unknown) =>
          resolveProbe({
            ok: false,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      );
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", runProbe, { once: true });
      return;
    }
    runProbe();
  });
}

const pendingWindowIpcProbe =
  process.env.SELFTUNE_DESKTOP_TEST_PENDING_WINDOW_IPC === "1"
    ? createPendingWindowIpcProbe()
    : null;

const desktop = {
  getRuntime(): Promise<{ version: string; platform: NodeJS.Platform }> {
    return ipcRenderer.invoke("selftune:runtime");
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("selftune:open-external", url);
  },
  openFolder(path: string): Promise<void> {
    return ipcRenderer.invoke("selftune:open-folder", path);
  },
  restartService(): Promise<void> {
    return ipcRenderer.invoke("selftune:restart-service");
  },
  checkForUpdates(): Promise<void> {
    return ipcRenderer.invoke("selftune:check-for-updates");
  },
  getBackgroundService(): Promise<{
    detail: ReadonlyArray<string>;
    enabled: boolean;
    platform: NodeJS.Platform;
    running: boolean;
    supported: boolean;
  }> {
    return ipcRenderer.invoke("selftune:background-service");
  },
  setBackgroundService(enabled: boolean): Promise<{
    detail: ReadonlyArray<string>;
    enabled: boolean;
    platform: NodeJS.Platform;
    running: boolean;
    supported: boolean;
  }> {
    return ipcRenderer.invoke("selftune:set-background-service", enabled);
  },
  exportDiagnostics(): Promise<void> {
    return ipcRenderer.invoke("selftune:export-diagnostics");
  },
  resetLocalState(): Promise<boolean> {
    return ipcRenderer.invoke("selftune:reset-local-state");
  },
} as const;

contextBridge.exposeInMainWorld("selftuneDesktop", desktop);
if (pendingWindowIpcProbe) {
  contextBridge.exposeInMainWorld("selftuneDesktopTest", {
    pendingWindowIpc: () => pendingWindowIpcProbe,
  });
}

export type SelfTuneDesktopBridge = typeof desktop;
