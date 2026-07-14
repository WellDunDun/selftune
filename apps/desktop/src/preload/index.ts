import { contextBridge, ipcRenderer } from "electron";

const desktop = {
  getRuntime(): Promise<{ version: string; platform: NodeJS.Platform }> {
    return ipcRenderer.invoke("selftune:runtime");
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("selftune:open-external", url);
  },
} as const;

contextBridge.exposeInMainWorld("selftuneDesktop", desktop);

export type SelfTuneDesktopBridge = typeof desktop;
