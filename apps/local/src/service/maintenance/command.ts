import * as Effect from "effect/Effect";

import { ServiceManager } from "../../service-contract.js";
import type { WindowsServiceLockCompatibilityDiagnostic } from "../windows/lock-compatibility.js";
import type {
  ServiceLockDiagnostic,
  ServiceMaintenanceAction,
  ServiceMaintenanceResponse,
} from "./contract.js";

function publicDiagnostic(
  diagnostic: WindowsServiceLockCompatibilityDiagnostic,
): ServiceLockDiagnostic {
  switch (diagnostic._tag) {
    case "Absent":
      return { repairable: false, state: "ready_to_fence" };
    case "FenceReady":
      return { repairable: false, state: "fenced" };
    case "LegacyActiveOrUnverifiable":
      return {
        pid: diagnostic.pid,
        reason: diagnostic.reason,
        repairable: false,
        startedAt: diagnostic.startedAt,
        state: "legacy_active_or_unverifiable",
      };
    case "LegacyStale":
      return {
        pid: diagnostic.pid,
        repairable: true,
        startedAt: diagnostic.startedAt,
        state: "legacy_stale_repairable",
      };
    case "Refused":
      return diagnostic.code === "changed-during-inspection"
        ? {
            reason: diagnostic.reason,
            repairable: false,
            retryable: true,
            state: "changed_during_inspection",
          }
        : {
            reason: diagnostic.reason,
            repairable: false,
            state: "invalid_blocking_file",
          };
  }
}

function response(
  action: ServiceMaintenanceAction,
  platform: NodeJS.Platform,
  diagnostic: ServiceLockDiagnostic,
  result?: ServiceMaintenanceResponse["result"],
): ServiceMaintenanceResponse {
  const ok =
    diagnostic.state === "fenced" ||
    diagnostic.state === "ready_to_fence" ||
    diagnostic.state === "not_applicable";
  const response = { action, diagnostic, ok, platform };
  return result === undefined ? response : { ...response, result };
}

export const runServiceMaintenanceCommand = Effect.fn("SelfTuneService.maintenance.command")(
  function* (action: ServiceMaintenanceAction) {
    const manager = yield* ServiceManager;
    const backend = manager.backend;
    const platform = backend.platform === "unsupported" ? process.platform : backend.platform;
    if (backend.platform !== "win32") {
      return response(
        action,
        platform,
        { repairable: false, state: "not_applicable" },
        "not_needed",
      );
    }

    const before = yield* backend.diagnoseMutationLock();
    if (action === "doctor") return response(action, platform, publicDiagnostic(before));
    if (before._tag === "FenceReady") {
      return response(action, platform, publicDiagnostic(before), "already_fenced");
    }
    if (before._tag === "Absent") {
      return response(action, platform, publicDiagnostic(before), "not_needed");
    }
    if (before._tag !== "LegacyStale") {
      return response(action, platform, publicDiagnostic(before));
    }

    const after = yield* backend.repairMutationLock();
    return response(
      action,
      platform,
      publicDiagnostic(after),
      after._tag === "FenceReady" ? "repaired" : undefined,
    );
  },
);
