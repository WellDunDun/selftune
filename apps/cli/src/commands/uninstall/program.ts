import * as Effect from "effect/Effect";

import type { DaemonFailure } from "@selftune/local/daemon";
import type { ServiceFailure } from "@selftune/local/service";
import type { CredentialStoreFailure } from "@selftune/runtime/credential-store";

import { UninstallDependencies } from "./dependencies.js";
import type { UninstallCleanupFailure } from "./errors.js";
import { planUninstall, shouldRunStep } from "./planning.js";
import type { UninstallOptions, UninstallResult } from "./types.js";

export const runUninstallProgram = Effect.fn("selftune.cli.uninstall")(function* (
  options: UninstallOptions,
): Effect.fn.Return<
  UninstallResult,
  CredentialStoreFailure | DaemonFailure | ServiceFailure | UninstallCleanupFailure,
  UninstallDependencies
> {
  const dependencies = yield* UninstallDependencies;
  const plan = planUninstall(options);

  const service = yield* dependencies.removeRuntimeService(plan.dryRun);
  const credential = yield* dependencies.removeRemoteCredential(plan.dryRun);
  const schedule = yield* dependencies.removeScheduling(plan.dryRun);
  const hooks = yield* dependencies.removeHooks(plan.dryRun, plan.settingsPath);
  const agents = yield* dependencies.removeAgents(plan.dryRun);
  const logs = shouldRunStep(plan, "logs")
    ? { ...(yield* dependencies.removeLogs(plan.dryRun)), skipped: false }
    : { removed: 0, skipped: true, files: [] };
  const config = yield* dependencies.removeConfig(plan.dryRun);
  const markers = yield* dependencies.removeMarkers(plan.dryRun);
  const npm = shouldRunStep(plan, "npm")
    ? { ...(yield* dependencies.uninstallNpm(plan.dryRun)), skipped: false }
    : { uninstalled: false, skipped: true };

  return {
    dryRun: plan.dryRun,
    service,
    credential,
    schedule,
    hooks,
    agents,
    logs,
    config,
    markers,
    npm,
  };
});
