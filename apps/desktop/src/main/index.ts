import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { app, BrowserWindow, ipcMain, session, shell } from "electron";

import { startSidecar, stopSidecar, type SidecarConnection } from "./sidecar";

app.setName("SelfTune");

let mainWindow: BrowserWindow | null = null;
let connection: SidecarConnection | null = null;
let quitting = false;

const preloadPath = fileURLToPath(new URL("../preload/index.js", import.meta.url));

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

async function createMainWindow(activeConnection: SidecarConnection): Promise<void> {
  const desktopSession = session.fromPartition("persist:selftune-desktop");
  desktopSession.webRequest.onBeforeSendHeaders(
    { urls: [`${activeConnection.baseUrl}/*`] },
    (details, callback) => {
      details.requestHeaders.Authorization = `Bearer ${activeConnection.authToken}`;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#111317",
    title: "SelfTune",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      session: desktopSession,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(activeConnection.baseUrl)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const initialUrl = new URL(
    process.env.SELFTUNE_DESKTOP_TEST_PATH ?? "/",
    activeConnection.baseUrl,
  );
  await window.loadURL(initialUrl.toString(), {
    extraHeaders: `Authorization: Bearer ${activeConnection.authToken}\n`,
  });

  const screenshotPath = process.env.SELFTUNE_DESKTOP_SCREENSHOT_PATH;
  if (screenshotPath) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000));
    const image = await window.webContents.capturePage();
    writeFileSync(screenshotPath, image.toPNG());
    app.quit();
  }
}

async function boot(): Promise<void> {
  connection = await startSidecar();
  await createMainWindow(connection);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app
    .whenReady()
    .then(boot)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      void BrowserWindow.getFocusedWindow()?.webContents.executeJavaScript(
        `document.body.textContent = ${JSON.stringify(`SelfTune failed to start: ${message}`)}`,
      );
      console.error(message);
      app.quit();
    });
}

ipcMain.handle("selftune:runtime", () => ({
  version: app.getVersion(),
  platform: process.platform,
}));
ipcMain.handle("selftune:open-external", (_event, url: unknown) => {
  if (typeof url !== "string" || !isSafeExternalUrl(url)) {
    throw new Error("Only HTTPS links can be opened outside SelfTune.");
  }
  return shell.openExternal(url);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !connection) return;
  event.preventDefault();
  quitting = true;
  const activeConnection = connection;
  connection = null;
  void stopSidecar(activeConnection).finally(() => app.quit());
});
