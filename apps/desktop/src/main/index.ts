import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app } from "electron";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { initializeDiagnostics, logRuntimeEvent } from "./diagnostics";
import { startDevelopmentSidecarReloader } from "./development-sidecar-reloader";
import { detectDesktopInstallerAgents } from "./desktop-agent-detection";
import { registerDesktopIpc, type DesktopIpcController } from "./desktop-ipc";
import { createDesktopInstallBootstrapController } from "./desktop-install-bootstrap";
import { createDesktopInstallHandoffEventBridge } from "./desktop-install-handoff-events";
import {
  createDesktopRecipientPreviewResolver,
  loadSecureDesktopCloudSession,
} from "./desktop-recipient-preview";
import {
  compiledDesktopReleaseTrustPins,
  isTrustedPackagedDesktopBuild,
  registerDesktopProtocol,
} from "./desktop-protocol";
import {
  DesktopRuntime,
  makeDesktopRuntimeLayer,
  type DesktopRuntimeError,
  type DesktopRuntimeService,
} from "./desktop-runtime";
import { makeLiveDesktopRuntimeDependencies } from "./desktop-runtime-live";
import { createDesktopShell, type DesktopShellController } from "./desktop-shell";
import { createDesktopWindowController } from "./desktop-window";
import { testUserDataDirectory } from "./runtime-ownership";

app.setName("SelfTune");
const isolatedUserDataDirectory = testUserDataDirectory(process.env.SELFTUNE_DESKTOP_USER_DATA_DIR);
if (isolatedUserDataDirectory) {
  mkdirSync(isolatedUserDataDirectory, { recursive: true, mode: 0o700 });
  app.setPath("userData", isolatedUserDataDirectory);
}
initializeDiagnostics();

const desktopReleaseTrustPins = compiledDesktopReleaseTrustPins(process.platform);
const trustedPackagedBuild = isTrustedPackagedDesktopBuild({
  isPackaged: app.isPackaged,
  platform: process.platform,
  executablePath: process.execPath,
  pins: desktopReleaseTrustPins,
});

let desktopShell: DesktopShellController | null = null;
let desktopIpc: DesktopIpcController | null = null;
let desktopRuntimeService: DesktopRuntimeService | null = null;
let stopDevelopmentSidecarReloader: (() => void) | null = null;
let shutdownStarted = false;
let shutdownComplete = false;

const desktopWindow = createDesktopWindowController({
  checkForUpdates: (interactive) => desktopShell?.checkForUpdates(interactive) ?? Promise.resolve(),
  quit: () => app.quit(),
});

const runtimeDependencies = makeLiveDesktopRuntimeDependencies();
const desktopInstallBootstrap = createDesktopInstallBootstrapController({
  trustedBuild: trustedPackagedBuild,
  resolvePreview: createDesktopRecipientPreviewResolver({
    loadSession: () =>
      loadSecureDesktopCloudSession(join(runtimeDependencies.configDir, "config.json")),
  }),
  detectAgents: async () => detectDesktopInstallerAgents(homedir(), existsSync),
});
const desktopInstallHandoffEvents = createDesktopInstallHandoffEventBridge({
  controller: desktopInstallBootstrap,
  show: desktopWindow.show,
});
const desktopRuntime = ManagedRuntime.make(
  makeDesktopRuntimeLayer(runtimeDependencies, {
    rebindConnection: desktopWindow.rebindConnection,
    onConnectionActivated: () => desktopShell?.refreshTray() ?? Promise.resolve(),
    onRecoveryFailed: desktopWindow.showCrash,
  }),
);

function runRuntime<A>(effect: Effect.Effect<A, DesktopRuntimeError>): Promise<A> {
  return desktopRuntime.runPromise(effect);
}

async function boot(): Promise<void> {
  desktopWindow.showLaunching();
  const runtime: DesktopRuntimeService = await desktopRuntime.runPromise(
    Effect.gen(function* () {
      return yield* DesktopRuntime;
    }),
  );
  desktopRuntimeService = runtime;
  desktopShell = createDesktopShell({
    configDir: runtimeDependencies.configDir,
    runRuntime,
    runtime,
    window: desktopWindow,
  });
  desktopShell.start();
  desktopIpc = registerDesktopIpc({
    bootstrap: desktopInstallBootstrap,
    configDir: runtimeDependencies.configDir,
    runRuntime,
    runtime,
    shell: desktopShell,
    trustedBuild: trustedPackagedBuild,
    window: desktopWindow,
  });

  await runRuntime(runtime.boot);
  const connection = await runRuntime(runtime.connection);
  if (!connection) throw new Error("SelfTune local runtime booted without an active connection.");

  await desktopShell.createTray();
  const openedAtLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  await desktopWindow.createInitial(connection, !openedAtLogin);
  desktopInstallHandoffEvents.markReady();
  stopDevelopmentSidecarReloader = startDevelopmentSidecarReloader({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    onError: (cause) =>
      logRuntimeEvent("error", "SelfTune development sidecar reload failed", cause),
    restart: () => runRuntime(runtime.restart),
  });
  void desktopShell.checkForUpdates(false);
}

function beginShutdown(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopDevelopmentSidecarReloader?.();
  stopDevelopmentSidecarReloader = null;
  desktopWindow.beginShutdown();
  desktopIpc?.destroy();
  desktopIpc = null;
  desktopInstallBootstrap.destroy();
  desktopShell?.destroy();
  desktopShell = null;
  const shutdownRuntime = desktopRuntimeService
    ? runRuntime(desktopRuntimeService.shutdown)
    : Promise.resolve();
  desktopRuntimeService = null;
  void shutdownRuntime
    .catch((cause: unknown) => {
      logRuntimeEvent("error", "SelfTune desktop runtime shutdown failed", cause);
    })
    .then(() => desktopRuntime.dispose())
    .catch((cause: unknown) => {
      logRuntimeEvent("error", "SelfTune desktop scope disposal failed", cause);
    })
    .finally(() => {
      desktopWindow.destroy();
      shutdownComplete = true;
      app.quit();
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  void desktopWindow.show();
});
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  beginShutdown();
});

if (!app.requestSingleInstanceLock()) {
  desktopInstallBootstrap.destroy();
  app.quit();
} else {
  desktopInstallHandoffEvents.coldStart(process.argv);
  app.on("open-url", (event, url) => {
    desktopInstallHandoffEvents.openUrl(event, url);
  });
  app.on("second-instance", (_event, argv) => {
    const result = desktopInstallHandoffEvents.secondInstance(argv);
    if (!result.accepted) void desktopWindow.show();
  });
  app
    .whenReady()
    .then(() => {
      registerDesktopProtocol(app, trustedPackagedBuild);
      return boot();
    })
    .catch((cause: unknown) => {
      if (!shutdownStarted) void desktopWindow.showCrash(cause);
    });
}
