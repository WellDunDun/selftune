import { homedir } from "node:os";

import {
  type HarnessDetectionContext,
  type HarnessSourceMergeInvocation,
} from "@selftune/harness-core/descriptor";
import { harnessRegistry } from "@selftune/harness-registry";
import type {
  HarnessConnection,
  HarnessConnectionStatus,
} from "@selftune/runtime/dashboard-contract";

export const localHarnessRegistry = harnessRegistry;

export interface LocalHarnessDetectionOptions {
  homeDir?: string;
  which?: (command: string) => string | null;
}

function defaultWhich(command: string): string | null {
  try {
    return Bun.which(command) ?? null;
  } catch {
    return null;
  }
}

function statusFor(detected: boolean, connected: boolean): HarnessConnectionStatus {
  if (connected) return "connected";
  if (detected) return "detected";
  return "not_detected";
}

export function detectLocalHarnessConnections(
  options: LocalHarnessDetectionOptions = {},
): HarnessConnection[] {
  const context: HarnessDetectionContext = {
    homeDir: options.homeDir ?? homedir(),
    which: options.which ?? defaultWhich,
  };
  const clientById = new Map(
    localHarnessRegistry.clientDescriptors().map((descriptor) => [descriptor.id, descriptor]),
  );

  return localHarnessRegistry.contributions.flatMap(({ runtime }) => {
    const presentation = clientById.get(runtime.id);
    const detected = runtime.detectConnection?.(context);
    if (!presentation || !detected) return [];
    const status = statusFor(detected.detected, detected.connected);
    return [
      {
        ...presentation,
        id: runtime.id,
        detected: detected.detected,
        connected: detected.connected,
        import_available: detected.import_available,
        hooks_supported: detected.hooks_supported,
        hooks_installed: detected.hooks_installed,
        status,
        detail:
          status === "connected"
            ? detected.connected_detail
            : status === "detected"
              ? "Harness found; SelfTune integration is not installed"
              : "Harness not found on this Mac",
      },
    ];
  });
}

export function localHarnessSettingsEnvironment() {
  return { loadHarnessConnections: () => detectLocalHarnessConnections() };
}

export function resolveSourceMergeInvocation(
  harnessId: string,
  model: string | null,
): HarnessSourceMergeInvocation {
  const contribution = localHarnessRegistry.get(harnessId);
  const sourceMerge = contribution?.runtime.sourceMerge;
  if (!contribution || !sourceMerge) {
    const name = contribution?.presentation.name ?? harnessId;
    throw new Error(`${name} does not support agent-assisted source merging.`);
  }
  return sourceMerge.invocation(model);
}
