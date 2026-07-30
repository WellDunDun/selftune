import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import { makeWindowsServiceInstallationPlan } from "@selftune/local/service/windows/backend";
import type {
  LocalRuntimeControl,
  ServiceDescriptor,
  WindowsRuntimeRecovery,
  WindowsServiceBackend,
} from "@selftune/local/service-contract";
import type { WindowsServiceInstallationEvidence } from "@selftune/local/service/windows/installation/contract";
import { createWindowsServiceInstallationReceipt } from "@selftune/local/service/windows/installation/model";
import { createWindowsServiceLegacyCleanupJournal } from "@selftune/local/service/windows/installation/legacy-cleanup";
import { runWindowsServiceCommand } from "@selftune/local/service/windows/orchestration";

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
const installId = "10101010-1010-4010-9010-101010101010";
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";
const controlDir = `${descriptor.configDir}\\server-control`;
const journal = createWindowsServiceLegacyCleanupJournal(
  {
    artifacts: {
      launcher: { path: `${controlDir}\\run-daemon.vbs`, sha256: "1".repeat(64) },
      taskDefinition: { path: `${controlDir}\\run-daemon.xml`, sha256: "2".repeat(64) },
      wrapper: { path: `${controlDir}\\run-daemon.cmd`, sha256: "3".repeat(64) },
    },
    boot: descriptor.boot,
    configDir: descriptor.configDir,
    initiatedBy: "install",
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
    cleanupId: "20202020-2020-4020-9020-202020202020",
    createdAt: "2026-07-17T12:00:00.000Z",
  },
);
const driftedJournal = createWindowsServiceLegacyCleanupJournal(
  {
    artifacts: journal.artifacts,
    boot: journal.boot,
    configDir: journal.configDir,
    initiatedBy: "uninstall",
    runtimeIdentity: journal.runtimeIdentity,
    taskName: journal.taskName,
    userSid: journal.userSid,
    wscriptPath: journal.wscriptPath,
  },
  { cleanupId: journal.cleanupId, createdAt: journal.createdAt },
);

const plan = makeWindowsServiceInstallationPlan(descriptor, { systemRoot: "C:\\Windows" });
const receipt = createWindowsServiceInstallationReceipt({
  artifacts: {
    launcher: { path: plan.artifactPaths(installId).launcher, sha256: "4".repeat(64) },
    taskDefinition: {
      path: plan.artifactPaths(installId).taskDefinition,
      sha256: "5".repeat(64),
    },
    wrapper: { path: plan.artifactPaths(installId).wrapper, sha256: "6".repeat(64) },
  },
  boot: descriptor.boot,
  configDir: descriptor.configDir,
  executableArgsPrefix: descriptor.executableArgsPrefix,
  executablePath: descriptor.executablePath,
  expectedArgv: [...plan.receipt.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
  installId,
  installedAt: "2026-07-17T12:01:00.000Z",
  nonce,
  owner: descriptor.owner,
  port: descriptor.port,
  taskName: `SelfTuneDaemon-${installId}`,
  userSid: sid,
});

function pending(running: boolean, cleanupJournal = journal): WindowsServiceInstallationEvidence {
  return {
    _tag: "LegacyCleanupPending",
    currentUserSid: sid,
    journal: cleanupJournal,
    task: { registered: true, running },
  };
}

function harness(options: { readonly driftAfterStop?: boolean } = {}) {
  const events: string[] = [];
  const authorizations: string[] = [];
  let state: WindowsServiceInstallationEvidence = pending(true);
  const inspectInstallation: WindowsServiceBackend["inspectInstallation"] = () =>
    Effect.sync(() => {
      events.push(`inspect:${state._tag}`);
      return state;
    });
  const backend: WindowsServiceBackend = {
    automated: true,
    diagnoseMutationLock: () => Effect.die("unexpected lock diagnosis"),
    inspectInstallation,
    install: () =>
      Effect.sync(() => {
        events.push("install");
        state = {
          _tag: "Owned",
          currentUserSid: sid,
          receipt,
          task: { registered: true, running: true },
        };
      }),
    platform: "win32",
    repairMutationLock: () => Effect.die("unexpected lock repair"),
    restart: () => Effect.die("unexpected backend restart"),
    start: () => Effect.die("unexpected backend start"),
    status: () => Effect.die("unexpected backend status"),
    stop: () =>
      Effect.sync(() => {
        events.push("stop");
        state = pending(false, options.driftAfterStop === true ? driftedJournal : journal);
      }),
    uninstall: () =>
      Effect.sync(() => {
        events.push("uninstall");
        state = {
          _tag: "Absent",
          currentUserSid: sid,
          task: { registered: false, running: false },
        };
      }),
    withMutationLock: (_descriptor, use) => use,
  };
  const runtime: LocalRuntimeControl = {
    status: () => Effect.die("unexpected runtime status"),
    stop: () => Effect.die("unexpected descriptor-only stop"),
  };
  const recovery: WindowsRuntimeRecovery = {
    recoverAuthorized: (authorization) =>
      Effect.sync(() => {
        events.push(`recover:${authorization._tag}`);
        authorizations.push(JSON.stringify(authorization));
        return { outcome: "absent", port: authorization.port };
      }),
    verifyAbsent: (target) =>
      Effect.sync(() => {
        events.push(`verify-absent:${target.configDir}:${target.port}`);
        return { outcome: "absent", port: target.port };
      }),
    verifyRunning: (authorization) =>
      Effect.sync(() => {
        events.push(`verify-running:${authorization._tag}`);
        return {
          _tag: "Ready",
          instanceId: "30303030-3030-4030-9030-303030303030",
          owner: authorization.owner,
          ownerExecutablePath: authorization.executablePath,
          ownerVersion: descriptor.version,
          pid: 4242,
          port: authorization.port,
        };
      }),
  };
  return { authorizations, backend, events, recovery, runtime, state: () => state };
}

describe("Windows pending legacy cleanup orchestration", () => {
  it("recovers ExactLegacy before install and publishes the new Owned generation", async () => {
    const test = harness();

    const response = await Effect.runPromise(
      runWindowsServiceCommand("install", descriptor, test.backend, test.runtime, test.recovery),
    );

    expect(test.events.indexOf("stop")).toBeLessThan(test.events.indexOf("recover:ExactLegacy"));
    expect(test.events.indexOf("recover:ExactLegacy")).toBeLessThan(test.events.indexOf("install"));
    expect(test.events).toContain("verify-running:NonceBound");
    expect(test.authorizations).toEqual([
      JSON.stringify({ _tag: "ExactLegacy", ...journal.runtimeIdentity }),
    ]);
    expect(test.state()).toMatchObject({ _tag: "Owned", receipt: { installId, nonce } });
    expect(response.pid).toBe(4242);
  });

  it("recovers ExactLegacy before uninstall and ends absent", async () => {
    const test = harness();

    const response = await Effect.runPromise(
      runWindowsServiceCommand("uninstall", descriptor, test.backend, test.runtime, test.recovery),
    );

    expect(test.events.indexOf("recover:ExactLegacy")).toBeLessThan(
      test.events.indexOf("uninstall"),
    );
    expect(test.state()).toMatchObject({ _tag: "Absent" });
    expect(response).toMatchObject({ registered: false, running: false });
  });

  it("stops and recovers the runtime while preserving pending cleanup authority", async () => {
    const test = harness();

    const response = await Effect.runPromise(
      runWindowsServiceCommand("stop", descriptor, test.backend, test.runtime, test.recovery),
    );

    expect(test.events).toContain("recover:ExactLegacy");
    expect(test.events).not.toContain("install");
    expect(test.events).not.toContain("uninstall");
    expect(test.state()).toEqual(pending(false));
    expect(response).toMatchObject({ registered: true, running: false });
    expect(response.detail.join(" ")).toContain("cleanup is pending");
  });

  it("refuses full-journal drift before runtime recovery or installation mutation", async () => {
    const test = harness({ driftAfterStop: true });

    await expect(
      Effect.runPromise(
        runWindowsServiceCommand("install", descriptor, test.backend, test.runtime, test.recovery),
      ),
    ).rejects.toThrow("pending Windows cleanup changed before recovery");
    expect(test.events).toEqual([
      "inspect:LegacyCleanupPending",
      "stop",
      "inspect:LegacyCleanupPending",
    ]);
    expect(test.authorizations).toHaveLength(0);
    expect(test.events).not.toContain("install");
    expect(test.events).not.toContain("uninstall");
  });

  it("refuses start and restart without stopping or recovering", async () => {
    const actions: ReadonlyArray<"start" | "restart"> = ["start", "restart"];
    await Promise.all(
      actions.map(async (action) => {
        const test = harness();
        await expect(
          Effect.runPromise(
            runWindowsServiceCommand(action, descriptor, test.backend, test.runtime, test.recovery),
          ),
        ).rejects.toThrow("cleanup is pending");
        expect(test.events).toEqual(["inspect:LegacyCleanupPending"]);
        expect(test.authorizations).toHaveLength(0);
        expect(test.state()).toEqual(pending(true));
      }),
    );
  });
});
