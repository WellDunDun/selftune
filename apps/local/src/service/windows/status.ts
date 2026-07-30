import { isDeepStrictEqual } from "node:util";

import * as Effect from "effect/Effect";

import {
  serviceFailure,
  type ServiceDescriptor,
  type ServiceStatus,
  type WindowsRuntimeRecovery,
  type WindowsServiceBackend,
} from "../../service-contract.js";
import type { WindowsServiceInstallationEvidence } from "./installation/contract.js";
import type { WindowsServiceInstallationArtifacts } from "./installation/model.js";
import { sameWindowsServiceInstallationReceipt } from "./installation/model.js";

function artifactsMatch(
  left: WindowsServiceInstallationArtifacts,
  right: WindowsServiceInstallationArtifacts,
): boolean {
  return (
    left.launcher.path === right.launcher.path &&
    left.launcher.sha256 === right.launcher.sha256 &&
    left.taskDefinition.path === right.taskDefinition.path &&
    left.taskDefinition.sha256 === right.taskDefinition.sha256 &&
    left.wrapper.path === right.wrapper.path &&
    left.wrapper.sha256 === right.wrapper.sha256
  );
}

function sameInstallationObservation(
  before: WindowsServiceInstallationEvidence,
  after: WindowsServiceInstallationEvidence,
): boolean {
  if (
    before._tag !== after._tag ||
    before.currentUserSid !== after.currentUserSid ||
    before.task.registered !== after.task.registered ||
    before.task.running !== after.task.running
  ) {
    return false;
  }

  switch (before._tag) {
    case "Owned":
      return (
        after._tag === "Owned" &&
        sameWindowsServiceInstallationReceipt(before.receipt, after.receipt)
      );
    case "OwnedIncomplete":
      return (
        after._tag === "OwnedIncomplete" &&
        sameWindowsServiceInstallationReceipt(before.receipt, after.receipt)
      );
    case "LegacyCompatible":
      return after._tag === "LegacyCompatible" && artifactsMatch(before.artifacts, after.artifacts);
    case "LegacyCleanupPending":
      return (
        after._tag === "LegacyCleanupPending" && isDeepStrictEqual(before.journal, after.journal)
      );
    case "Refused":
      return after._tag === "Refused" && before.reason === after.reason;
    case "Absent":
      return after._tag === "Absent";
  }
}

export function windowsStatusFromEvidence(
  evidence: WindowsServiceInstallationEvidence,
): ServiceStatus {
  const detail = (() => {
    switch (evidence._tag) {
      case "Owned":
        return [];
      case "OwnedIncomplete":
        return ["The SelfTune scheduled task installation is incomplete."];
      case "LegacyCompatible":
        return ["A verified legacy SelfTune scheduled task is installed."];
      case "LegacyCleanupPending":
        return [
          "A verified legacy SelfTune cleanup is pending; run service install or service uninstall to finish it.",
        ];
      case "Absent":
        return ["The SelfTune scheduled task is not installed."];
      case "Refused":
        return [`The SelfTune scheduled task is not safe to control: ${evidence.reason}.`];
    }
  })();
  return {
    detail,
    pid: null,
    platform: "win32",
    registered: evidence.task.registered,
    running: evidence.task.running,
  };
}

export const observeWindowsServiceStatus = Effect.fn("SelfTuneService.windows.status.observe")(
  function* (
    descriptor: ServiceDescriptor,
    backend: WindowsServiceBackend,
    recovery: WindowsRuntimeRecovery,
  ) {
    const before = yield* backend.inspectInstallation(descriptor);
    const readiness =
      before._tag === "Owned" && before.task.running
        ? yield* recovery.verifyRunning({
            _tag: "NonceBound",
            configDir: before.receipt.configDir,
            executablePath: before.receipt.executablePath,
            installationNonce: before.receipt.nonce,
            owner: before.receipt.owner,
            port: before.receipt.port,
          })
        : null;
    const after = yield* backend.inspectInstallation(descriptor);

    if (!sameInstallationObservation(before, after)) {
      return yield* Effect.fail(
        serviceFailure(
          "windows-status-observation",
          "Windows service installation changed during status observation.",
        ),
      );
    }

    const status = windowsStatusFromEvidence(after);
    if (readiness?._tag === "Ready") {
      return {
        ...status,
        detail: [
          ...status.detail,
          `Serving http://127.0.0.1:${readiness.port} (pid ${readiness.pid}, SelfTune ${readiness.ownerVersion}, ${readiness.owner}-owned).`,
        ],
        pid: readiness.pid,
      } satisfies ServiceStatus;
    }
    if (readiness?._tag === "NotReady") {
      return {
        ...status,
        detail: [
          ...status.detail,
          `The SelfTune scheduled task is running, but its runtime is not authenticated (${readiness.reason}).`,
        ],
      } satisfies ServiceStatus;
    }
    return status;
  },
);
