import { isDeepStrictEqual } from "node:util";

import * as Effect from "effect/Effect";

import {
  serviceFailure,
  type LocalRuntimeControl,
  type ServiceCommandResponse,
  type ServiceDescriptor,
  type ServiceFailure,
  type WindowsRuntimeRecovery,
  type WindowsServiceBackend,
} from "../../service-contract.js";
import type {
  WindowsListenerRecoveryOutcome,
  WindowsRuntimeAuthorization,
} from "./runtime/contract.js";
import type { WindowsServiceInstallationEvidence } from "./installation/contract.js";
import { observeWindowsServiceStatus } from "./status.js";

export function windowsAuthorizationFromEvidence(
  evidence: WindowsServiceInstallationEvidence,
): WindowsRuntimeAuthorization | null {
  if (evidence._tag === "LegacyCompatible") {
    return evidence.runtimeIdentity === undefined
      ? null
      : { _tag: "ExactLegacy", ...evidence.runtimeIdentity };
  }
  if (evidence._tag === "LegacyCleanupPending") {
    return { _tag: "ExactLegacy", ...evidence.journal.runtimeIdentity };
  }
  if (evidence._tag !== "Owned" && evidence._tag !== "OwnedIncomplete") return null;
  return {
    _tag: "NonceBound",
    configDir: evidence.receipt.configDir,
    executablePath: evidence.receipt.executablePath,
    installationNonce: evidence.receipt.nonce,
    owner: evidence.receipt.owner,
    port: evidence.receipt.port,
  };
}

function recoveryRefusal(
  operation: string,
  prefix: string,
  outcome: Extract<WindowsListenerRecoveryOutcome, { readonly outcome: "refused" }>,
): ServiceFailure {
  const pids =
    outcome.candidatePids.length > 0 ? ` (PIDs ${outcome.candidatePids.join(", ")})` : "";
  return serviceFailure(operation, `${prefix}: ${outcome.reason}${pids}.`);
}

const runUnlocked = Effect.fn("SelfTuneService.windows.unlocked")(function* (
  action: Exclude<ServiceCommandResponse["action"], "status">,
  descriptor: ServiceDescriptor,
  backend: WindowsServiceBackend,
  runtime: LocalRuntimeControl,
  recovery: WindowsRuntimeRecovery,
) {
  const inspect = () => backend.inspectInstallation(descriptor);
  const initial = yield* inspect();
  if (initial._tag === "Refused") {
    return yield* Effect.fail(
      serviceFailure(action, `Windows service installation ownership refused: ${initial.reason}.`),
    );
  }
  const verifyAbsent = Effect.fn("SelfTuneService.windows.command.verifyAbsent")(function* (
    operation: string,
    target: ServiceDescriptor = descriptor,
  ) {
    const outcome = yield* recovery.verifyAbsent(target);
    if (outcome.outcome === "refused") {
      return yield* Effect.fail(
        recoveryRefusal(operation, "Windows listener verification refused", outcome),
      );
    }
  });
  const recoverOwned = Effect.fn("SelfTuneService.windows.command.recoverOwned")(function* (
    operation: string,
    evidence: Extract<
      WindowsServiceInstallationEvidence,
      { readonly _tag: "Owned" | "OwnedIncomplete" }
    >,
  ) {
    const authorization = windowsAuthorizationFromEvidence(evidence);
    if (authorization === null) {
      return yield* Effect.fail(
        serviceFailure(operation, "Windows installation ownership was lost."),
      );
    }
    const outcome = yield* recovery.recoverAuthorized(authorization);
    if (outcome.outcome === "refused") {
      return yield* Effect.fail(
        recoveryRefusal(operation, "Windows listener recovery refused", outcome),
      );
    }
    yield* verifyAbsent(`${operation}-verification`, {
      ...descriptor,
      configDir: authorization.configDir,
      port: authorization.port,
    });
    const afterRecovery = yield* inspect();
    if (
      (afterRecovery._tag !== "Owned" && afterRecovery._tag !== "OwnedIncomplete") ||
      afterRecovery.receipt.installId !== evidence.receipt.installId ||
      afterRecovery.task.running
    ) {
      return yield* Effect.fail(
        serviceFailure(operation, "Windows installation ownership changed during recovery."),
      );
    }
    return authorization;
  });
  const stopOwned = Effect.fn("SelfTuneService.windows.command.stopOwned")(function* (
    operation: string,
    evidence: Extract<WindowsServiceInstallationEvidence, { readonly _tag: "Owned" }>,
  ) {
    yield* backend.stop(descriptor);
    const afterStop = yield* inspect();
    if (
      (afterStop._tag !== "Owned" && afterStop._tag !== "OwnedIncomplete") ||
      afterStop.receipt.installId !== evidence.receipt.installId ||
      afterStop.task.running
    ) {
      return yield* Effect.fail(
        serviceFailure(
          operation,
          "Windows installation ownership changed after stopping the task.",
        ),
      );
    }
    return yield* recoverOwned(operation, afterStop);
  });
  const stopLegacy = Effect.fn("SelfTuneService.windows.command.stopLegacy")(function* (
    operation: string,
    evidence: Extract<WindowsServiceInstallationEvidence, { readonly _tag: "LegacyCompatible" }>,
  ) {
    const authorization = windowsAuthorizationFromEvidence(evidence);
    if (authorization?._tag !== "ExactLegacy") {
      return yield* Effect.fail(
        serviceFailure(
          operation,
          "The legacy Windows service cannot be migrated without an exact runtime identity.",
        ),
      );
    }
    yield* backend.stop(descriptor);
    const afterStop = yield* inspect();
    if (
      afterStop._tag !== "LegacyCompatible" ||
      afterStop.task.running ||
      afterStop.artifacts.wrapper.sha256 !== evidence.artifacts.wrapper.sha256 ||
      afterStop.artifacts.launcher.sha256 !== evidence.artifacts.launcher.sha256 ||
      afterStop.artifacts.taskDefinition.sha256 !== evidence.artifacts.taskDefinition.sha256
    ) {
      return yield* Effect.fail(
        serviceFailure(
          operation,
          "Windows legacy installation ownership changed after stopping the task.",
        ),
      );
    }
    const outcome = yield* recovery.recoverAuthorized(authorization);
    if (outcome.outcome === "refused") {
      return yield* Effect.fail(
        recoveryRefusal(operation, "Windows legacy listener recovery refused", outcome),
      );
    }
    yield* verifyAbsent(`${operation}-verification`, {
      ...descriptor,
      configDir: authorization.configDir,
      port: authorization.port,
    });
    const afterRecovery = yield* inspect();
    if (
      afterRecovery._tag !== "LegacyCompatible" ||
      afterRecovery.task.running ||
      afterRecovery.artifacts.wrapper.sha256 !== evidence.artifacts.wrapper.sha256 ||
      afterRecovery.artifacts.launcher.sha256 !== evidence.artifacts.launcher.sha256 ||
      afterRecovery.artifacts.taskDefinition.sha256 !== evidence.artifacts.taskDefinition.sha256
    ) {
      return yield* Effect.fail(
        serviceFailure(operation, "Windows legacy installation ownership changed during recovery."),
      );
    }
    return authorization;
  });
  const recoverPending = Effect.fn("SelfTuneService.windows.command.recoverPending")(function* (
    operation: string,
    evidence: Extract<
      WindowsServiceInstallationEvidence,
      { readonly _tag: "LegacyCleanupPending" }
    >,
  ) {
    const authorization = windowsAuthorizationFromEvidence(evidence);
    if (authorization?._tag !== "ExactLegacy") {
      return yield* Effect.fail(
        serviceFailure(operation, "The pending Windows cleanup lost its runtime authority."),
      );
    }
    if (evidence.task.running) yield* backend.stop(descriptor);
    const afterStop = yield* inspect();
    if (
      afterStop._tag !== "LegacyCleanupPending" ||
      afterStop.task.running ||
      !isDeepStrictEqual(afterStop.journal, evidence.journal)
    ) {
      return yield* Effect.fail(
        serviceFailure(operation, "The pending Windows cleanup changed before recovery."),
      );
    }
    const outcome = yield* recovery.recoverAuthorized(authorization);
    if (outcome.outcome === "refused") {
      return yield* Effect.fail(
        recoveryRefusal(operation, "Windows pending-cleanup listener recovery refused", outcome),
      );
    }
    yield* verifyAbsent(`${operation}-verification`, {
      ...descriptor,
      configDir: authorization.configDir,
      port: authorization.port,
    });
    const afterRecovery = yield* inspect();
    if (
      afterRecovery._tag !== "LegacyCleanupPending" ||
      afterRecovery.task.running ||
      !isDeepStrictEqual(afterRecovery.journal, evidence.journal)
    ) {
      return yield* Effect.fail(
        serviceFailure(operation, "The pending Windows cleanup changed during recovery."),
      );
    }
    return authorization;
  });
  const waitUntilReady = Effect.fn("SelfTuneService.windows.command.waitUntilReady")(function* (
    operation: string,
    expectedInstallId: string,
  ) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const evidence = yield* inspect();
      if (evidence._tag === "Refused") {
        return yield* Effect.fail(
          serviceFailure(
            operation,
            `Windows service installation ownership refused: ${evidence.reason}.`,
          ),
        );
      }
      if (
        (evidence._tag === "Owned" || evidence._tag === "OwnedIncomplete") &&
        evidence.receipt.installId !== expectedInstallId
      ) {
        return yield* Effect.fail(
          serviceFailure(operation, "Windows installation ownership changed before readiness."),
        );
      }
      const authorization = windowsAuthorizationFromEvidence(evidence);
      if (evidence._tag === "Owned" && evidence.task.running && authorization !== null) {
        const readiness = yield* recovery.verifyRunning(authorization);
        if (readiness._tag === "Ready") return;
      }
      yield* Effect.sleep(250);
    }
    return yield* Effect.fail(
      serviceFailure(
        operation,
        "The Windows service did not become authenticated and ready within 20 seconds.",
      ),
    );
  });
  const installedIdentity = Effect.fn("SelfTuneService.windows.command.installedIdentity")(
    function* (operation: string) {
      const evidence = yield* inspect();
      if (evidence._tag !== "Owned") {
        const reason = evidence._tag === "Refused" ? `: ${evidence.reason}` : "";
        return yield* Effect.fail(
          serviceFailure(operation, `The Windows service was not fully installed${reason}.`),
        );
      }
      return evidence.receipt.installId;
    },
  );

  switch (initial._tag) {
    case "Absent": {
      if (action === "stop" || action === "uninstall") {
        yield* verifyAbsent(`${action}-windows-verification`);
        return;
      }
      if (action !== "install") {
        return yield* Effect.fail(serviceFailure(action, "The Windows service is not installed."));
      }
      yield* runtime
        .stop(descriptor.configDir)
        .pipe(Effect.mapError((cause) => serviceFailure("install-takeover", cause)));
      yield* verifyAbsent("install-windows-verification");
      yield* backend.install(descriptor);
      const installId = yield* installedIdentity("install");
      yield* waitUntilReady("install", installId);
      return;
    }
    case "LegacyCompatible": {
      if (action === "start" || action === "restart") {
        return yield* Effect.fail(
          serviceFailure(action, "The legacy Windows service must be migrated with install first."),
        );
      }
      const authorization = yield* stopLegacy(`${action}-windows-recovery`, initial);
      if (action === "stop") return;
      if (action === "uninstall") {
        yield* backend.uninstall(descriptor);
        const afterUninstall = yield* inspect();
        if (afterUninstall._tag !== "Absent") {
          return yield* Effect.fail(
            serviceFailure(
              "uninstall",
              "The legacy Windows service remained installed after uninstall.",
            ),
          );
        }
        yield* verifyAbsent("uninstall-final-windows-verification", {
          ...descriptor,
          configDir: authorization.configDir,
          port: authorization.port,
        });
        return;
      }
      yield* backend.install(descriptor);
      const installId = yield* installedIdentity("install");
      yield* waitUntilReady("install", installId);
      return;
    }
    case "LegacyCleanupPending": {
      if (action === "start" || action === "restart") {
        return yield* Effect.fail(
          serviceFailure(
            action,
            "Windows legacy cleanup is pending; run service install or service uninstall to finish it.",
          ),
        );
      }
      const authorization = yield* recoverPending(`${action}-windows-recovery`, initial);
      if (action === "stop") return;
      if (action === "install") {
        yield* backend.install(descriptor);
        const installId = yield* installedIdentity("install");
        yield* waitUntilReady("install", installId);
        return;
      }
      yield* backend.uninstall(descriptor);
      const afterUninstall = yield* inspect();
      if (afterUninstall._tag !== "Absent") {
        return yield* Effect.fail(
          serviceFailure("uninstall", "The pending Windows cleanup did not finish."),
        );
      }
      yield* verifyAbsent("uninstall-final-windows-verification", {
        ...descriptor,
        configDir: authorization.configDir,
        port: authorization.port,
      });
      return;
    }
    case "Owned": {
      if (action === "start") {
        yield* backend.start(descriptor);
        yield* waitUntilReady("start", initial.receipt.installId);
        return;
      }
      const authorization = yield* stopOwned(`${action}-windows-recovery`, initial);
      if (action === "install") {
        yield* verifyAbsent("install-target-windows-verification");
        yield* backend.install(descriptor);
      }
      if (action === "restart") yield* backend.start(descriptor);
      if (action === "uninstall") {
        yield* backend.uninstall(descriptor);
        const afterUninstall = yield* inspect();
        if (afterUninstall._tag !== "Absent") {
          return yield* Effect.fail(
            serviceFailure("uninstall", "The Windows service remained installed after uninstall."),
          );
        }
        yield* verifyAbsent("uninstall-final-windows-verification", {
          ...descriptor,
          configDir: authorization.configDir,
          port: authorization.port,
        });
      }
      if (action === "install") {
        const installId = yield* installedIdentity("install");
        yield* waitUntilReady("install", installId);
      }
      if (action === "restart") {
        yield* waitUntilReady("restart", initial.receipt.installId);
      }
      return;
    }
    case "OwnedIncomplete": {
      if (action === "start") {
        return yield* Effect.fail(
          serviceFailure(
            "start",
            "The Windows service installation is incomplete; run install or restart to repair it.",
          ),
        );
      }
      const authorization = yield* recoverOwned(`${action}-windows-recovery`, initial);
      if (action === "install" || action === "restart") {
        yield* verifyAbsent(`${action}-target-windows-verification`);
        yield* backend.install(descriptor);
        const installId = yield* installedIdentity(action);
        yield* waitUntilReady(action, installId);
      }
      if (action === "uninstall") {
        yield* backend.uninstall(descriptor);
        const afterUninstall = yield* inspect();
        if (afterUninstall._tag !== "Absent") {
          return yield* Effect.fail(
            serviceFailure("uninstall", "The Windows service remained installed after uninstall."),
          );
        }
        yield* verifyAbsent("uninstall-final-windows-verification", {
          ...descriptor,
          configDir: authorization.configDir,
          port: authorization.port,
        });
      }
      return;
    }
  }
});

export const runWindowsServiceCommand = Effect.fn("SelfTuneService.windows.command")(function* (
  action: Exclude<ServiceCommandResponse["action"], "status">,
  descriptor: ServiceDescriptor,
  backend: WindowsServiceBackend,
  runtime: LocalRuntimeControl,
  recovery: WindowsRuntimeRecovery,
) {
  return yield* backend.withMutationLock(
    descriptor,
    runUnlocked(action, descriptor, backend, runtime, recovery).pipe(
      Effect.andThen(observeWindowsServiceStatus(descriptor, backend, recovery)),
    ),
  );
});
