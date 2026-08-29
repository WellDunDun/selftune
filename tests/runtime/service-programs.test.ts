import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import type { ServiceInput } from "@selftune/local/service-cli-contract";
import {
  runServiceInstallProgram,
  runServiceRestartProgram,
  resolveServiceDescriptor,
  runServiceStartProgram,
  runServiceStatusProgram,
  runServiceStopProgram,
  runServiceUninstallProgram,
  serviceCliProgram,
  type ServiceProgramDependencies,
} from "@selftune/local/service-programs";
import {
  ServiceFailure,
  type ServiceCommandResponse,
  type ServiceDescriptor,
} from "@selftune/local/service";

const input: ServiceInput = {
  boot: false,
  configDir: "/tmp/selftune-service-program",
  executable: "/usr/local/bin/selftune",
  json: false,
  owner: "cli",
  port: 7888,
  version: "1.2.3",
};

const descriptor: ServiceDescriptor = {
  boot: false,
  configDir: "/tmp/selftune-service-program",
  executableArgsPrefix: [],
  executablePath: "/usr/local/bin/selftune",
  owner: "cli",
  port: 7888,
  version: "1.2.3",
};

function harness() {
  const actions: string[] = [];
  const described: ServiceInput[] = [];
  const output: string[] = [];
  const dependencies: ServiceProgramDependencies = {
    describe: (value) =>
      Effect.sync(() => {
        described.push(value);
        return descriptor;
      }),
    print: (message) => output.push(message),
    run: (action) =>
      Effect.sync(() => {
        actions.push(action);
        return {
          action,
          ok: true,
          status: {
            detail: ["Runtime healthy."],
            pid: 4242,
            platform: "darwin",
            registered: true,
            running: true,
          },
        } satisfies ServiceCommandResponse;
      }),
  };
  return { actions, dependencies, described, output };
}

describe("typed service programs", () => {
  it("validates typed input before resolving or invoking an OS backend", async () => {
    const failure = await Effect.runPromise(
      resolveServiceDescriptor({ ...input, port: 0 }).pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(ServiceFailure);
    expect(failure).toMatchObject({ operation: "parse", message: "Invalid service port: 0" });
  });

  it("inherits packaged resources while preserving an explicit resource directory", async () => {
    const inherited = await Effect.runPromise(
      resolveServiceDescriptor(input, {
        SELFTUNE_DESKTOP_RESOURCE_DIR: "/Applications/SelfTune.app/Contents/Resources/selftune",
      }),
    );
    expect(inherited.resourceDir).toBe("/Applications/SelfTune.app/Contents/Resources/selftune");

    const explicit = await Effect.runPromise(
      resolveServiceDescriptor(
        { ...input, resourceDir: "/opt/selftune-resources" },
        { SELFTUNE_DESKTOP_RESOURCE_DIR: "/ignored/packaged-resources" },
      ),
    );
    expect(explicit.resourceDir).toBe("/opt/selftune-resources");
  });

  it("dispatches every lifecycle action through injected dependencies", async () => {
    const test = harness();

    await Effect.runPromise(runServiceInstallProgram(input, test.dependencies));
    await Effect.runPromise(runServiceUninstallProgram(input, test.dependencies));
    await Effect.runPromise(runServiceStartProgram(input, test.dependencies));
    await Effect.runPromise(runServiceStopProgram(input, test.dependencies));
    await Effect.runPromise(runServiceRestartProgram(input, test.dependencies));
    await Effect.runPromise(runServiceStatusProgram(input, test.dependencies));

    expect(test.actions).toEqual(["install", "uninstall", "start", "stop", "restart", "status"]);
    expect(test.described).toEqual([input, input, input, input, input, input]);
    expect(test.output).toContain("SelfTune service install completed on darwin.");
    expect(test.output).toContain("Running: yes (pid 4242)");
    expect(test.output).toContain("Runtime healthy.");
  });

  it("keeps JSON output machine-readable", async () => {
    const test = harness();

    await Effect.runPromise(runServiceStatusProgram({ ...input, json: true }, test.dependencies));

    expect(test.output).toHaveLength(1);
    expect(JSON.parse(test.output[0])).toMatchObject({
      action: "status",
      ok: true,
      status: { registered: true, running: true },
    });
  });

  it("adapts legacy arguments into the typed contract", async () => {
    const test = harness();

    await Effect.runPromise(
      serviceCliProgram(
        [
          "install",
          "--boot",
          "--config-dir",
          "/var/lib/selftune",
          "--executable",
          "/opt/selftune",
          "--json",
          "--owner",
          "desktop",
          "--port",
          "9000",
          "--resource-dir",
          "/opt/resources",
          "--version",
          "2.0.0",
        ],
        test.dependencies,
      ),
    );

    expect(test.actions).toEqual(["install"]);
    expect(test.described).toEqual([
      {
        boot: true,
        configDir: "/var/lib/selftune",
        executable: "/opt/selftune",
        json: true,
        owner: "desktop",
        port: 9000,
        resourceDir: "/opt/resources",
        version: "2.0.0",
      },
    ]);
  });

  it("rejects invalid legacy values before invoking a backend", async () => {
    const test = harness();

    const failure = await Effect.runPromise(
      serviceCliProgram(["start", "--port", "70000"], test.dependencies).pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(ServiceFailure);
    expect(failure).toMatchObject({ operation: "parse", message: "Invalid service port: 70000" });
    expect(test.actions).toEqual([]);
    expect(test.described).toEqual([]);
  });
});
