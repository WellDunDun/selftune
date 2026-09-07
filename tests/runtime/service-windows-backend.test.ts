import { serviceFromLayer } from "../helpers/service-layer";
import { WindowsBackendProvider } from "@selftune/local/service/windows/backend";
import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";

import * as Effect from "effect/Effect";

import {
  authorizationFromEvidence,
  makeWindowsServiceBackendLayer,
  makeWindowsServiceInstallationPlan,
} from "@selftune/local/service/windows/backend";
import type {
  LocalRuntimeControl,
  ServiceDescriptor,
  WindowsRuntimeRecovery,
} from "@selftune/local/service-contract";
import {
  createWindowsServiceInstallationReceipt,
  sha256Hex,
  type WindowsServiceInstallationArtifacts,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import type { WindowsServiceInstallationArtifactStore } from "@selftune/local/service/windows/installation/controller";
import type { WindowsServiceInstallationStoreWithUserControl } from "@selftune/local/service/windows/installation/store";
import {
  WINDOWS_USER_SERVICE_NAMESPACE,
  WindowsServiceMutationLockError,
  type WindowsUserServiceMutationLock,
  type WindowsUserServiceMutationLockScope,
} from "@selftune/local/service/windows/mutation-lock";
import { runWindowsServiceCommand } from "@selftune/local/service/windows/orchestration";
import type { WindowsTaskScheduler } from "@selftune/local/service/windows/scheduler";
import type { WindowsServiceLockCompatibilityDiagnostic } from "@selftune/local/service/windows/lock-compatibility";

const descriptor: ServiceDescriptor = {
  boot: false,
  configDir: "C:\\Users\\Ada\\.selftune",
  executableArgsPrefix: ["C:\\SelfTune\\selftune.ts"],
  executablePath: "C:\\Program Files\\Bun\\bun.exe",
  owner: "desktop",
  port: 7888,
  version: "1.4.0",
};
const installId = "10101010-1010-4010-9010-101010101010";
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";
const sid = "S-1-5-21-1000-2000-3000-4000";
const userServiceScope: WindowsUserServiceMutationLockScope = {
  controlDir: "c:\\users\\ada\\appdata\\local\\selftune\\service-control",
  namespace: WINDOWS_USER_SERVICE_NAMESPACE,
  userSid: sid,
};

function receiptFixture(inputDescriptor = descriptor) {
  const plan = makeWindowsServiceInstallationPlan(inputDescriptor, {
    systemRoot: "C:\\Windows",
  });
  const paths = plan.artifactPaths(installId);
  const placeholders: WindowsServiceInstallationArtifacts = {
    launcher: { path: paths.launcher, sha256: "0".repeat(64) },
    taskDefinition: { path: paths.taskDefinition, sha256: "0".repeat(64) },
    wrapper: { path: paths.wrapper, sha256: "0".repeat(64) },
  };
  const draft = createWindowsServiceInstallationReceipt({
    artifacts: placeholders,
    boot: plan.receipt.boot,
    configDir: plan.receipt.configDir,
    executableArgsPrefix: plan.receipt.executableArgsPrefix,
    executablePath: plan.receipt.executablePath,
    expectedArgv: [...plan.receipt.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
    installId,
    installedAt: "2026-07-16T12:30:00.000Z",
    nonce,
    owner: plan.receipt.owner,
    port: plan.receipt.port,
    taskName: `${plan.taskNamePrefix}-${installId}`,
    userSid: sid,
  });
  const rendered = plan.renderArtifacts(draft);
  const encodedTask = plan.encodeTaskDefinition(rendered.taskDefinitionXml);
  const receipt = createWindowsServiceInstallationReceipt({
    ...draft,
    artifacts: {
      launcher: { path: paths.launcher, sha256: sha256Hex(rendered.launcher) },
      taskDefinition: { path: paths.taskDefinition, sha256: sha256Hex(encodedTask) },
      wrapper: { path: paths.wrapper, sha256: sha256Hex(rendered.wrapper) },
    },
  });
  return { encodedTask, receipt, rendered };
}

interface HarnessOptions {
  readonly lockDiagnostic?: WindowsServiceLockCompatibilityDiagnostic;
  readonly lockRepairProducesFence?: boolean;
  readonly lockAcquisitionFails?: boolean;
  readonly receipt?: WindowsServiceInstallationReceipt | null;
  readonly tamperWrapper?: boolean;
}

function backendHarness(options: HarnessOptions = {}) {
  const fixture = receiptFixture();
  let receipt = options.receipt === undefined ? fixture.receipt : options.receipt;
  const events: string[] = [];
  const files = new Map<string, Uint8Array>();
  const lockScopes: WindowsUserServiceMutationLockScope[] = [];
  let lockHeld = false;
  let lockDiagnostic =
    options.lockDiagnostic ??
    ({
      _tag: "Absent",
      path: `${userServiceScope.controlDir}\\windows-service-mutation.lock`,
    } satisfies WindowsServiceLockCompatibilityDiagnostic);
  let registered = receipt !== null;
  let running = registered;

  if (receipt !== null) {
    const plan = makeWindowsServiceInstallationPlan(descriptor, { systemRoot: "C:\\Windows" });
    const rendered = plan.renderArtifacts(receipt);
    files.set(receipt.artifacts.launcher.path, rendered.launcher);
    files.set(
      receipt.artifacts.taskDefinition.path,
      plan.encodeTaskDefinition(rendered.taskDefinitionXml),
    );
    files.set(
      receipt.artifacts.wrapper.path,
      options.tamperWrapper ? Buffer.from("changed", "utf8") : rendered.wrapper,
    );
  }

  const artifacts: WindowsServiceInstallationArtifactStore = {
    read: (path) =>
      Effect.sync(() => {
        events.push(`artifact:read:${path}`);
        return files.get(path) ?? null;
      }),
    removeMatching: ({ artifact }) =>
      Effect.sync(() => {
        events.push(`artifact:remove:${artifact.path}`);
        files.delete(artifact.path);
      }),
    write: (path, contents) =>
      Effect.sync(() => {
        events.push(`artifact:write:${path}`);
        files.set(path, contents);
      }),
  };

  const store: WindowsServiceInstallationStoreWithUserControl = {
    createLegacyCleanup: () => Effect.die("unused createLegacyCleanup"),
    createReceipt: () => Effect.succeed(fixture.receipt),
    persistReceipt: () => Effect.succeed(fixture.receipt),
    prepareServerControl: () =>
      Effect.sync(() => {
        events.push("server-control:prepare");
        return `${descriptor.configDir}\\server-control`;
      }),
    prepareUserServiceControl: () =>
      Effect.sync(() => {
        events.push("user-service-control:prepare");
        return userServiceScope;
      }),
    resolveUserServiceControl: () =>
      Effect.sync(() => {
        events.push("user-service-control:resolve");
        return userServiceScope;
      }),
    readReceipt: () =>
      Effect.sync(() => {
        events.push("receipt:read");
        return receipt;
      }),
    readLegacyCleanup: () => Effect.succeed(null),
    removeLegacyCleanup: () => Effect.die("unused removeLegacyCleanup"),
    removeReceiptAfterCleanup: (_configDir, _expected, cleanup) =>
      cleanup.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push("receipt:remove");
            receipt = null;
          }),
        ),
      ),
    resolveCurrentUserSid: () =>
      Effect.sync(() => {
        events.push("sid:read");
        return sid;
      }),
    requireLegacyCleanup: () => Effect.die("unused requireLegacyCleanup"),
    writeReceipt: (next) =>
      Effect.sync(() => {
        events.push("receipt:write");
        receipt = next;
      }),
  };

  const schedulerFor = (taskName: string): WindowsTaskScheduler<unknown> => ({
    create: () => Effect.void,
    createExclusive: () =>
      Effect.sync(() => {
        events.push("task:create");
        registered = true;
      }),
    delete: () =>
      Effect.sync(() => {
        events.push("task:delete");
        registered = false;
        running = false;
      }),
    end: () =>
      Effect.sync(() => {
        events.push("task:end");
        running = false;
      }),
    listTaskNames: () =>
      Effect.succeed(receipt !== null && registered ? [`\\${receipt.taskName}`] : []),
    query: () =>
      Effect.sync(() => {
        events.push(`task:query:${taskName}`);
        const ownedTask = receipt?.taskName === taskName;
        return {
          registered: ownedTask && registered,
          running: ownedTask && running,
        };
      }),
    readDefinition: () =>
      Effect.sync(() => {
        events.push("task:definition");
        if (receipt === null) return null;
        return makeWindowsServiceInstallationPlan(descriptor, {
          systemRoot: "C:\\Windows",
        }).renderArtifacts(receipt).taskDefinitionXml;
      }),
    start: () =>
      Effect.sync(() => {
        events.push("task:start");
        running = true;
      }),
  });

  const mutationLock: WindowsUserServiceMutationLock = {
    acquire: (scope) =>
      Effect.sync(() => {
        lockScopes.push(scope);
        const acquisitionFails = options.lockAcquisitionFails === true || lockHeld;
        events.push(acquisitionFails ? "lock:acquire-failed" : "lock:acquire");
        if (!acquisitionFails) lockHeld = true;
        return {
          acquisitionFails,
          lease: { ...scope, path: `${scope.controlDir}\\mutation.lock`, token: nonce },
        };
      }).pipe(
        Effect.flatMap(({ acquisitionFails, lease }) =>
          acquisitionFails
            ? Effect.fail(
                WindowsServiceMutationLockError.make({
                  message: "lock already held",
                  operation: "acquire-user-service-mutation-lock",
                }),
              )
            : Effect.succeed(lease),
        ),
      ),
    release: () =>
      Effect.sync(() => {
        events.push("lock:release");
        lockHeld = false;
      }),
    withLock: (scope, use) =>
      Effect.acquireUseRelease(
        Effect.succeed({ ...scope, path: `${scope.controlDir}\\mutation.lock`, token: nonce }),
        () => use,
        () => Effect.void,
      ),
  };

  const backend = serviceFromLayer(
    WindowsBackendProvider,
    makeWindowsServiceBackendLayer({
      artifacts,
      legacyUser: { domain: "DOMAIN", username: "Test" },
      lockCompatibility: {
        diagnose: () =>
          Effect.sync(() => {
            events.push(`lock:diagnose:${lockDiagnostic._tag}`);
            return lockDiagnostic;
          }),
        ensureFence: () => Effect.void,
        repairStale: (_scope, candidate) =>
          Effect.sync(() => {
            events.push(`lock:repair:${candidate.generation}`);
            if (options.lockRepairProducesFence === false) return;
            lockDiagnostic = {
              _tag: "FenceReady",
              fence: {
                ...userServiceScope,
                kind: "sqlite-ownership-fence",
                version: 3,
              },
              path: candidate.path,
            };
          }),
      },
      mutationLock,
      prepareDirectories: () =>
        Effect.sync(() => {
          events.push("directories:prepare");
        }),
      schedulerFor,
      store,
      systemRoot: "C:\\Windows",
    }),
  );
  return { backend, events, fixture, lockScopes };
}

function orchestrationDependencies(events: string[], ready = true) {
  return {
    recovery: {
      recoverAuthorized: (authorization) =>
        Effect.sync(() => {
          events.push("runtime:recover-authorized");
          return { outcome: "absent", port: authorization.port };
        }),
      verifyAbsent: (received) =>
        Effect.sync(() => {
          events.push("runtime:verify-absent");
          return { outcome: "absent", port: received.port };
        }),
      verifyRunning: (authorization) =>
        Effect.sync(() => {
          events.push("runtime:verify-running");
          return ready
            ? {
                _tag: "Ready",
                instanceId: "11111111-1111-4111-8111-111111111111",
                owner: authorization.owner,
                ownerExecutablePath: authorization.executablePath,
                ownerVersion: descriptor.version,
                pid: 4242,
                port: authorization.port,
              }
            : {
                _tag: "NotReady",
                candidatePids: [],
                port: authorization.port,
                reason: "listener-absent",
              };
        }),
    },
    runtime: {
      status: () => Effect.succeed({ manifest: null, reachable: false }),
      stop: () =>
        Effect.sync(() => {
          events.push("runtime:stop");
          return false;
        }),
    },
  } satisfies { readonly recovery: WindowsRuntimeRecovery; readonly runtime: LocalRuntimeControl };
}

async function waitForEvent(
  events: ReadonlyArray<string>,
  event: string,
  deadline = Date.now() + 2_000,
): Promise<void> {
  if (events.includes(event)) return;
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${event}.`);
  await Bun.sleep(10);
  return waitForEvent(events, event, deadline);
}

describe("Windows service backend", () => {
  it("builds install-scoped artifacts and canonical supervised task bytes", () => {
    const plan = makeWindowsServiceInstallationPlan(descriptor, {
      legacyUser: { domain: "DOMAIN", username: "Test" },
      systemRoot: "C:\\Windows",
    });
    const fixture = receiptFixture();
    const paths = plan.artifactPaths(installId);

    expect(paths).toEqual({
      launcher: `${descriptor.configDir}\\server-control\\${installId}-run-daemon.vbs`,
      taskDefinition: `${descriptor.configDir}\\server-control\\${installId}-run-daemon.xml`,
      wrapper: `${descriptor.configDir}\\server-control\\${installId}-run-daemon.cmd`,
    });
    expect(plan.taskNamePrefix).toBe("SelfTuneDaemon");
    expect(plan.legacy?.taskName).toBe("SelfTuneDaemon");
    expect(plan.legacy?.runtimeIdentity).toEqual({
      configDir: descriptor.configDir,
      executablePath: descriptor.executablePath,
      owner: descriptor.owner,
      port: descriptor.port,
    });
    expect(plan.receipt.expectedArgvWithoutNonce[0]).toBe(descriptor.executableArgsPrefix[0]);
    expect(plan.receipt.expectedArgvWithoutNonce).not.toContain(descriptor.executablePath);
    expect(fixture.encodedTask.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xfe]));

    const wrapper = Buffer.from(fixture.rendered.wrapper).toString("utf8");
    const launcher = Buffer.from(fixture.rendered.launcher).toString("utf8");
    const taskXml = Buffer.from(fixture.encodedTask).toString("utf16le");
    expect(wrapper).toContain(`"--service-installation-nonce" "${nonce}"`);
    expect(launcher).toContain(fixture.receipt.artifacts.wrapper.path);
    expect(taskXml).toContain("C:\\Windows\\System32\\wscript.exe");
    expect(taskXml).toContain(fixture.receipt.artifacts.launcher.path);
    expect(taskXml).toContain(sid);
  });

  it("derives mutation authorization from the receipt despite desired descriptor drift", async () => {
    const { backend } = backendHarness();
    const replacement: ServiceDescriptor = {
      ...descriptor,
      executablePath: "C:\\Program Files\\SelfTune\\SelfTune.exe",
      owner: "cli",
      port: 7999,
    };

    const evidence = await Effect.runPromise(backend.inspectInstallation(replacement));
    const authorization = authorizationFromEvidence(
      evidence,
      makeWindowsServiceInstallationPlan(replacement, { systemRoot: "C:\\Windows" }),
    );

    expect(authorization).toMatchObject({
      _tag: "Owned",
      receipt: { installId },
      runtime: {
        _tag: "NonceBound",
        configDir: descriptor.configDir,
        executablePath: descriptor.executablePath,
        installationNonce: nonce,
        owner: descriptor.owner,
        port: descriptor.port,
      },
    });
  });

  it("maps owned, absent, and refused evidence into read-only status", async () => {
    const owned = backendHarness();
    await expect(Effect.runPromise(owned.backend.status(descriptor))).resolves.toEqual({
      detail: [],
      pid: null,
      platform: "win32",
      registered: true,
      running: true,
    });

    const absent = backendHarness({ receipt: null });
    await expect(Effect.runPromise(absent.backend.status(descriptor))).resolves.toMatchObject({
      detail: ["The SelfTune scheduled task is not installed."],
      registered: false,
      running: false,
    });

    const refused = backendHarness({ tamperWrapper: true });
    const refusedStatus = await Effect.runPromise(refused.backend.status(descriptor));
    expect(refusedStatus.registered).toBe(true);
    expect(refusedStatus.running).toBe(true);
    expect(refusedStatus.detail[0]).toContain("receipt-artifact-digest-mismatch");
    expect(refused.events.some((event) => event.startsWith("artifact:remove:"))).toBe(false);
  });

  it("diagnoses read-only scope and keeps stale repair authority inside the backend", async () => {
    const path = `${userServiceScope.controlDir}\\windows-service-mutation.lock`;
    const stale: WindowsServiceLockCompatibilityDiagnostic = {
      _tag: "LegacyStale",
      fileIdentity: "file-1",
      generation: "a".repeat(64),
      path,
      pid: 404,
      startedAt: "2026-07-16T11:00:00.000Z",
    };
    const test = backendHarness({ lockDiagnostic: stale });

    await expect(Effect.runPromise(test.backend.diagnoseMutationLock())).resolves.toEqual(stale);
    expect(test.events).toEqual(["user-service-control:resolve", "lock:diagnose:LegacyStale"]);

    test.events.length = 0;
    await expect(Effect.runPromise(test.backend.repairMutationLock())).resolves.toMatchObject({
      _tag: "FenceReady",
    });
    expect(test.events).toEqual([
      "user-service-control:prepare",
      "lock:diagnose:LegacyStale",
      `lock:repair:${stale.generation}`,
      "lock:diagnose:FenceReady",
    ]);
  });

  it("fails when stale repair does not read back the exact fence", async () => {
    const stale: WindowsServiceLockCompatibilityDiagnostic = {
      _tag: "LegacyStale",
      fileIdentity: "file-1",
      generation: "a".repeat(64),
      path: `${userServiceScope.controlDir}\\windows-service-mutation.lock`,
      pid: 404,
      startedAt: "2026-07-16T11:00:00.000Z",
    };
    const test = backendHarness({ lockDiagnostic: stale, lockRepairProducesFence: false });

    await expect(Effect.runPromise(test.backend.repairMutationLock())).rejects.toMatchObject({
      operation: "verify-windows-service-lock-repair",
    });
  });

  it("runs lifecycle mutations only after controller ownership proof", async () => {
    const { backend, events } = backendHarness();

    await Effect.runPromise(backend.stop(descriptor));

    const end = events.indexOf("task:end");
    expect(end).toBeGreaterThan(events.indexOf("receipt:read"));
    expect(end).toBeGreaterThan(events.indexOf("task:definition"));
    expect(events.slice(0, end).some((event) => event.startsWith("artifact:read:"))).toBe(true);
  });

  it("acquires the user-service lease before preparing target-config directories", async () => {
    const { backend, events } = backendHarness();

    await Effect.runPromise(
      backend.withMutationLock(
        descriptor,
        Effect.sync(() => {
          events.push("use");
        }),
      ),
    );

    expect(events).toEqual([
      "user-service-control:prepare",
      "lock:acquire",
      "directories:prepare",
      "server-control:prepare",
      "use",
      "lock:release",
    ]);
  });

  it("makes CLI and Desktop descriptors contend through the identical user-service scope", async () => {
    const { backend, events, lockScopes } = backendHarness();
    const cliDescriptor: ServiceDescriptor = {
      ...descriptor,
      configDir: "D:\\Portable\\selftune-state",
      owner: "cli",
      port: 7999,
    };

    await expect(
      Effect.runPromise(
        backend.withMutationLock(descriptor, backend.withMutationLock(cliDescriptor, Effect.void)),
      ),
    ).rejects.toThrow("lock already held");

    expect(lockScopes).toEqual([userServiceScope, userServiceScope]);
    expect(events.filter((event) => event === "directories:prepare")).toHaveLength(1);
    expect(events.filter((event) => event === "server-control:prepare")).toHaveLength(1);
    expect(events.at(-1)).toBe("lock:release");
  });

  it("holds the mutation lease from first inspection through readiness and final absence", async () => {
    const started = backendHarness();
    const startDependencies = orchestrationDependencies(started.events);
    const startedStatus = await Effect.runPromise(
      runWindowsServiceCommand(
        "start",
        descriptor,
        started.backend,
        startDependencies.runtime,
        startDependencies.recovery,
      ),
    );
    expect(started.events.indexOf("lock:acquire")).toBeLessThan(
      started.events.indexOf("receipt:read"),
    );
    expect(started.events.indexOf("lock:release")).toBeGreaterThan(
      started.events.lastIndexOf("runtime:verify-running"),
    );
    expect(startedStatus.pid).toBe(4242);

    const uninstalled = backendHarness();
    const uninstallDependencies = orchestrationDependencies(uninstalled.events);
    const uninstalledStatus = await Effect.runPromise(
      runWindowsServiceCommand(
        "uninstall",
        descriptor,
        uninstalled.backend,
        uninstallDependencies.runtime,
        uninstallDependencies.recovery,
      ),
    );
    expect(uninstalled.events.at(-1)).toBe("lock:release");
    expect(uninstalled.events.lastIndexOf("runtime:verify-absent")).toBeLessThan(
      uninstalled.events.lastIndexOf("lock:release"),
    );
    expect(uninstalledStatus).toMatchObject({ registered: false, running: false });
  });

  it("releases the mutation lease when ownership proof fails", async () => {
    const { backend, events } = backendHarness({ tamperWrapper: true });
    const dependencies = orchestrationDependencies(events);

    await expect(
      Effect.runPromise(
        runWindowsServiceCommand(
          "start",
          descriptor,
          backend,
          dependencies.runtime,
          dependencies.recovery,
        ),
      ),
    ).rejects.toThrow("ownership refused");
    expect(events.at(-1)).toBe("lock:release");
  });

  it("releases the mutation lease when readiness polling is interrupted", async () => {
    const { backend, events } = backendHarness();
    const dependencies = orchestrationDependencies(events, false);
    const controller = new AbortController();
    const running = Effect.runPromise(
      runWindowsServiceCommand(
        "start",
        descriptor,
        backend,
        dependencies.runtime,
        dependencies.recovery,
      ),
      { signal: controller.signal },
    );

    await waitForEvent(events, "runtime:verify-running");
    controller.abort();
    await running.catch(() => undefined);
    expect(events.at(-1)).toBe("lock:release");
  });

  it("does not inspect or mutate runtime state when lock acquisition fails", async () => {
    const { backend, events } = backendHarness({ lockAcquisitionFails: true });
    const dependencies = orchestrationDependencies(events);

    await expect(
      Effect.runPromise(
        runWindowsServiceCommand(
          "uninstall",
          descriptor,
          backend,
          dependencies.runtime,
          dependencies.recovery,
        ),
      ),
    ).rejects.toThrow("lock already held");
    expect(events).toEqual(["user-service-control:prepare", "lock:acquire-failed"]);
  });
});
