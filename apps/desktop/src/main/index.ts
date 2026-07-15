import { mkdirSync } from "node:fs";

import { app } from "electron";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { initializeDiagnostics, logRuntimeEvent } from "./diagnostics";
import { registerDesktopIpc, type DesktopIpcController } from "./desktop-ipc";
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

let desktopShell: DesktopShellController | null = null;
let desktopIpc: DesktopIpcController | null = null;
let desktopRuntimeService: DesktopRuntimeService | null = null;
let shutdownStarted = false;
let shutdownComplete = false;

const desktopWindow = createDesktopWindowController({
  checkForUpdates: (interactive) => desktopShell?.checkForUpdates(interactive) ?? Promise.resolve(),
  quit: () => app.quit(),
});

const runtimeDependencies = makeLiveDesktopRuntimeDependencies();
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
    configDir: runtimeDependencies.configDir,
    runRuntime,
    runtime,
    shell: desktopShell,
    window: desktopWindow,
  });

  await runRuntime(runtime.boot);
  const connection = await runRuntime(runtime.connection);
  if (!connection) throw new Error("SelfTune local runtime booted without an active connection.");

  await desktopShell.createTray();
  const openedAtLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  await desktopWindow.createInitial(connection, !openedAtLogin);
  void desktopShell.checkForUpdates(false);
}

function beginShutdown(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  desktopWindow.beginShutdown();
  desktopIpc?.destroy();
  desktopIpc = null;
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
  app.quit();
} else {
  app.on("second-instance", () => void desktopWindow.show());
  app
    .whenReady()
    .then(boot)
    .catch((cause: unknown) => {
      if (!shutdownStarted) void desktopWindow.showCrash(cause);
    });
}
