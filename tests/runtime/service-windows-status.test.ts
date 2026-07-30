import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ServiceDescriptor,
  WindowsRuntimeRecovery,
  WindowsServiceBackend,
} from "@selftune/local/service-contract";
import { ServiceManager } from "@selftune/local/service-contract";
import { runServiceCommand } from "@selftune/local/service";
import { makeWindowsServiceInstallationPlan } from "@selftune/local/service/windows/backend";
import type { WindowsServiceInstallationEvidence } from "@selftune/local/service/windows/installation/contract";
import {
  createWindowsServiceInstallationReceipt,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import {
  createWindowsServiceLegacyCleanupJournal,
  type WindowsServiceLegacyCleanupJournal,
} from "@selftune/local/service/windows/installation/legacy-cleanup";
import type {
  WindowsRuntimeAuthorization,
  WindowsRuntimeReadiness,
} from "@selftune/local/service/windows/runtime/contract";
import { observeWindowsServiceStatus } from "@selftune/local/service/windows/status";

const descriptor: ServiceDescriptor = {
  boot: false,
  configDir: "C:\\Users\\Ada\\.selftune",
  executableArgsPrefix: ["C:\\SelfTune\\selftune.ts"],
  executablePath: "C:\\Program Files\\Bun\\bun.exe",
  owner: "desktop",
  port: 7888,
  version: "1.4.0",
};
const sid = "S-1-5-21-1000-2000-3000-4000";
const firstInstallId = "10101010-1010-4010-9010-101010101010";
const secondInstallId = "20202020-2020-4020-9020-202020202020";
const firstNonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";
const secondNonce = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg_0987654321";

function receipt(
  installId = firstInstallId,
  nonce = firstNonce,
): WindowsServiceInstallationReceipt {
  const plan = makeWindowsServiceInstallationPlan(descriptor, { systemRoot: "C:\\Windows" });
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
    expectedArgv: [...plan.receipt.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
    installId,
    installedAt: "2026-07-17T10:00:00.000Z",
    nonce,
    owner: plan.receipt.owner,
    port: plan.receipt.port,
    taskName: `${plan.taskNamePrefix}-${installId}`,
    userSid: sid,
  });
}

function owned(
  installationReceipt = receipt(),
  running = true,
): WindowsServiceInstallationEvidence {
  return {
    _tag: "Owned",
    currentUserSid: sid,
    receipt: installationReceipt,
    task: { registered: true, running },
  };
}

function cleanupJournal(
  initiatedBy: "install" | "uninstall" = "install",
): WindowsServiceLegacyCleanupJournal {
  const controlDir = `${descriptor.configDir}\\server-control`;
  return createWindowsServiceLegacyCleanupJournal(
    {
      artifacts: {
        launcher: { path: `${controlDir}\\run-daemon.vbs`, sha256: "1".repeat(64) },
        taskDefinition: { path: `${controlDir}\\run-daemon.xml`, sha256: "2".repeat(64) },
        wrapper: { path: `${controlDir}\\run-daemon.cmd`, sha256: "3".repeat(64) },
      },
      boot: false,
      configDir: descriptor.configDir,
      initiatedBy,
      runtimeIdentity: {
        configDir: descriptor.configDir,
        executablePath: descriptor.executablePath,
        owner: descriptor.owner,
        port: descriptor.port,
      },
      taskName: "SelfTuneDaemon",
      userSid: sid,
      wscriptPath: "wscript.exe",
    },
    {
      cleanupId: "40404040-4040-4040-9040-404040404040",
      createdAt: "2026-07-17T10:00:00.000Z",
    },
  );
}

function pending(journal = cleanupJournal(), running = true): WindowsServiceInstallationEvidence {
  return {
    _tag: "LegacyCleanupPending",
    currentUserSid: sid,
    journal,
    task: { registered: true, running },
  };
}

const ready: WindowsRuntimeReadiness = {
  _tag: "Ready",
  instanceId: "30303030-3030-4030-9030-303030303030",
  owner: descriptor.owner,
  ownerExecutablePath: descriptor.executablePath,
  ownerVersion: descriptor.version,
  pid: 4242,
  port: descriptor.port,
};

function harness(
  observations: ReadonlyArray<WindowsServiceInstallationEvidence>,
  readiness: WindowsRuntimeReadiness = ready,
) {
  const events: string[] = [];
  const authorizations: WindowsRuntimeAuthorization[] = [];
  let observationIndex = 0;
  const inspectInstallation: WindowsServiceBackend["inspectInstallation"] = () =>
    Effect.sync(() => {
      events.push("inspect");
      const observation = observations[observationIndex];
      observationIndex += 1;
      if (observation === undefined) throw new Error("Unexpected Windows status inspection.");
      return observation;
    });
  const backend: WindowsServiceBackend = {
    automated: true,
    diagnoseMutationLock: () => Effect.die("unexpected lock diagnosis"),
    inspectInstallation,
    install: () => Effect.die("unexpected install"),
    platform: "win32",
    repairMutationLock: () => Effect.die("unexpected lock repair"),
    restart: () => Effect.die("unexpected restart"),
    start: () => Effect.die("unexpected start"),
    status: () => Effect.die("unexpected backend status"),
    stop: () => Effect.die("unexpected stop"),
    uninstall: () => Effect.die("unexpected uninstall"),
    withMutationLock: (_descriptor, use) => use,
  };
  const recovery: WindowsRuntimeRecovery = {
    recoverAuthorized: () => Effect.die("unexpected recovery"),
    verifyAbsent: () => Effect.die("unexpected absence verification"),
    verifyRunning: (authorization) =>
      Effect.sync(() => {
        events.push("verify-running");
        authorizations.push(authorization);
        return readiness;
      }),
  };
  return { authorizations, backend, events, recovery };
}

describe("generation-consistent Windows service status", () => {
  it("publishes authenticated runtime detail only between matching owned observations", async () => {
    const installation = owned();
    const test = harness([installation, installation]);

    const status = await Effect.runPromise(
      observeWindowsServiceStatus(descriptor, test.backend, test.recovery),
    );

    expect(test.events).toEqual(["inspect", "verify-running", "inspect"]);
    expect(test.authorizations).toEqual([
      {
        _tag: "NonceBound",
        configDir: installation.receipt.configDir,
        executablePath: installation.receipt.executablePath,
        installationNonce: installation.receipt.nonce,
        owner: installation.receipt.owner,
        port: installation.receipt.port,
      },
    ]);
    expect(status).toEqual({
      detail: ["Serving http://127.0.0.1:7888 (pid 4242, SelfTune 1.4.0, desktop-owned)."],
      pid: 4242,
      platform: "win32",
      registered: true,
      running: true,
    });
  });

  it("refuses every authoritative owned-generation change", async () => {
    const before = receipt();
    const changedReceiptCases = [
      receipt(secondInstallId),
      receipt(firstInstallId, secondNonce),
      createWindowsServiceInstallationReceipt({
        ...before,
        installedAt: "2026-07-17T10:00:01.000Z",
      }),
      createWindowsServiceInstallationReceipt({
        ...before,
        boot: true,
      }),
      createWindowsServiceInstallationReceipt({
        ...before,
        taskName: `${before.taskName}-replacement`,
      }),
      createWindowsServiceInstallationReceipt({
        ...before,
        userSid: "S-1-5-21-9999-8888-7777-6666",
      }),
      createWindowsServiceInstallationReceipt({
        ...before,
        artifacts: {
          ...before.artifacts,
          wrapper: { ...before.artifacts.wrapper, sha256: "4".repeat(64) },
        },
      }),
    ];

    await Promise.all(
      changedReceiptCases.map(async (changed) => {
        const test = harness([owned(before), owned(changed)]);
        await expect(
          Effect.runPromise(observeWindowsServiceStatus(descriptor, test.backend, test.recovery)),
        ).rejects.toThrow("changed during status observation");
      }),
    );
  });

  it("refuses running-state and evidence-kind changes after readiness", async () => {
    const installation = receipt();
    const cases: ReadonlyArray<WindowsServiceInstallationEvidence> = [
      owned(installation, false),
      {
        _tag: "OwnedIncomplete",
        currentUserSid: sid,
        receipt: installation,
        task: { registered: true, running: true },
      },
    ];

    await Promise.all(
      cases.map(async (after) => {
        const test = harness([owned(installation), after]);
        await expect(
          Effect.runPromise(observeWindowsServiceStatus(descriptor, test.backend, test.recovery)),
        ).rejects.toThrow("changed during status observation");
      }),
    );
  });

  it("reports stable but unauthenticated scheduled-task state without a pid", async () => {
    const installation = owned();
    const test = harness([installation, installation], {
      _tag: "NotReady",
      candidatePids: [],
      port: descriptor.port,
      reason: "listener-absent",
    });

    const status = await Effect.runPromise(
      observeWindowsServiceStatus(descriptor, test.backend, test.recovery),
    );

    expect(status.pid).toBeNull();
    expect(status.running).toBe(true);
    expect(status.detail).toEqual([
      "The SelfTune scheduled task is running, but its runtime is not authenticated (listener-absent).",
    ]);
  });

  it("reports a stable pending cleanup without authenticating its runtime", async () => {
    const evidence = pending();
    const test = harness([evidence, evidence]);

    const status = await Effect.runPromise(
      observeWindowsServiceStatus(descriptor, test.backend, test.recovery),
    );

    expect(test.events).toEqual(["inspect", "inspect"]);
    expect(test.authorizations).toHaveLength(0);
    expect(status).toEqual({
      detail: [
        "A verified legacy SelfTune cleanup is pending; run service install or service uninstall to finish it.",
      ],
      pid: null,
      platform: "win32",
      registered: true,
      running: true,
    });
  });

  it("refuses any full-journal change during pending cleanup observation", async () => {
    const before = cleanupJournal("install");
    const after = cleanupJournal("uninstall");
    const test = harness([pending(before), pending(after)]);

    await expect(
      Effect.runPromise(observeWindowsServiceStatus(descriptor, test.backend, test.recovery)),
    ).rejects.toThrow("changed during status observation");
    expect(test.events).toEqual(["inspect", "inspect"]);
  });

  it("sandwiches non-running and refused status without authenticating a runtime", async () => {
    const stopped = owned(receipt(), false);
    const refused: WindowsServiceInstallationEvidence = {
      _tag: "Refused",
      currentUserSid: sid,
      reason: "foreign-task",
      task: { registered: true, running: false },
    };

    await Promise.all(
      [stopped, refused].map(async (evidence) => {
        const test = harness([evidence, evidence]);
        const status = await Effect.runPromise(
          observeWindowsServiceStatus(descriptor, test.backend, test.recovery),
        );
        expect(test.events).toEqual(["inspect", "inspect"]);
        expect(test.authorizations).toHaveLength(0);
        expect(status.pid).toBeNull();
      }),
    );
  });

  it("does not consult the Windows runtime manifest after authenticated observation", async () => {
    const installation = owned();
    const test = harness([installation, installation]);
    const layer = Layer.succeed(ServiceManager)({
      backend: test.backend,
      runtime: {
        status: () => Effect.die("unexpected Windows runtime manifest read"),
        stop: () => Effect.die("unexpected Windows runtime stop"),
      },
      windowsRecovery: test.recovery,
    });

    const response = await Effect.runPromise(
      runServiceCommand("status", descriptor).pipe(Effect.provide(layer)),
    );

    expect(response.status.pid).toBe(ready.pid);
    expect(test.events).toEqual(["inspect", "verify-running", "inspect"]);
  });
});
