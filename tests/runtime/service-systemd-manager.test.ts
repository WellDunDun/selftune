import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import { ServiceFailure, serviceFailure } from "@selftune/local/service";
import { makeSystemdManager } from "@selftune/local/service/systemd/manager";
import type { ServiceProcessResult } from "@selftune/local/service-process";

const unitName = "dev.selftune.daemon.service";
const showArguments = [
  "show",
  unitName,
  "--property=LoadState",
  "--property=ActiveState",
  "--property=MainPID",
  "--property=UnitFileState",
];

function result(code: number, stdout = "", stderr = ""): ServiceProcessResult {
  return { code, stderr, stdout };
}

function stateResult(options: {
  readonly active: string;
  readonly load?: string;
  readonly pid?: number;
  readonly unitFile?: string;
}): ServiceProcessResult {
  return result(
    0,
    [
      `LoadState=${options.load ?? "loaded"}`,
      `ActiveState=${options.active}`,
      `MainPID=${options.pid ?? 0}`,
      `UnitFileState=${options.unitFile ?? "disabled"}`,
    ].join("\n"),
  );
}

function harness(responses: ReadonlyArray<ServiceProcessResult>) {
  const calls: ReadonlyArray<string>[] = [];
  let responseIndex = 0;
  const manager = makeSystemdManager<ServiceFailure>({
    failure: serviceFailure,
    run: (args) =>
      Effect.sync(() => {
        calls.push(args);
        const response = responses[responseIndex];
        responseIndex += 1;
        if (!response) throw new Error(`Unexpected systemctl call: ${args.join(" ")}`);
        return response;
      }),
    unitName,
  });
  return { calls, manager };
}

describe("systemd manager reconciliation", () => {
  it("reads active manager state and exposes MainPID", async () => {
    const test = harness([stateResult({ active: "active", pid: 4242, unitFile: "enabled" })]);

    expect(await Effect.runPromise(test.manager.inspect())).toEqual({
      loaded: true,
      mainPid: 4242,
      running: true,
      unitFileState: "enabled",
    });
    expect(test.calls).toEqual([showArguments]);
  });

  it("treats absent and inactive units as idempotently stopped", async () => {
    const absent = harness([result(1, "", `Unit ${unitName} could not be found.`)]);
    await Effect.runPromise(absent.manager.stop());
    expect(absent.calls).toEqual([showArguments]);

    const inactive = harness([stateResult({ active: "inactive" })]);
    await Effect.runPromise(inactive.manager.stop());
    expect(inactive.calls).toEqual([showArguments]);
  });

  it("stops and disables manager state when the owned unit file disappeared", async () => {
    const test = harness([
      stateResult({ active: "active", pid: 4242, unitFile: "enabled" }),
      result(0),
      result(0),
    ]);

    await Effect.runPromise(test.manager.uninstall(false));

    expect(test.calls).toEqual([showArguments, ["stop", unitName], ["disable", unitName]]);
  });

  it("removes an owned file idempotently when systemd no longer knows the unit", async () => {
    const test = harness([
      result(1, "", `Unit ${unitName} not loaded.`),
      result(1, "", `Unit file ${unitName} does not exist.`),
    ]);

    await Effect.runPromise(test.manager.uninstall(true));

    expect(test.calls).toEqual([showArguments, ["disable", "--now", unitName]]);
  });

  it("preserves permission and manager-bus failures", async () => {
    const inspectFailure = harness([result(1, "", "Failed to connect to bus: Permission denied")]);
    const inspectError = await Effect.runPromise(inspectFailure.manager.stop().pipe(Effect.flip));
    expect(inspectError).toMatchObject({ operation: "status" });

    const stopFailure = harness([
      stateResult({ active: "active", pid: 4242 }),
      result(1, "", "Access denied"),
    ]);
    const stopError = await Effect.runPromise(stopFailure.manager.stop().pipe(Effect.flip));
    expect(stopError).toMatchObject({ operation: "stop", message: "Access denied" });
  });
});
