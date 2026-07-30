import * as Effect from "effect/Effect";

import { ServiceManagerLive } from "../../service.js";
import type { ServiceFailure } from "../../service-contract.js";
import { runServiceMaintenanceCommand } from "./command.js";
import type {
  ServiceMaintenanceAction,
  ServiceMaintenanceInput,
  ServiceMaintenanceResponse,
} from "./contract.js";

export interface ServiceMaintenanceProgramDependencies {
  readonly print: (message: string) => void;
  readonly run: (
    action: ServiceMaintenanceAction,
  ) => Effect.Effect<ServiceMaintenanceResponse, ServiceFailure>;
  readonly setExitCode: (code: number) => void;
}

const LIVE_DEPENDENCIES: ServiceMaintenanceProgramDependencies = {
  print: (message) => process.stdout.write(`${message}\n`),
  run: (action) => runServiceMaintenanceCommand(action).pipe(Effect.provide(ServiceManagerLive)),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

function printText(response: ServiceMaintenanceResponse, print: (message: string) => void): void {
  print(`SelfTune service ${response.action}: ${response.diagnostic.state}.`);
  if (response.diagnostic.reason) print(response.diagnostic.reason);
  if (response.diagnostic.state === "legacy_stale_repairable") {
    print("Run selftune service repair-lock to replace the stale legacy lock safely.");
  }
}

export const runServiceMaintenanceProgram = Effect.fn("SelfTuneService.maintenance.program")(
  function* (
    action: ServiceMaintenanceAction,
    input: ServiceMaintenanceInput,
    dependencies: ServiceMaintenanceProgramDependencies = LIVE_DEPENDENCIES,
  ) {
    const result = yield* dependencies.run(action);
    yield* Effect.sync(() => {
      if (input.json) dependencies.print(JSON.stringify(result));
      else printText(result, dependencies.print);
      if (!result.ok) dependencies.setExitCode(1);
    });
    return result;
  },
);

export const runServiceDoctorProgram = Effect.fn("SelfTuneService.maintenance.doctorProgram")(
  function* (
    input: ServiceMaintenanceInput,
    dependencies: ServiceMaintenanceProgramDependencies = LIVE_DEPENDENCIES,
  ) {
    return yield* runServiceMaintenanceProgram("doctor", input, dependencies);
  },
);

export const runServiceRepairLockProgram = Effect.fn(
  "SelfTuneService.maintenance.repairLockProgram",
)(function* (
  input: ServiceMaintenanceInput,
  dependencies: ServiceMaintenanceProgramDependencies = LIVE_DEPENDENCIES,
) {
  return yield* runServiceMaintenanceProgram("repair-lock", input, dependencies);
});
