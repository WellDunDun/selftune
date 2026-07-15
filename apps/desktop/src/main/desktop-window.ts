import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BrowserWindow, session, shell, type IpcMainInvokeEvent, type Session } from "electron";

import { PENDING_WINDOW_IPC_TEST_DOCUMENT } from "../desktop-test-contract";
import { runtimeCrashHtml } from "./crash-screen";
import { errorReportingEnabled, reportRuntimeFailure } from "./diagnostics";
import { resolveInitialDashboardPath } from "./initial-path";
import type { SidecarConnection } from "./sidecar";
import {
  classifyDashboardNavigation,
  isInternalDashboardUrl,
  isSafeExternalUrl,
} from "./url-security";

export interface DesktopWindowControllerOptions {
  readonly checkForUpdates: (interactive: boolean) => Promise<void>;
  readonly quit: () => void;
}

export type TrustedIpcSource = "active" | "pending" | "recovery";

export interface DesktopWindowController {
  readonly assertTrustedIpc: (
    event: IpcMainInvokeEvent,
    completeTestProbe?: boolean,
  ) => TrustedIpcSource;
  readonly beginShutdown: () => void;
  readonly createInitial: (connection: SidecarConnection, show: boolean) => Promise<void>;
  readonly destroy: () => void;
  readonly openDashboardPath: (pathname: string) => Promise<void>;
  readonly rebindConnection: (connection: SidecarConnection) => Promise<void>;
  readonly show: () => Promise<void>;
  readonly showCrash: (cause: unknown) => Promise<void>;
}

interface AuthenticatedSession {
  readonly dispose: () => void;
  readonly session: Session;
}

interface PendingIpcProbeBarrier {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface OwnedWindow {
  readonly baseUrl: string | null;
  readonly dispose: () => void;
  readonly pendingIpcProbe: PendingIpcProbeBarrier | null;
  readonly window: BrowserWindow;
}

const preloadPath = fileURLToPath(new URL("../preload/index.js", import.meta.url));

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function configureSessionAuth(connection: SidecarConnection): AuthenticatedSession {
  const desktopSession = session.fromPartition(`selftune-desktop-${randomUUID()}`);
  desktopSession.webRequest.onBeforeSendHeaders(
    { urls: [`${connection.baseUrl}/*`] },
    (details, callback) => {
      details.requestHeaders.Authorization = `Bearer ${connection.authToken}`;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
  return {
    session: desktopSession,
    dispose: () => desktopSession.webRequest.onBeforeSendHeaders(null),
  };
}

function createPendingIpcProbeBarrier(): PendingIpcProbeBarrier | null {
  if (process.env.SELFTUNE_DESKTOP_TEST_PENDING_WINDOW_IPC !== "1") return null;
  let resolveBarrier = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveBarrier = resolve;
  });
  return { promise, resolve: resolveBarrier };
}

async function waitForPendingIpcProbe(barrier: PendingIpcProbeBarrier | null): Promise<void> {
  if (!barrier) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Pending-window IPC probe timed out after 10 seconds.")),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createDesktopWindowController(
  options: DesktopWindowControllerOptions,
): DesktopWindowController {
  let activeConnection: SidecarConnection | null = null;
  let mainWindow: OwnedWindow | null = null;
  let quitting = false;
  let recoveryMode = false;
  const pendingWindows = new Set<OwnedWindow>();

  function focus(): void {
    const current = mainWindow?.window;
    if (!current || current.isDestroyed()) return;
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
  }

  function releaseWindow(owned: OwnedWindow): void {
    pendingWindows.delete(owned);
    owned.dispose();
    if (!owned.window.isDestroyed()) owned.window.destroy();
    if (mainWindow === owned) mainWindow = null;
  }

  function claimWindow(owned: OwnedWindow): void {
    if (quitting || owned.window.isDestroyed()) {
      releaseWindow(owned);
      throw new Error("Desktop window creation was cancelled during shutdown.");
    }
    pendingWindows.delete(owned);
  }

  async function buildDashboardWindow(
    connection: SidecarConnection,
    initialPath: string,
  ): Promise<OwnedWindow> {
    if (quitting) throw new Error("Desktop window creation was cancelled during shutdown.");
    const initialUrl = new URL(initialPath, connection.baseUrl);
    const testProbeEnabled = process.env.SELFTUNE_DESKTOP_TEST_PENDING_WINDOW_IPC === "1";
    const navigationTrust = classifyDashboardNavigation(
      initialUrl.toString(),
      connection.baseUrl,
      testProbeEnabled ? PENDING_WINDOW_IPC_TEST_DOCUMENT : undefined,
    );
    if (navigationTrust === "blocked") {
      throw new Error("Desktop dashboard navigation must stay on the local SelfTune origin.");
    }
    const authenticatedSession =
      navigationTrust === "internal" ? configureSessionAuth(connection) : null;
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
        ...(authenticatedSession ? { session: authenticatedSession.session } : {}),
      },
    });
    let disposed = false;
    const owned: OwnedWindow = {
      baseUrl: connection.baseUrl,
      window,
      pendingIpcProbe: createPendingIpcProbeBarrier(),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        authenticatedSession?.dispose();
      },
    };
    pendingWindows.add(owned);

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isInternalDashboardUrl(url, connection.baseUrl)) return;
      event.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    });
    window.on("close", (event) => {
      if (quitting || process.platform !== "darwin") return;
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      pendingWindows.delete(owned);
      owned.dispose();
      if (mainWindow === owned) mainWindow = null;
    });

    try {
      await window.loadURL(
        initialUrl.toString(),
        navigationTrust === "internal"
          ? { extraHeaders: `Authorization: Bearer ${connection.authToken}\n` }
          : undefined,
      );
      await waitForPendingIpcProbe(owned.pendingIpcProbe);
      if (quitting || window.isDestroyed()) {
        throw new Error("Desktop window load was cancelled during shutdown.");
      }
      return owned;
    } catch (cause) {
      releaseWindow(owned);
      throw cause;
    }
  }

  async function createInitial(connection: SidecarConnection, shouldShow: boolean): Promise<void> {
    recoveryMode = false;
    const owned = await buildDashboardWindow(
      connection,
      resolveInitialDashboardPath({
        configDir: process.env.SELFTUNE_CONFIG_DIR,
        testPath: process.env.SELFTUNE_DESKTOP_TEST_PATH,
      }),
    );
    claimWindow(owned);
    const previous = mainWindow;
    activeConnection = connection;
    mainWindow = owned;
    if (previous) releaseWindow(previous);
    if (shouldShow) owned.window.show();

    const screenshotPath = process.env.SELFTUNE_DESKTOP_SCREENSHOT_PATH;
    if (screenshotPath) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000));
      const image = await owned.window.webContents.capturePage();
      writeFileSync(screenshotPath, image.toPNG());
      options.quit();
    }
  }

  async function rebindConnection(connection: SidecarConnection): Promise<void> {
    const previous = mainWindow;
    if (!previous || previous.window.isDestroyed()) {
      activeConnection = connection;
      return;
    }

    const wasVisible = previous.window.isVisible();
    const replacement = await buildDashboardWindow(connection, "/");
    claimWindow(replacement);
    activeConnection = connection;
    recoveryMode = false;
    mainWindow = replacement;
    releaseWindow(previous);
    if (wasVisible) replacement.window.show();
  }

  async function show(): Promise<void> {
    if (!activeConnection) {
      focus();
      return;
    }
    if (!mainWindow || mainWindow.window.isDestroyed()) {
      await createInitial(activeConnection, true);
      return;
    }
    focus();
  }

  async function openDashboardPath(pathname: string): Promise<void> {
    const connection = activeConnection;
    if (!connection) return;
    const url = new URL(pathname, connection.baseUrl);
    if (classifyDashboardNavigation(url.toString(), connection.baseUrl) !== "internal") {
      throw new Error("Desktop dashboard navigation must stay on the local SelfTune origin.");
    }
    if (recoveryMode || !mainWindow || mainWindow.window.isDestroyed()) {
      const previous = mainWindow;
      const owned = await buildDashboardWindow(connection, url.toString());
      claimWindow(owned);
      mainWindow = owned;
      recoveryMode = false;
      if (previous) releaseWindow(previous);
      owned.window.show();
      return;
    }
    await mainWindow.window.loadURL(url.toString(), {
      extraHeaders: `Authorization: Bearer ${connection.authToken}\n`,
    });
    focus();
  }

  async function showCrash(cause: unknown): Promise<void> {
    if (quitting) return;
    recoveryMode = true;
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    reportRuntimeFailure("SelfTune local runtime recovery failed", detail);

    if (!mainWindow || mainWindow.window.isDestroyed()) {
      const window = new BrowserWindow({
        width: 760,
        height: 620,
        minWidth: 620,
        minHeight: 520,
        show: false,
        backgroundColor: "#101214",
        title: "SelfTune Recovery",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: preloadPath,
        },
      });
      let disposed = false;
      const owned: OwnedWindow = {
        baseUrl: null,
        window,
        pendingIpcProbe: null,
        dispose: () => {
          disposed = true;
        },
      };
      window.once("ready-to-show", () => window.show());
      window.on("closed", () => {
        if (disposed) return;
        disposed = true;
        if (mainWindow === owned) mainWindow = null;
      });
      mainWindow = owned;
    }
    await mainWindow.window.loadURL(
      htmlDataUrl(runtimeCrashHtml({ detail, reported: errorReportingEnabled })),
    );
    focus();
    void options.checkForUpdates(false);
  }

  function assertTrustedIpc(
    event: IpcMainInvokeEvent,
    completeTestProbe = false,
  ): TrustedIpcSource {
    const active = mainWindow;
    const current = active?.window;
    let owner =
      current && !current.isDestroyed() && event.sender === current.webContents ? active : null;
    if (!owner) {
      for (const candidate of pendingWindows) {
        if (!candidate.window.isDestroyed() && event.sender === candidate.window.webContents) {
          owner = candidate;
          break;
        }
      }
    }
    if (!owner) {
      throw new Error("Desktop request did not come from the active SelfTune window.");
    }
    try {
      const senderUrl = event.senderFrame?.url;
      if (owner === active && recoveryMode && senderUrl?.startsWith("data:text/html")) {
        return "recovery";
      }
      if (senderUrl && owner.baseUrl && isInternalDashboardUrl(senderUrl, owner.baseUrl)) {
        return owner === active ? "active" : "pending";
      }
      throw new Error("Desktop request did not come from the local SelfTune origin.");
    } finally {
      if (completeTestProbe) owner.pendingIpcProbe?.resolve();
    }
  }

  return {
    assertTrustedIpc,
    beginShutdown() {
      quitting = true;
      for (const pending of pendingWindows) releaseWindow(pending);
    },
    createInitial,
    destroy() {
      const current = mainWindow;
      mainWindow = null;
      if (current) releaseWindow(current);
      for (const pending of pendingWindows) releaseWindow(pending);
    },
    openDashboardPath,
    rebindConnection,
    show,
    showCrash,
  };
}
