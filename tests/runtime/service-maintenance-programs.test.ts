import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import { runServiceMaintenanceProgram } from "@selftune/local/service/maintenance/programs";
import type { ServiceMaintenanceResponse } from "@selftune/local/service/maintenance/contract";

function response(
  state: ServiceMaintenanceResponse["diagnostic"]["state"],
  ok: boolean,
): ServiceMaintenanceResponse {
  return {
    action: "doctor",
    diagnostic: { repairable: state === "legacy_stale_repairable", state },
    ok,
    platform: "win32",
  };
}

describe("typed service maintenance programs", () => {
  it("prints one machine-readable object and records a blocked exit", async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const blocked = response("legacy_stale_repairable", false);

    await Effect.runPromise(
      runServiceMaintenanceProgram(
        "doctor",
        { json: true },
        {
          print: (message) => output.push(message),
          run: () => Effect.succeed(blocked),
          setExitCode: (code) => exitCodes.push(code),
        },
      ),
    );

    expect(output).toEqual([JSON.stringify(blocked)]);
    expect(exitCodes).toEqual([1]);
  });

  it("recommends repair only for a stale legacy lock", async () => {
    const staleOutput: string[] = [];
    await Effect.runPromise(
      runServiceMaintenanceProgram(
        "doctor",
        { json: false },
        {
          print: (message) => staleOutput.push(message),
          run: () => Effect.succeed(response("legacy_stale_repairable", false)),
          setExitCode: () => undefined,
        },
      ),
    );
    expect(staleOutput.join(" ")).toContain("selftune service repair-lock");

    const activeOutput: string[] = [];
    await Effect.runPromise(
      runServiceMaintenanceProgram(
        "doctor",
        { json: false },
        {
          print: (message) => activeOutput.push(message),
          run: () => Effect.succeed(response("legacy_active_or_unverifiable", false)),
          setExitCode: () => undefined,
        },
      ),
    );
    expect(activeOutput.join(" ")).not.toContain("repair-lock");
  });
});
