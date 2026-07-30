import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  generateWindowsDaemonWrapper,
  generateWindowsTaskXml,
  getServiceBackend,
  expectedRuntimeIsPresent,
  runServiceCommand,
  runServiceProcess,
  ServiceManager,
  serviceEnvironment,
  serviceProgramArguments,
  serviceRuntimeIsReady,
  type LocalRuntimeControl,
  type ServiceBackend,
  type ServiceDescriptor,
} from "@selftune/local/service";
import type { ServerManifest } from "@selftune/local/local-runtime";
import { makeWindowsServiceInstallationPlan } from "@selftune/local/service/windows/backend";
import {
  createWindowsServiceInstallationReceipt,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import type {
  WindowsListenerRecoveryOutcome,
  WindowsRuntimeAuthorization,
  WindowsRuntimeReadiness,
} from "@selftune/local/service/windows/runtime/contract";
import type { WindowsServiceInstallationEvidence } from "@selftune/local/service/windows/installation/contract";

const descriptor: ServiceDescriptor = {
  executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
  executableArgsPrefix: [],
  resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
  configDir: "/Users/test/.selftune",
  owner: "desktop",
  version: "0.3.0",
  port: 7888,
  boot: false,
};

const windowsDescriptor: ServiceDescriptor = {
  ...descriptor,
  configDir: "C:\\Users\\test\\.selftune",
  executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
  resourceDir: "C:\\Program Files\\SelfTune",
};

const installationNonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";

function windowsReceipt(
  installId = "10101010-1010-4010-9010-101010101010",
  receiptDescriptor = windowsDescriptor,
): WindowsServiceInstallationReceipt {
  const plan = makeWindowsServiceInstallationPlan(receiptDescriptor, {
    systemRoot: "C:\\Windows",
  });
  const paths = plan.artifactPaths(installId);
  return createWindowsServiceInstallationReceipt({
    artifacts: {
      launcher: { path: paths.launcher, sha256: "1".repeat(64) },
      taskDefinition: { path: paths.taskDefinition, sha256: "2".repeat(64) },
      wrapper: { path: paths.wrapper, sha256: "3".repeat(64) },
    },
    boot: plan.receipt.boot,
    configDir: plan.receipt.configDir,
    executableArgsPrefix: plan.receipt.executableArgsPrefix,
    executablePath: plan.receipt.executablePath,
    expectedArgv: [
      ...plan.receipt.expectedArgvWithoutNonce,
      "--service-installation-nonce",
      installationNonce,
    ],
    installId,
    installedAt: "2026-07-16T12:30:00.000Z",
    nonce: installationNonce,
    owner: plan.receipt.owner,
    port: plan.receipt.port,
    taskName: `${plan.taskNamePrefix}-${installId}`,
    userSid: "S-1-5-21-1000-2000-3000-4000",
  });
}

const roots: string[] = [];

async function waitUntil(predicate: () => boolean, deadline: number): Promise<boolean> {
  if (predicate()) return true;
  if (Date.now() >= deadline) return false;
  await Bun.sleep(10);
  return waitUntil(predicate, deadline);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const serviceManifest: ServerManifest = {
  version: 2,
  kind: "selftune-runtime",
  pid: 4242,
  port: 7888,
  origin: "http://127.0.0.1:7888",
  started_at: "2026-07-15T00:00:00.000Z",
  owner: "desktop",
  supervision: "os-service",
  owner_version: "0.3.0",
  owner_executable_path: descriptor.executablePath,
  instance_id: "11111111-1111-4111-8111-111111111111",
};

const directCliManifest: ServerManifest = {
  ...serviceManifest,
  pid: 4343,
  owner: "cli",
  supervision: "none",
  owner_executable_path: "/usr/local/bin/selftune",
  instance_id: "22222222-2222-4222-8222-222222222222",
};

type WindowsInstallationState =
  | "Absent"
  | "LegacyCompatible"
  | "Owned"
  | "OwnedIncomplete"
  | "Refused";

interface ServiceCommandHarnessOptions {
  readonly installation?: WindowsInstallationState;
  readonly installedPort?: number;
  readonly ownershipChangesAfterStop?: boolean;
  readonly readiness?: WindowsRuntimeReadiness;
  readonly recoveryOutcome?: WindowsListenerRecoveryOutcome;
  readonly taskRemainsRunningAfterStop?: boolean;
  readonly verificationOutcome?: WindowsListenerRecoveryOutcome;
}

const withMutationLock = <A, E, R>(
  _descriptor: ServiceDescriptor,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => use;

function serviceCommandHarness(
  platform: ServiceBackend["platform"],
  initialRuntime: "cli" | "service" | "none" = "service",
  runtimeReachable = true,
  options: ServiceCommandHarnessOptions = {},
) {
  type BackendOperation = "install" | "restart" | "start" | "status" | "stop" | "uninstall";
  const events: string[] = [];
  const backendCalls: Array<{
    readonly descriptor: ServiceDescriptor;
    readonly operation: BackendOperation;
  }> = [];
  const runtimeAuthorizations: WindowsRuntimeAuthorization[] = [];
  const verificationDescriptors: ServiceDescriptor[] = [];
  const recordBackendCall = (operation: BackendOperation, received: ServiceDescriptor) => {
    backendCalls.push({ descriptor: received, operation });
  };
  let installation = options.installation ?? "Owned";
  let registered = installation !== "Absent" && installation !== "OwnedIncomplete";
  let running = registered;
  let runtimeKind = initialRuntime;
  let receipt = windowsReceipt("10101010-1010-4010-9010-101010101010", {
    ...windowsDescriptor,
    port: options.installedPort ?? windowsDescriptor.port,
  });
  const currentManifest = (): ServerManifest | null =>
    runtimeKind === "service" ? serviceManifest : runtimeKind === "cli" ? directCliManifest : null;
  const backendBase = {
    automated: true,
    diagnoseMutationLock: () => Effect.die("unexpected lock diagnosis"),
    repairMutationLock: () => Effect.die("unexpected lock repair"),
    install: (received) =>
      Effect.sync(() => {
        recordBackendCall("install", received);
        events.push("backend:install");
        registered = true;
        running = true;
        installation = "Owned";
        receipt = windowsReceipt("30303030-3030-4030-9030-303030303030", received);
        runtimeKind = "service";
      }),
    uninstall: (received) =>
      Effect.sync(() => {
        recordBackendCall("uninstall", received);
        events.push("backend:uninstall");
        registered = false;
        running = false;
        installation = "Absent";
      }),
    start: (received) =>
      Effect.sync(() => {
        recordBackendCall("start", received);
        events.push("backend:start");
        running = true;
        installation = "Owned";
        if (runtimeKind === "none") runtimeKind = "service";
      }),
    status: (received) =>
      Effect.sync(() => {
        recordBackendCall("status", received);
        return {
          detail: [],
          pid: null,
          platform,
          registered,
          running,
        };
      }),
    stop: (received) =>
      Effect.sync(() => {
        recordBackendCall("stop", received);
        events.push("backend:stop");
        running = options.taskRemainsRunningAfterStop ?? false;
        if (options.ownershipChangesAfterStop) {
          receipt = windowsReceipt("20202020-2020-4020-9020-202020202020");
        }
      }),
    restart: (received) =>
      Effect.sync(() => {
        recordBackendCall("restart", received);
        running = true;
        if (runtimeKind === "none") runtimeKind = "service";
      }),
  };
  const inspectInstallation = (): Effect.Effect<WindowsServiceInstallationEvidence> =>
    Effect.sync(() => {
      events.push(`windows:inspect:${installation}`);
      const base = {
        currentUserSid: "S-1-5-21-1000-2000-3000-4000",
        task: { registered, running },
      };
      switch (installation) {
        case "Absent":
          return { ...base, _tag: "Absent" };
        case "LegacyCompatible":
          return { ...base, _tag: "LegacyCompatible", artifacts: receipt.artifacts };
        case "Owned":
          return { ...base, _tag: "Owned", receipt };
        case "OwnedIncomplete":
          return { ...base, _tag: "OwnedIncomplete", receipt };
        case "Refused":
          return { ...base, _tag: "Refused", reason: "foreign-task" };
      }
    });
  const backend: ServiceBackend =
    platform === "win32"
      ? { ...backendBase, inspectInstallation, platform, withMutationLock }
      : { ...backendBase, platform };
  const runtime: LocalRuntimeControl = {
    status: () =>
      Effect.sync(() => {
        const manifest = currentManifest();
        return { manifest, reachable: manifest !== null && runtimeReachable };
      }),
    stop: (_configDir, expectation) =>
      Effect.sync(() => {
        events.push("runtime:stop");
        const manifest = currentManifest();
        if (
          expectation &&
          (manifest?.pid !== expectation.pid || manifest.instance_id !== expectation.instanceId)
        ) {
          return false;
        }
        const stopped = manifest !== null;
        runtimeKind = "none";
        return stopped;
      }),
  };
  return {
    backendCalls,
    events,
    layer: Layer.succeed(ServiceManager)({
      backend,
      runtime,
      windowsRecovery: {
        recoverAuthorized: (authorization) =>
          Effect.sync(() => {
            events.push("windows:recover-authorized");
            runtimeAuthorizations.push(authorization);
            runtimeKind = "none";
            return options.recoveryOutcome ?? { outcome: "absent", port: windowsDescriptor.port };
          }),
        verifyAbsent: (received) =>
          Effect.sync(() => {
            events.push("windows:verify-absent");
            verificationDescriptors.push(received);
            return (
              options.verificationOutcome ?? { outcome: "absent", port: windowsDescriptor.port }
            );
          }),
        verifyRunning: (authorization) =>
          Effect.sync(() => {
            events.push("windows:verify-running");
            runtimeAuthorizations.push(authorization);
            return (
              options.readiness ?? {
                _tag: "Ready",
                instanceId: serviceManifest.instance_id,
                owner: "desktop",
                ownerExecutablePath: windowsDescriptor.executablePath,
                ownerVersion: windowsDescriptor.version,
                pid: serviceManifest.pid,
                port: windowsDescriptor.port,
              }
            );
          }),
      },
    }),
    runtimeAuthorizations,
    verificationDescriptors,
  };
}

describe("supervised service definitions", () => {
  it("terminates an owned subprocess when its Effect is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-service-process-"));
    roots.push(root);
    const pidPath = join(root, "pid");
    const controller = new AbortController();
    const running = Effect.runPromise(
      runServiceProcess(process.execPath, [
        "-e",
        `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ]),
      { signal: controller.signal },
    );
    expect(await waitUntil(() => existsSync(pidPath), Date.now() + 2_000)).toBe(true);
    const pid = Number(readFileSync(pidPath, "utf8"));

    controller.abort();
    await running.catch(() => undefined);
    expect(processIsAlive(pid)).toBe(false);
  });

  it("settles interruption when process startup fails concurrently", async () => {
    const controller = new AbortController();
    const running = Effect.runPromise(
      runServiceProcess("/definitely/missing/selftune-service-command", []),
      { signal: controller.signal },
    );
    controller.abort();

    await Promise.race([
      running.catch(() => undefined),
      Bun.sleep(2_000).then(() => {
        throw new Error("Interrupted service process did not settle.");
      }),
    ]);
  });

  it("runs daemon mode through the same SelfTune binary", () => {
    if (!descriptor.resourceDir) throw new Error("Desktop test descriptor needs a resource root.");
    expect(serviceProgramArguments(descriptor)).toEqual([
      descriptor.executablePath,
      "daemon",
      "run",
      "--foreground",
      "--supervised",
      "--owner",
      "desktop",
      "--port",
      "7888",
      "--hostname",
      "127.0.0.1",
      "--runtime-mode",
      "standalone",
      "--spa-dir",
      join(descriptor.resourceDir, "dashboard"),
    ]);
  });

  it("preserves CLI ownership in a CLI-installed service", () => {
    const cliDescriptor: ServiceDescriptor = {
      ...descriptor,
      owner: "cli",
      resourceDir: undefined,
    };

    expect(serviceProgramArguments(cliDescriptor)).toContain("cli");
    expect(serviceEnvironment(cliDescriptor)).toMatchObject({
      SELFTUNE_DESKTOP: "0",
      SELFTUNE_RUNTIME_OWNER: "cli",
      SELFTUNE_SUPERVISED: "1",
    });
  });

  it("takes over the authenticated predecessor before installing a service", async () => {
    const harness = serviceCommandHarness("darwin");

    await Effect.runPromise(
      runServiceCommand("install", descriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events).toEqual(["runtime:stop", "backend:install"]);
  });

  it("passes the exact service descriptor to every backend lifecycle call", async () => {
    const actions: ReadonlyArray<Parameters<typeof runServiceCommand>[0]> = [
      "install",
      "uninstall",
      "start",
      "stop",
      "restart",
      "status",
    ];

    await Promise.all(
      actions.map(async (action) => {
        const harness = serviceCommandHarness("darwin", "none");
        const commandDescriptor: ServiceDescriptor = {
          ...descriptor,
          configDir: `/Users/test/.selftune-${action}`,
        };

        await Effect.runPromise(
          runServiceCommand(action, commandDescriptor).pipe(Effect.provide(harness.layer)),
        );

        expect(harness.backendCalls.some((call) => call.operation === action)).toBe(true);
        expect(harness.backendCalls.every((call) => call.descriptor === commandDescriptor)).toBe(
          true,
        );
      }),
    );
  });

  it("installs an absent Windows service only after authenticated takeover and a clean scan", async () => {
    const harness = serviceCommandHarness("win32", "cli", true, {
      installation: "Absent",
    });

    await Effect.runPromise(
      runServiceCommand("install", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events.join(",")).toBe(
      "windows:inspect:Absent,runtime:stop,windows:verify-absent,backend:install,windows:inspect:Owned,windows:inspect:Owned,windows:verify-running,windows:inspect:Owned,windows:verify-running,windows:inspect:Owned",
    );
    expect(harness.runtimeAuthorizations).toHaveLength(2);
    expect(
      harness.runtimeAuthorizations.every(
        (authorization) =>
          authorization._tag === "NonceBound" &&
          authorization.installationNonce === installationNonce &&
          authorization.port === windowsDescriptor.port,
      ),
    ).toBe(true);
  });

  it("refuses foreign Windows installation evidence before any mutation", async () => {
    const harness = serviceCommandHarness("win32", "service", true, {
      installation: "Refused",
    });

    await expect(
      Effect.runPromise(
        runServiceCommand("uninstall", windowsDescriptor).pipe(Effect.provide(harness.layer)),
      ),
    ).rejects.toThrow("installation ownership refused");
    expect(harness.events).toEqual(["windows:inspect:Refused"]);
    expect(harness.backendCalls).toHaveLength(0);
  });

  it("treats absent Windows stop and uninstall as scan-only idempotent operations", async () => {
    await Promise.all(
      (["stop", "uninstall"] as const).map(async (action) => {
        const harness = serviceCommandHarness("win32", "none", true, {
          installation: "Absent",
        });
        await Effect.runPromise(
          runServiceCommand(action, windowsDescriptor).pipe(Effect.provide(harness.layer)),
        );
        expect(harness.events.join(",")).toBe(
          "windows:inspect:Absent,windows:verify-absent,windows:inspect:Absent,windows:inspect:Absent",
        );
        expect(harness.backendCalls).toHaveLength(0);
      }),
    );
  });

  it("stops owned Windows services before nonce-authorized recovery", async () => {
    const harness = serviceCommandHarness("win32");

    await Effect.runPromise(
      runServiceCommand("stop", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events.join(",")).toBe(
      "windows:inspect:Owned,backend:stop,windows:inspect:Owned,windows:recover-authorized,windows:verify-absent,windows:inspect:Owned,windows:inspect:Owned,windows:inspect:Owned",
    );
    expect(harness.runtimeAuthorizations[0]).toEqual(
      expect.objectContaining({
        _tag: "NonceBound",
        installationNonce,
      }),
    );
    expect(harness.events).not.toContain("runtime:stop");
  });

  it("does not recover a listener when installation identity changes after task stop", async () => {
    const harness = serviceCommandHarness("win32", "service", true, {
      ownershipChangesAfterStop: true,
    });

    await expect(
      Effect.runPromise(
        runServiceCommand("restart", windowsDescriptor).pipe(Effect.provide(harness.layer)),
      ),
    ).rejects.toThrow("ownership changed after stopping");
    expect(harness.events).toEqual([
      "windows:inspect:Owned",
      "backend:stop",
      "windows:inspect:Owned",
    ]);
  });

  it("does not recover a listener while the owned scheduled task still reports running", async () => {
    const harness = serviceCommandHarness("win32", "service", true, {
      taskRemainsRunningAfterStop: true,
    });

    await expect(
      Effect.runPromise(
        runServiceCommand("stop", windowsDescriptor).pipe(Effect.provide(harness.layer)),
      ),
    ).rejects.toThrow("ownership changed after stopping");
    expect(harness.events).toEqual([
      "windows:inspect:Owned",
      "backend:stop",
      "windows:inspect:Owned",
    ]);
  });

  it("recovers and verifies the receipt port when the requested descriptor has drifted", async () => {
    const installedPort = windowsDescriptor.port + 1;
    const harness = serviceCommandHarness("win32", "service", true, { installedPort });

    await Effect.runPromise(
      runServiceCommand("stop", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.runtimeAuthorizations[0]).toEqual(
      expect.objectContaining({ port: installedPort }),
    );
    expect(harness.verificationDescriptors.map(({ port }) => port)).toEqual([installedPort]);
  });

  it("repairs incomplete Windows installations without trying to stop a missing task", async () => {
    const harness = serviceCommandHarness("win32", "service", true, {
      installation: "OwnedIncomplete",
    });

    await Effect.runPromise(
      runServiceCommand("restart", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events.join(",")).toBe(
      "windows:inspect:OwnedIncomplete,windows:recover-authorized,windows:verify-absent,windows:inspect:OwnedIncomplete,windows:verify-absent,backend:install,windows:inspect:Owned,windows:inspect:Owned,windows:verify-running,windows:inspect:Owned,windows:verify-running,windows:inspect:Owned",
    );
    expect(harness.events).not.toContain("backend:stop");
  });

  it("rejects start for an incomplete Windows installation without mutation", async () => {
    const harness = serviceCommandHarness("win32", "none", true, {
      installation: "OwnedIncomplete",
    });

    await expect(
      Effect.runPromise(
        runServiceCommand("start", windowsDescriptor).pipe(Effect.provide(harness.layer)),
      ),
    ).rejects.toThrow("installation is incomplete");
    expect(harness.events).toEqual(["windows:inspect:OwnedIncomplete"]);
  });

  it("keeps the task when nonce-authorized recovery refuses the installed runtime", async () => {
    const harness = serviceCommandHarness("win32", "service", true, {
      recoveryOutcome: {
        candidatePids: [serviceManifest.pid],
        outcome: "refused",
        port: windowsDescriptor.port,
        reason: "health-installation-nonce-mismatch",
      },
    });

    await expect(
      Effect.runPromise(
        runServiceCommand("uninstall", windowsDescriptor).pipe(Effect.provide(harness.layer)),
      ),
    ).rejects.toThrow("Windows listener recovery refused");
    expect(harness.events).toEqual([
      "windows:inspect:Owned",
      "backend:stop",
      "windows:inspect:Owned",
      "windows:recover-authorized",
    ]);
    expect(harness.events).not.toContain("backend:uninstall");
  });

  it("uninstalls only after recovery and proves both task and listener absence", async () => {
    const installedPort = windowsDescriptor.port + 1;
    const harness = serviceCommandHarness("win32", "service", true, { installedPort });

    await Effect.runPromise(
      runServiceCommand("uninstall", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events.join(",")).toBe(
      "windows:inspect:Owned,backend:stop,windows:inspect:Owned,windows:recover-authorized,windows:verify-absent,windows:inspect:Owned,backend:uninstall,windows:inspect:Absent,windows:verify-absent,windows:inspect:Absent,windows:inspect:Absent",
    );
    expect(harness.verificationDescriptors.map(({ port }) => port)).toEqual([
      installedPort,
      installedPort,
    ]);
  });

  it("uses nonce-bound listener readiness instead of the runtime manifest on Windows", async () => {
    const harness = serviceCommandHarness("win32", "none");

    await Effect.runPromise(
      runServiceCommand("start", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events.join(",")).toBe(
      "windows:inspect:Owned,backend:start,windows:inspect:Owned,windows:verify-running,windows:inspect:Owned,windows:verify-running,windows:inspect:Owned",
    );
  });

  it("does not display manifest detail for refused Windows status evidence", async () => {
    const harness = serviceCommandHarness("win32", "service", true, {
      installation: "Refused",
    });

    const response = await Effect.runPromise(
      runServiceCommand("status", windowsDescriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(response.status.detail).toEqual([
      "The SelfTune scheduled task is not safe to control: foreign-task.",
    ]);
    expect(harness.events).toEqual(["windows:inspect:Refused", "windows:inspect:Refused"]);
  });

  it("requires the reachable runtime to belong to the OS service", () => {
    const backendStatus = {
      detail: [],
      pid: null,
      platform: "win32",
      registered: true,
      running: true,
    };

    expect(
      serviceRuntimeIsReady(backendStatus, { manifest: serviceManifest, reachable: true }),
    ).toBe(true);
    expect(
      serviceRuntimeIsReady(
        backendStatus,
        { manifest: serviceManifest, reachable: true },
        descriptor,
      ),
    ).toBe(true);
    expect(
      serviceRuntimeIsReady(
        backendStatus,
        { manifest: serviceManifest, reachable: true },
        { ...descriptor, version: "0.4.0" },
      ),
    ).toBe(false);
    expect(
      serviceRuntimeIsReady(
        backendStatus,
        { manifest: serviceManifest, reachable: true },
        { ...descriptor, executablePath: "/Applications/Other.app/Contents/MacOS/other" },
      ),
    ).toBe(false);
    expect(
      serviceRuntimeIsReady(backendStatus, { manifest: directCliManifest, reachable: true }),
    ).toBe(false);
    expect(
      serviceRuntimeIsReady(
        { ...backendStatus, pid: serviceManifest.pid + 1 },
        { manifest: serviceManifest, reachable: true },
      ),
    ).toBe(false);
  });

  it("tracks the stopped service instance without treating a replacement as the same runtime", () => {
    const expectation = {
      instanceId: serviceManifest.instance_id,
      pid: serviceManifest.pid,
    };

    expect(expectedRuntimeIsPresent(serviceManifest, expectation)).toBe(true);
    expect(expectedRuntimeIsPresent(directCliManifest, expectation)).toBe(false);
  });

  it("shows manifest detail only after authenticated runtime verification", async () => {
    const authenticated = serviceCommandHarness("darwin");
    const authenticatedResponse = await Effect.runPromise(
      runServiceCommand("status", descriptor).pipe(Effect.provide(authenticated.layer)),
    );
    expect(authenticatedResponse.status.detail).toContain(
      "Serving http://127.0.0.1:7888 (pid 4242, SelfTune 0.3.0, desktop-owned).",
    );

    const stale = serviceCommandHarness("darwin", "service", false);
    const staleResponse = await Effect.runPromise(
      runServiceCommand("status", descriptor).pipe(Effect.provide(stale.layer)),
    );
    expect(staleResponse.status.detail).toEqual([]);
  });

  it("generates a hidden per-user Windows task with restart-on-failure", () => {
    const wrapperNonce = "A".repeat(43);
    const wrapper = generateWindowsDaemonWrapper(
      {
        ...descriptor,
        executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
        configDir: "C:\\Users\\test\\.selftune",
        resourceDir: "C:\\Program Files\\SelfTune",
      },
      wrapperNonce,
    );
    expect(wrapper).toContain("daemon");
    expect(wrapper).toContain("SELFTUNE_SUPERVISED=1");
    expect(wrapper).not.toContain("AUTH_TOKEN");
    expect(wrapper.match(/--service-installation-nonce/g)).toHaveLength(1);
    expect(wrapper).toContain(wrapperNonce);

    const task = generateWindowsTaskXml({
      boot: false,
      commandPath: "C:\\Windows\\System32\\wscript.exe",
      launcherPath: "C:\\Users\\test\\.selftune\\server-control\\run-daemon.vbs",
      userId: "WORKSTATION\\test",
    });
    expect(task).toContain("<LogonTrigger>");
    expect(task).toContain("<RestartOnFailure>");
    expect(task).toContain("InteractiveToken");
    expect(task).toContain("<Command>C:\\Windows\\System32\\wscript.exe</Command>");
  });

  it("preserves ordinary Windows wrapper paths and arguments", () => {
    const configDir = "C:\\Users\\test user\\.selftune";
    const wrapper = generateWindowsDaemonWrapper({
      ...descriptor,
      executableArgsPrefix: ["--channel", "stable release"],
      executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
      configDir,
      resourceDir: "C:\\Program Files\\SelfTune",
    });

    expect(wrapper).not.toContain("setlocal DisableDelayedExpansion");
    expect(wrapper).toContain('"C:\\Program Files\\SelfTune\\selftune.exe"');
    expect(wrapper).toContain('"--channel" "stable release" "daemon"');
    expect(wrapper).toContain(`1>> "${join(configDir, "logs", "daemon.log")}"`);
  });

  it("escapes percent expansion and safely preserves quoted CMD metacharacters", () => {
    for (const character of ["%", "&", "!", "^"]) {
      const configDir = `C:\\Users\\test${character}profile\\.selftune`;
      const wrapper = generateWindowsDaemonWrapper({ ...descriptor, configDir });
      const renderedCharacter = character === "%" ? "%%" : character;

      expect(wrapper).toContain(
        `SELFTUNE_CONFIG_DIR=C:\\Users\\test${renderedCharacter}profile\\.selftune`,
      );
      expect(wrapper).toContain(
        `1>> "${join(
          `C:\\Users\\test${renderedCharacter}profile\\.selftune`,
          "logs",
          "daemon.log",
        )}"`,
      );
      expect(wrapper.includes("setlocal DisableDelayedExpansion")).toBe(character === "!");
    }
  });

  it("rejects CMD values that cannot be represented without changing their meaning", () => {
    const invalidDescriptors: ReadonlyArray<ServiceDescriptor> = [
      { ...descriptor, executablePath: 'C:\\Apps\\Self"Tune\\selftune.exe' },
      { ...descriptor, executableArgsPrefix: ["unsafe\nargument"] },
      { ...descriptor, configDir: "C:\\Users\\unsafe\rdirectory" },
      { ...descriptor, version: "unsafe\0version" },
    ];

    for (const invalidDescriptor of invalidDescriptors) {
      expect(() => generateWindowsDaemonWrapper(invalidDescriptor)).toThrow(
        /cannot contain double quotes, line breaks, or NUL bytes/,
      );
    }
  });

  it("selects a backend for every supported desktop platform", () => {
    expect(getServiceBackend("darwin").platform).toBe("darwin");
    expect(getServiceBackend("linux").platform).toBe("linux");
    const windowsBackend = getServiceBackend("win32");
    expect(windowsBackend.platform).toBe("win32");
    expect(
      windowsBackend.platform === "win32" && windowsBackend.inspectInstallation,
    ).toBeFunction();
    expect(getServiceBackend("freebsd").platform).toBe("unsupported");
  });
});
