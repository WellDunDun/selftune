import { homedir, userInfo } from "node:os";

import { BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerManifest } from "./local-runtime.js";
import {
  getDaemonStatus,
  manifestMatchesStopExpectation,
  stopDaemon,
  type DaemonStatus,
  type RuntimeStopExpectation,
} from "./daemon.js";
import { runServiceProcess as runCancellableServiceProcess } from "./service-process.js";
import { prepareServiceDirectories } from "./service/directories.js";
import { makeLaunchdBackendLayer } from "./service/launchd/backend.js";
import { makeSystemdBackendLayer } from "./service/systemd/backend.js";
import {
  makeLiveWindowsServiceBackendLayer,
  WindowsBackendProvider,
} from "./service/windows/backend.js";
import { runWindowsServiceCommand } from "./service/windows/orchestration.js";
import { makeWindowsRuntimeRecoveryLayer } from "./service/windows/runtime/live.js";
import { observeWindowsServiceStatus } from "./service/windows/status.js";
import {
  ServiceManager,
  ServiceBackendProvider,
  WindowsRuntimeRecoveryProvider,
  serviceFailure,
  type ServiceBackend,
  type ServiceCommandResponse,
  type ServiceDescriptor,
  type ServiceStatus,
} from "./service-contract.js";

export { serviceEnvironment, serviceProgramArguments } from "./service-definition.js";
export {
  generateLaunchdPlist,
  launchdPlistPath,
  type LaunchdPlistOptions,
} from "./service/launchd/backend.js";
export {
  generateSystemdUnit,
  systemdLingerArguments,
  systemdLingerMarkerPath,
  systemdUnitPath,
  type SystemdUnitOptions,
} from "./service/systemd/backend.js";
export {
  generateWindowsDaemonWrapper,
  generateWindowsHiddenLauncher,
  generateWindowsTaskXml,
  WINDOWS_TASK_NAME,
} from "./service/windows/installation/definition.js";
export {
  ServiceFailure,
  ServiceManager,
  serviceFailure,
  type LocalRuntimeControl,
  type ServiceBackend,
  type ServiceCommandResponse,
  type ServiceDescriptor,
  type ServicePlatform,
  type ServiceStatus,
  type WindowsServiceBackend,
  type WindowsRuntimeRecovery,
} from "./service-contract.js";

const runCommand = Effect.fn("SelfTuneService.runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  environment?: Record<string, string | undefined>,
) {
  return yield* runCancellableServiceProcess(command, args, environment, serviceFailure);
});

export const runServiceProcess = runCommand;

function currentUid(): number {
  return process.getuid?.() ?? userInfo().uid;
}

function makeWindowsBackendLayer() {
  const windows = makeLiveWindowsServiceBackendLayer({
    prepareDirectories: (configDir) =>
      Effect.try({
        try: () => prepareServiceDirectories(configDir),
        catch: (cause) => serviceFailure("prepare-windows-service-directories", cause),
      }),
    run: runCommand,
    systemRoot: process.env.SystemRoot,
  });
  return Layer.effect(ServiceBackendProvider)(Effect.service(WindowsBackendProvider)).pipe(
    Layer.provide(windows),
  );
}

function makeUnsupportedBackend(platform: NodeJS.Platform): ServiceBackend {
  const unsupported = (operation: string) =>
    Effect.fail(
      serviceFailure(operation, `OS service management is not supported on ${platform}.`),
    );
  return {
    platform: "unsupported",
    automated: false,
    install: () => unsupported("install"),
    uninstall: () => unsupported("uninstall"),
    status: (_descriptor) =>
      Effect.succeed({
        platform: "unsupported",
        registered: false,
        running: false,
        pid: null,
        detail: [`OS service management is not supported on ${platform}.`],
      }),
    start: (_descriptor) => unsupported("start"),
    stop: (_descriptor) => unsupported("stop"),
    restart: (_descriptor) => unsupported("restart"),
  };
}

export function getServiceBackendLayer(platform: NodeJS.Platform = process.platform) {
  switch (platform) {
    case "darwin":
      return makeLaunchdBackendLayer({
        homeDirectory: homedir(),
        run: runCommand,
        uid: currentUid(),
      });
    case "linux":
      return makeSystemdBackendLayer({
        homeDirectory: homedir(),
        run: runCommand,
        uid: currentUid(),
        username: userInfo().username,
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
        xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
      });
    case "win32":
      return makeWindowsBackendLayer();
    default:
      return Layer.succeed(ServiceBackendProvider)(makeUnsupportedBackend(platform));
  }
}

/** Synchronous adapter for callers outside the managed service runtime. */
export function getServiceBackend(platform: NodeJS.Platform = process.platform): ServiceBackend {
  return Effect.runSync(
    Effect.service(ServiceBackendProvider).pipe(Effect.provide(getServiceBackendLayer(platform))),
  );
}

const ServiceDependenciesLive = Layer.mergeAll(
  getServiceBackendLayer(),
  makeWindowsRuntimeRecoveryLayer(runCommand),
);
export const ServiceManagerLive = Layer.effect(ServiceManager)(
  Effect.gen(function* () {
    const backend = yield* ServiceBackendProvider;
    const windowsRecovery = yield* WindowsRuntimeRecoveryProvider;
    return { backend, runtime: { status: getDaemonStatus, stop: stopDaemon }, windowsRecovery };
  }),
).pipe(Layer.provide(ServiceDependenciesLive));

function withManifestDetail(status: ServiceStatus, daemon: DaemonStatus): ServiceStatus {
  const manifest = daemon.manifest;
  if (!daemon.reachable || manifest?.supervision !== "os-service") return status;
  return {
    ...status,
    detail: [
      ...status.detail,
      `Serving ${manifest.origin} (pid ${manifest.pid}, SelfTune ${manifest.owner_version}, ${manifest.owner}-owned).`,
    ],
  };
}

function serviceRuntimeExpectation(status: DaemonStatus): RuntimeStopExpectation | null {
  const manifest = status.manifest;
  return manifest?.supervision === "os-service"
    ? { instanceId: manifest.instance_id, pid: manifest.pid }
    : null;
}

export function serviceRuntimeIsReady(
  status: ServiceStatus,
  daemon: DaemonStatus,
  installedDescriptor?: ServiceDescriptor,
): boolean {
  const manifest = daemon.manifest;
  return (
    status.running &&
    daemon.reachable &&
    manifest?.supervision === "os-service" &&
    (status.pid === null || status.pid === manifest.pid) &&
    (installedDescriptor === undefined ||
      (manifest.owner === installedDescriptor.owner &&
        manifest.port === installedDescriptor.port &&
        manifest.owner_version === installedDescriptor.version &&
        manifest.owner_executable_path === installedDescriptor.executablePath))
  );
}

export function expectedRuntimeIsPresent(
  manifest: ServerManifest | null,
  expectation: RuntimeStopExpectation | null,
): boolean {
  return expectation !== null && manifest !== null
    ? manifestMatchesStopExpectation(manifest, expectation)
    : false;
}

export const runServiceCommand = Effect.fn("SelfTuneService.command")(function* (
  action: ServiceCommandResponse["action"],
  descriptor: ServiceDescriptor,
) {
  const manager = yield* ServiceManager;
  const backend = manager.backend;
  const stopOwnedRuntime = (operation: string, expectation?: RuntimeStopExpectation) =>
    manager.runtime
      .stop(descriptor.configDir, expectation)
      .pipe(Effect.mapError((cause) => serviceFailure(operation, cause)));
  if (backend.platform === "win32") {
    const status =
      action === "status"
        ? yield* observeWindowsServiceStatus(descriptor, backend, manager.windowsRecovery)
        : yield* runWindowsServiceCommand(
            action,
            descriptor,
            backend,
            manager.runtime,
            manager.windowsRecovery,
          );
    return {
      ok: true,
      action,
      status,
    } satisfies ServiceCommandResponse;
  }
  const expectsStopped = action === "stop" || action === "uninstall";
  const runtimeBeforeAction = expectsStopped
    ? yield* manager.runtime
        .status(descriptor.configDir)
        .pipe(Effect.mapError((cause) => serviceFailure(`${action}-runtime-status`, cause)))
    : null;
  const serviceRuntimeBeforeAction = runtimeBeforeAction
    ? serviceRuntimeExpectation(runtimeBeforeAction)
    : null;
  switch (action) {
    case "install":
      yield* stopOwnedRuntime("install-takeover");
      yield* backend.install(descriptor);
      break;
    case "uninstall":
      yield* backend.uninstall(descriptor);
      break;
    case "start":
      yield* backend.start(descriptor);
      break;
    case "stop":
      yield* backend.stop(descriptor);
      break;
    case "restart":
      yield* backend.restart(descriptor);
      break;
    case "status":
      break;
  }
  const expectsRunning = action === "install" || action === "restart" || action === "start";
  let status = yield* backend.status(descriptor);
  let daemonStatus: DaemonStatus = { manifest: null, reachable: false };
  if (expectsRunning || expectsStopped) {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      status = yield* backend.status(descriptor);
      daemonStatus = yield* manager.runtime
        .status(descriptor.configDir)
        .pipe(Effect.catch(() => Effect.succeed({ manifest: null, reachable: false })));
      ready = expectsRunning
        ? serviceRuntimeIsReady(status, daemonStatus, action === "install" ? descriptor : undefined)
        : !status.running &&
          !expectedRuntimeIsPresent(daemonStatus.manifest, serviceRuntimeBeforeAction) &&
          (action !== "uninstall" || !status.registered);
      if (ready) break;
      yield* Effect.sleep(250);
    }
    if (!ready) {
      return yield* Effect.fail(
        serviceFailure(
          action,
          expectsRunning
            ? "The service did not become healthy within 20 seconds."
            : "The service did not stop cleanly within 20 seconds.",
        ),
      );
    }
  } else {
    daemonStatus = yield* manager.runtime
      .status(descriptor.configDir)
      .pipe(Effect.catch(() => Effect.succeed({ manifest: null, reachable: false })));
  }
  return {
    ok: true,
    action,
    status: withManifestDetail(status, daemonStatus),
  } satisfies ServiceCommandResponse;
});

export async function cliMain(): Promise<void> {
  const { serviceCliProgram } = await import("./service-programs.js");
  await Effect.runPromise(serviceCliProgram(process.argv.slice(2)));
}

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.promise(() => import("./service-programs.js")).pipe(
      Effect.flatMap(({ serviceCliProgram }) => serviceCliProgram(process.argv.slice(2))),
    ),
  );
}
