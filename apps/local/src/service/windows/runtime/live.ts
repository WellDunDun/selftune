import * as Effect from "effect/Effect";

import { readLocalAuthToken } from "../../../local-runtime.js";
import {
  serviceFailure,
  type ServiceFailure,
  type WindowsRuntimeRecovery,
} from "../../../service-contract.js";
import type { ServiceProcessResult } from "../../../service-process.js";
import { windowsSystemExecutable } from "../scheduler.js";
import type { WindowsShutdownRequestOutcome } from "./contract.js";
import {
  recoverAuthorizedWindowsListener,
  verifyAuthorizedWindowsListenerRunning,
  verifyWindowsListenerAbsent,
} from "./recovery.js";

type RunServiceProcess = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<ServiceProcessResult, ServiceFailure>;

export function makeLiveWindowsRuntimeRecovery(run: RunServiceProcess): WindowsRuntimeRecovery {
  const dependencies = {
    makeFailure: serviceFailure,
    readAuthToken: (configDir: string) =>
      Effect.try({
        try: () => readLocalAuthToken(configDir),
        catch: (cause) => serviceFailure("windows-auth-token", cause),
      }),
    requestHealth: (port: number, token: string) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok) {
            throw new Error(`Authenticated health returned HTTP ${response.status}.`);
          }
          const payload: unknown = await response.json();
          return payload;
        },
        catch: (cause) => serviceFailure("windows-health", cause),
      }),
    requestShutdown: (port: number, token: string, runtimeInstanceId: string) =>
      Effect.promise(async (): Promise<WindowsShutdownRequestOutcome> => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/runtime/shutdown`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ runtime_instance_id: runtimeInstanceId }),
            signal: AbortSignal.timeout(2_000),
          });
          if (response.status === 202) return "accepted";
          if (response.status === 409) return "instance-mismatch";
          return "rejected";
        } catch {
          return "transport-ambiguous";
        }
      }),
    run: (command: string, args: ReadonlyArray<string>) =>
      run(windowsSystemExecutable(command, process.env.SystemRoot), args),
    sleep: (milliseconds: number) => Effect.sleep(milliseconds),
  };

  return {
    recoverAuthorized: (authorization) =>
      recoverAuthorizedWindowsListener(authorization, dependencies),
    verifyAbsent: (descriptor) =>
      verifyWindowsListenerAbsent(
        { configDir: descriptor.configDir, port: descriptor.port },
        dependencies,
      ),
    verifyRunning: (authorization) =>
      verifyAuthorizedWindowsListenerRunning(authorization, dependencies),
  };
}
