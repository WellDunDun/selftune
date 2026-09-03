import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";

const nativeUpdater = new EventEmitter();
const events: string[] = [];
let closingAllowed = false;
const autoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  checkForUpdates: async () => ({ isUpdateAvailable: true }),
  quitAndInstall: () => {
    nativeUpdater.emit("before-quit-for-update");
    events.push(closingAllowed ? "windows-closed" : "close-prevented");
    if (closingAllowed) events.push("before-quit");
  },
});

mock.module("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.4.9" },
  autoUpdater: nativeUpdater,
  dialog: { showMessageBox: async () => ({ response: 1 }) },
}));
mock.module("electron-updater", () => ({ default: { autoUpdater } }));

const { createDesktopUpdater } = await import("./updater");
const controllers: ReturnType<typeof createDesktopUpdater>[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.destroy();
  events.length = 0;
  closingAllowed = false;
});

describe("update restart lifecycle", () => {
  it("allows window closure before Electron emits the ordinary before-quit event", async () => {
    const controller = createDesktopUpdater(
      () => undefined,
      async () => {
        events.push("runtime-prepared");
      },
      () => {
        closingAllowed = true;
        events.push("allow-close");
      },
    );
    controllers.push(controller);
    autoUpdater.emit("update-downloaded", { version: "0.4.10" });
    await controller.install();
    expect(events).toEqual(["runtime-prepared", "allow-close", "windows-closed", "before-quit"]);
    controller.destroy();
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);
  });

  it("does not enter quitting state when runtime preparation fails", async () => {
    const controller = createDesktopUpdater(
      () => undefined,
      async () => {
        throw new Error("runtime busy");
      },
      () => {
        closingAllowed = true;
      },
    );
    controllers.push(controller);
    autoUpdater.emit("update-downloaded", { version: "0.4.10" });
    await expect(controller.install()).rejects.toThrow("runtime busy");
    expect(closingAllowed).toBe(false);
    expect(events).toEqual([]);
  });
});
