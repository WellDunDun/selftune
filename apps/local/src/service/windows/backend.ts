import { Buffer } from "node:buffer";
import { userInfo } from "node:os";
import { win32 } from "node:path";

import * as Effect from "effect/Effect";

import { serviceProgramArguments } from "../../service-definition.js";
import {
  serviceFailure,
  type ServiceDescriptor,
  type ServiceFailure,
  type WindowsServiceBackend,
} from "../../service-contract.js";
import {
  makeWindowsServiceInstallationController,
  type WindowsServiceInstallationControllerDependencies,
  type WindowsServiceInstallationPlan,
} from "./installation/controller.js";
import type { WindowsServiceInstallationEvidence } from "./installation/contract.js";
import {
  makeLiveWindowsServiceInstallationArtifactStore,
  makeLiveWindowsServiceInstallationStore,
} from "./installation/live.js";
import {
  makeLiveWindowsUserServiceMutationLock,
  type WindowsUserServiceMutationLock,
} from "./mutation-lock.js";
import {
  makeLiveWindowsServiceLockCompatibility,
  type WindowsServiceLockCompatibility,
} from "./lock-compatibility.js";
import type { WindowsServiceInstallationStoreWithUserControl } from "./installation/store.js";
import { sha256Hex, type WindowsServiceInstallationReceipt } from "./installation/model.js";
import {
  generateWindowsDaemonWrapper,
  generateWindowsHiddenLauncher,
  generateLegacyWindowsDaemonWrapper,
  generateLegacyWindowsTaskXml,
  generateWindowsTaskXml,
  legacyWindowsUserId,
  matchesLegacyWindowsDaemonWrapper,
  type WindowsLegacyUserIdentity,
  WINDOWS_TASK_NAME,
} from "./installation/definition.js";
import { makeWindowsTaskScheduler, windowsSystemExecutable } from "./scheduler.js";
import type { WindowsRuntimeAuthorization } from "./runtime/contract.js";
import { windowsStatusFromEvidence } from "./status.js";
import type { ServiceProcessResult } from "../../service-process.js";

const WINDOWS_ARTIFACT_MODE = "utf8";

export type WindowsServiceBackendPlan = WindowsServiceInstallationPlan;

export type WindowsServiceAuthorization =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Legacy";
      readonly runtime: WindowsRuntimeAuthorization | null;
    }
  | {
      readonly _tag: "LegacyCleanupPending";
      readonly runtime: WindowsRuntimeAuthorization;
    }
  | {
      readonly _tag: "Owned";
      readonly receipt: WindowsServiceInstallationReceipt;
      readonly runtime: WindowsRuntimeAuthorization;
    }
  | {
      readonly _tag: "OwnedIncomplete";
      readonly receipt: WindowsServiceInstallationReceipt;
      readonly runtime: WindowsRuntimeAuthorization;
    }
  | {
      readonly _tag: "Refused";
      readonly reason: string;
    };

export interface WindowsServiceBackendDependencies extends WindowsServiceInstallationControllerDependencies {
  readonly legacyUser: WindowsLegacyUserIdentity;
  readonly lockCompatibility: WindowsServiceLockCompatibility;
  readonly mutationLock: WindowsUserServiceMutationLock;
  readonly prepareDirectories: (configDir: string) => Effect.Effect<void, ServiceFailure>;
  readonly store: WindowsServiceInstallationStoreWithUserControl;
  readonly systemRoot?: string;
}

export interface LiveWindowsServiceBackendOptions {
  readonly prepareDirectories: (configDir: string) => Effect.Effect<void, ServiceFailure>;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ServiceProcessResult, ServiceFailure>;
  readonly systemRoot?: string;
}

export interface WindowsServiceInstallationPlanOptions {
  readonly legacyUser?: WindowsLegacyUserIdentity;
  readonly systemRoot?: string;
}

function artifactPaths(configDir: string, installId: string) {
  const controlDir = win32.join(configDir, "server-control");
  return {
    launcher: win32.join(controlDir, `${installId}-run-daemon.vbs`),
    taskDefinition: win32.join(controlDir, `${installId}-run-daemon.xml`),
    wrapper: win32.join(controlDir, `${installId}-run-daemon.cmd`),
  };
}

function legacyArtifactPaths(configDir: string) {
  const controlDir = win32.join(configDir, "server-control");
  return {
    launcher: win32.join(controlDir, "run-daemon.vbs"),
    taskDefinition: win32.join(controlDir, "run-daemon.xml"),
    wrapper: win32.join(controlDir, "run-daemon.cmd"),
  };
}

function liveLegacyUser(): WindowsLegacyUserIdentity {
  return {
    ...(process.env.USERDOMAIN ? { domain: process.env.USERDOMAIN } : {}),
    username: userInfo().username,
  };
}

function makeLegacyInstallation(
  descriptor: ServiceDescriptor,
  options: WindowsServiceInstallationPlanOptions,
): WindowsServiceInstallationPlan["legacy"] {
  if (options.legacyUser === undefined) return undefined;
  const paths = legacyArtifactPaths(descriptor.configDir);
  const wrapper = Buffer.from(
    generateLegacyWindowsDaemonWrapper(descriptor),
    WINDOWS_ARTIFACT_MODE,
  );
  const launcher = Buffer.from(generateWindowsHiddenLauncher(paths.wrapper), WINDOWS_ARTIFACT_MODE);
  const taskDefinition = Buffer.from(
    `\ufeff${generateLegacyWindowsTaskXml({
      boot: descriptor.boot,
      launcherPath: paths.launcher,
      userId: legacyWindowsUserId(options.legacyUser),
    })}`,
    "utf16le",
  );
  return {
    artifacts: {
      launcher: { path: paths.launcher, sha256: sha256Hex(launcher) },
      taskDefinition: { path: paths.taskDefinition, sha256: sha256Hex(taskDefinition) },
      wrapper: { path: paths.wrapper, sha256: sha256Hex(wrapper) },
    },
    boot: descriptor.boot,
    matchArtifacts: (actual) => {
      const actualWrapper = Buffer.from(actual.wrapper);
      const decodedWrapper = actualWrapper.toString("utf8");
      return (
        Buffer.from(actual.launcher).equals(launcher) &&
        Buffer.from(actual.taskDefinition).equals(taskDefinition) &&
        Buffer.from(decodedWrapper, "utf8").equals(actualWrapper) &&
        matchesLegacyWindowsDaemonWrapper(decodedWrapper, descriptor)
      );
    },
    runtimeIdentity: {
      configDir: descriptor.configDir,
      executablePath: descriptor.executablePath,
      owner: descriptor.owner,
      port: descriptor.port,
    },
    taskName: WINDOWS_TASK_NAME,
    wscriptPath: "wscript.exe",
  };
}

export function makeWindowsServiceInstallationPlan(
  descriptor: ServiceDescriptor,
  options: WindowsServiceInstallationPlanOptions = {},
): WindowsServiceBackendPlan {
  const wscriptPath = windowsSystemExecutable("wscript.exe", options.systemRoot);
  const legacy = makeLegacyInstallation(descriptor, options);
  const triggerUserAliases = options.legacyUser
    ? [options.legacyUser.username, legacyWindowsUserId(options.legacyUser)]
    : [];
  return {
    artifactPaths: (installId) => artifactPaths(descriptor.configDir, installId),
    encodeTaskDefinition: (xml) => Buffer.from(`\ufeff${xml}`, "utf16le"),
    ...(legacy === undefined ? {} : { legacy }),
    receipt: {
      boot: descriptor.boot,
      configDir: descriptor.configDir,
      executableArgsPrefix: descriptor.executableArgsPrefix,
      executablePath: descriptor.executablePath,
      expectedArgvWithoutNonce: serviceProgramArguments(descriptor).slice(1),
      owner: descriptor.owner,
      port: descriptor.port,
    },
    renderArtifacts: (receipt) => {
      const wrapper = generateWindowsDaemonWrapper(descriptor, receipt.nonce);
      return {
        launcher: Buffer.from(
          generateWindowsHiddenLauncher(receipt.artifacts.wrapper.path),
          WINDOWS_ARTIFACT_MODE,
        ),
        taskDefinitionXml: generateWindowsTaskXml({
          boot: receipt.boot,
          commandPath: wscriptPath,
          launcherPath: receipt.artifacts.launcher.path,
          userId: receipt.userSid,
        }),
        wrapper: Buffer.from(wrapper, WINDOWS_ARTIFACT_MODE),
      };
    },
    taskNamePrefix: WINDOWS_TASK_NAME,
    triggerUserAliases,
    wscriptPath,
  };
}

function receiptRuntimeAuthorization(
  receipt: WindowsServiceInstallationReceipt,
): WindowsRuntimeAuthorization {
  return {
    _tag: "NonceBound",
    configDir: receipt.configDir,
    executablePath: receipt.executablePath,
    installationNonce: receipt.nonce,
    owner: receipt.owner,
    port: receipt.port,
  };
}

function sameLegacyRuntimeIdentity(
  left: NonNullable<WindowsServiceInstallationPlan["legacy"]>["runtimeIdentity"],
  right: NonNullable<WindowsServiceInstallationPlan["legacy"]>["runtimeIdentity"],
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.configDir === right.configDir &&
    left.executablePath === right.executablePath &&
    left.owner === right.owner &&
    left.port === right.port
  );
}

export function authorizationFromEvidence(
  evidence: WindowsServiceInstallationEvidence,
  plan: WindowsServiceBackendPlan,
): WindowsServiceAuthorization {
  switch (evidence._tag) {
    case "Owned":
      return {
        _tag: "Owned",
        receipt: evidence.receipt,
        runtime: receiptRuntimeAuthorization(evidence.receipt),
      };
    case "OwnedIncomplete":
      return {
        _tag: "OwnedIncomplete",
        receipt: evidence.receipt,
        runtime: receiptRuntimeAuthorization(evidence.receipt),
      };
    case "LegacyCompatible": {
      const identity = evidence.runtimeIdentity;
      const plannedIdentity = plan.legacy?.runtimeIdentity;
      return {
        _tag: "Legacy",
        runtime:
          identity === undefined || !sameLegacyRuntimeIdentity(identity, plannedIdentity)
            ? null
            : {
                _tag: "ExactLegacy",
                configDir: identity.configDir,
                executablePath: identity.executablePath,
                owner: identity.owner,
                port: identity.port,
              },
      };
    }
    case "LegacyCleanupPending":
      return {
        _tag: "LegacyCleanupPending",
        runtime: { _tag: "ExactLegacy", ...evidence.journal.runtimeIdentity },
      };
    case "Absent":
      return { _tag: "Absent" };
    case "Refused":
      return { _tag: "Refused", reason: evidence.reason };
  }
}

function mapControllerFailure<A>(
  effect: Effect.Effect<A, { readonly message: string; readonly operation: string }>,
) {
  return effect.pipe(
    Effect.mapError((failure) => serviceFailure(failure.operation, failure.message)),
  );
}

export function makeWindowsServiceBackend(
  dependencies: WindowsServiceBackendDependencies,
): WindowsServiceBackend {
  const controller = makeWindowsServiceInstallationController(dependencies);
  const planFor = (descriptor: ServiceDescriptor) =>
    makeWindowsServiceInstallationPlan(descriptor, {
      legacyUser: dependencies.legacyUser,
      systemRoot: dependencies.systemRoot,
    });
  const inspectInstallation = (descriptor: ServiceDescriptor) =>
    mapControllerFailure(controller.inspect(planFor(descriptor)));
  const diagnoseMutationLock = () =>
    mapControllerFailure(
      dependencies.store
        .resolveUserServiceControl()
        .pipe(Effect.flatMap((scope) => dependencies.lockCompatibility.diagnose(scope))),
    );
  const repairMutationLock = () =>
    mapControllerFailure(
      dependencies.store.prepareUserServiceControl().pipe(
        Effect.flatMap((scope) =>
          dependencies.lockCompatibility.diagnose(scope).pipe(
            Effect.flatMap((diagnostic) =>
              diagnostic._tag === "LegacyStale"
                ? dependencies.lockCompatibility.repairStale(scope, diagnostic).pipe(
                    Effect.andThen(dependencies.lockCompatibility.diagnose(scope)),
                    Effect.flatMap((repaired) =>
                      repaired._tag === "FenceReady"
                        ? Effect.succeed(repaired)
                        : Effect.fail({
                            message: "The Windows service lock repair did not produce a fence.",
                            operation: "verify-windows-service-lock-repair",
                          }),
                    ),
                  )
                : Effect.succeed(diagnostic),
            ),
          ),
        ),
      ),
    );
  const withMutationLock = <A, E, R>(
    descriptor: ServiceDescriptor,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ServiceFailure, R> =>
    Effect.acquireUseRelease(
      mapControllerFailure(dependencies.store.prepareUserServiceControl()).pipe(
        Effect.flatMap((scope) => mapControllerFailure(dependencies.mutationLock.acquire(scope))),
      ),
      () =>
        dependencies
          .prepareDirectories(descriptor.configDir)
          .pipe(
            Effect.andThen(
              mapControllerFailure(dependencies.store.prepareServerControl(descriptor.configDir)),
            ),
            Effect.andThen(use),
          ),
      (lease) => mapControllerFailure(dependencies.mutationLock.release(lease)),
    );

  return {
    automated: true,
    diagnoseMutationLock,
    inspectInstallation,
    install: (descriptor) =>
      dependencies
        .prepareDirectories(descriptor.configDir)
        .pipe(
          Effect.andThen(mapControllerFailure(controller.install(planFor(descriptor)))),
          Effect.asVoid,
        ),
    platform: "win32",
    repairMutationLock,
    restart: (descriptor) => mapControllerFailure(controller.restart(planFor(descriptor))),
    start: (descriptor) => mapControllerFailure(controller.start(planFor(descriptor))),
    status: (descriptor) =>
      inspectInstallation(descriptor).pipe(Effect.map(windowsStatusFromEvidence)),
    stop: (descriptor) => mapControllerFailure(controller.stop(planFor(descriptor))),
    uninstall: (descriptor) => mapControllerFailure(controller.uninstall(planFor(descriptor))),
    withMutationLock,
  };
}

export function makeLiveWindowsServiceBackend(
  options: LiveWindowsServiceBackendOptions,
): WindowsServiceBackend {
  const store = makeLiveWindowsServiceInstallationStore({
    process: { execute: options.run },
    systemRoot: options.systemRoot,
  });
  const lockCompatibility = makeLiveWindowsServiceLockCompatibility();
  return makeWindowsServiceBackend({
    artifacts: makeLiveWindowsServiceInstallationArtifactStore(),
    legacyUser: liveLegacyUser(),
    lockCompatibility,
    mutationLock: makeLiveWindowsUserServiceMutationLock(lockCompatibility),
    prepareDirectories: options.prepareDirectories,
    schedulerFor: (taskName) =>
      makeWindowsTaskScheduler({
        execute: options.run,
        makeFailure: serviceFailure,
        systemRoot: options.systemRoot,
        taskName,
      }),
    store,
    systemRoot: options.systemRoot,
  });
}

export type { WindowsServiceBackend } from "../../service-contract.js";
