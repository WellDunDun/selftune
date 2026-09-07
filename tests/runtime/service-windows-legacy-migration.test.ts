import { serviceFromLayer } from "../helpers/service-layer";
import { WindowsInstallationController } from "@selftune/local/service/windows/installation/controller";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";

import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import {
  authorizationFromEvidence,
  makeWindowsServiceInstallationPlan,
} from "@selftune/local/service/windows/backend";
import type {
  LocalRuntimeControl,
  ServiceDescriptor,
  WindowsRuntimeRecovery,
  WindowsServiceBackend,
} from "@selftune/local/service-contract";
import {
  generateLegacyWindowsTaskXml,
  generateWindowsHiddenLauncher,
  matchesLegacyWindowsDaemonWrapper,
} from "@selftune/local/service/windows/installation/definition";
import {
  makeWindowsInstallationControllerLayer,
  type WindowsServiceInstallationArtifactStore,
} from "@selftune/local/service/windows/installation/controller";
import {
  matchLegacyWindowsServiceTaskDefinition,
  matchWindowsServiceTaskDefinition,
} from "@selftune/local/service/windows/installation/evidence";
import {
  createWindowsServiceInstallationReceipt,
  sha256Hex,
} from "@selftune/local/service/windows/installation/model";
import type { WindowsServiceInstallationStoreWithLegacyCleanup } from "@selftune/local/service/windows/installation/store";
import type { WindowsTaskScheduler } from "@selftune/local/service/windows/scheduler";
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
const legacyPath = "C:\\Legacy Bun\\bin;C:\\Windows\\System32";
const legacyUser = { domain: "DOMAIN", username: "Ada" } as const;
const sid = "S-1-5-21-1000-2000-3000-4000";
const controlDir = `${descriptor.configDir}\\server-control`;
const legacyPaths = {
  launcher: `${controlDir}\\run-daemon.vbs`,
  taskDefinition: `${controlDir}\\run-daemon.xml`,
  wrapper: `${controlDir}\\run-daemon.cmd`,
};
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";

// Literal snapshots of origin/main's fixed-name Windows generators.
const historicalWrapper = [
  "@echo off",
  `set "PATH=${legacyPath}"`,
  `set "SELFTUNE_CONFIG_DIR=${descriptor.configDir}"`,
  'set "SELFTUNE_DESKTOP=0"',
  'set "SELFTUNE_RUNTIME_OWNER=desktop"',
  'set "SELFTUNE_SUPERVISED=1"',
  'set "SELFTUNE_VERSION=0.2.33"',
  'set "SELFTUNE_SERVICE_VERSION=0.2.33"',
  `set "SELFTUNE_BIN_PATH=${descriptor.executablePath}"`,
  `"${descriptor.executablePath}" "C:\\SelfTune\\selftune.ts" "daemon" "run" "--foreground" "--supervised" "--owner" "desktop" "--port" "7888" "--hostname" "127.0.0.1" "--runtime-mode" "standalone" 1>> "${descriptor.configDir}\\logs\\daemon.log" 2>> "${descriptor.configDir}\\logs\\daemon.error.log"`,
  "",
].join("\r\n");

const historicalLauncher = [
  'Set sh = CreateObject("WScript.Shell")',
  `rc = sh.Run("""${legacyPaths.wrapper}""", 0, True)`,
  "WScript.Quit rc",
  "",
].join("\r\n");

const historicalTaskXml = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  "  <RegistrationInfo><Description>SelfTune supervised local service</Description></RegistrationInfo>",
  "  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>DOMAIN\\Ada</UserId></LogonTrigger></Triggers>",
  '  <Principals><Principal id="Author"><UserId>DOMAIN\\Ada</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
  "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>",
  `  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>&quot;${legacyPaths.launcher}&quot;</Arguments></Exec></Actions>`,
  "</Task>",
  "",
].join("\r\n");

const normalizedLegacyTaskXml = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  `  <Triggers><LogonTrigger><UserId>${sid}</UserId><Enabled>true</Enabled></LogonTrigger></Triggers>`,
  `  <Principals><Principal id="Author"><RunLevel>LeastPrivilege</RunLevel><LogonType>InteractiveToken</LogonType><UserId>${sid}</UserId></Principal></Principals>`,
  "  <Settings><Priority>7</Priority><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Count>3</Count><Interval>PT1M</Interval></RestartOnFailure><RunOnlyIfIdle>false</RunOnlyIfIdle><Hidden>false</Hidden><Enabled>true</Enabled><AllowStartOnDemand>true</AllowStartOnDemand><IdleSettings><RestartOnIdle>false</RestartOnIdle><StopOnIdleEnd>true</StopOnIdleEnd></IdleSettings><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><StartWhenAvailable>true</StartWhenAvailable><AllowHardTerminate>true</AllowHardTerminate><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>",
  `  <Actions Context="Author"><Exec><Arguments>&quot;${legacyPaths.launcher}&quot;</Arguments><Command>wscript.exe</Command></Exec></Actions>`,
  "</Task>",
  "",
].join("\r\n");

const historicalBytes = {
  launcher: Buffer.from(historicalLauncher, "utf8"),
  taskDefinition: Buffer.from(`\ufeff${historicalTaskXml}`, "utf16le"),
  wrapper: Buffer.from(historicalWrapper, "utf8"),
};

interface LegacyHarnessOptions {
  readonly planDescriptor?: ServiceDescriptor;
  readonly registeredDefinition?: string;
  readonly tamper?: "launcher" | "taskDefinition" | "wrapper";
  readonly wrapper?: string;
}

function legacyHarness(options: LegacyHarnessOptions = {}) {
  const planDescriptor = options.planDescriptor ?? descriptor;
  const plan = makeWindowsServiceInstallationPlan(planDescriptor, {
    legacyUser,
    systemRoot: "C:\\Windows",
  });
  const legacy = plan.legacy;
  if (legacy === undefined) throw new Error("Expected an explicit legacy migration plan.");
  const files = new Map<string, Uint8Array>([
    [
      legacyPaths.wrapper,
      options.wrapper === undefined
        ? historicalBytes.wrapper
        : Buffer.from(options.wrapper, "utf8"),
    ],
    [legacyPaths.launcher, historicalBytes.launcher],
    [legacyPaths.taskDefinition, historicalBytes.taskDefinition],
  ]);
  if (options.tamper !== undefined) {
    files.set(legacyPaths[options.tamper], Buffer.from("foreign", "utf8"));
  }
  const artifacts: WindowsServiceInstallationArtifactStore = {
    read: (path) => Effect.succeed(files.get(path) ?? null),
    removeMatching: () => Effect.void,
    write: () => Effect.void,
  };
  const schedulerFor = (taskName: string): WindowsTaskScheduler<never> => ({
    create: () => Effect.void,
    createExclusive: () => Effect.void,
    delete: () => Effect.void,
    end: () => Effect.void,
    listTaskNames: () => Effect.succeed([]),
    query: () =>
      Effect.succeed({
        registered: taskName === "SelfTuneDaemon",
        running: taskName === "SelfTuneDaemon",
      }),
    readDefinition: () =>
      Effect.succeed(
        taskName === "SelfTuneDaemon"
          ? (options.registeredDefinition ?? normalizedLegacyTaskXml)
          : null,
      ),
    start: () => Effect.void,
  });
  const store: WindowsServiceInstallationStoreWithLegacyCleanup = {
    createLegacyCleanup: () => Effect.die("unused createLegacyCleanup"),
    createReceipt: () => Effect.die("unused createReceipt"),
    persistReceipt: () => Effect.die("unused persistReceipt"),
    prepareServerControl: () => Effect.die("unused prepareServerControl"),
    readLegacyCleanup: () => Effect.succeed(null),
    readReceipt: () => Effect.succeed(null),
    removeLegacyCleanup: () => Effect.die("unused removeLegacyCleanup"),
    removeReceiptAfterCleanup: (_configDir, _expected, cleanup) => cleanup,
    requireLegacyCleanup: () => Effect.die("unused requireLegacyCleanup"),
    resolveCurrentUserSid: () => Effect.succeed(sid),
    writeReceipt: () => Effect.die("unused writeReceipt"),
  };
  return {
    controller: serviceFromLayer(
      WindowsInstallationController,
      makeWindowsInstallationControllerLayer({ artifacts, schedulerFor, store }),
    ),
    legacy,
    plan,
  };
}

type RecoveryMode = "absent" | "nonce-bearing-refused";

function orchestrationHarness(
  initial: "legacy" | "refused" = "legacy",
  recoveryMode: RecoveryMode = "absent",
) {
  const plan = makeWindowsServiceInstallationPlan(descriptor, {
    legacyUser,
    systemRoot: "C:\\Windows",
  });
  const legacy = plan.legacy;
  if (legacy?.runtimeIdentity === undefined) throw new Error("Expected exact legacy identity.");
  const receipt = createWindowsServiceInstallationReceipt({
    artifacts: legacy.artifacts,
    boot: descriptor.boot,
    configDir: descriptor.configDir,
    executableArgsPrefix: descriptor.executableArgsPrefix,
    executablePath: descriptor.executablePath,
    expectedArgv: [...plan.receipt.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
    installId: "10101010-1010-4010-9010-101010101010",
    installedAt: "2026-07-17T12:00:00.000Z",
    nonce,
    owner: descriptor.owner,
    port: descriptor.port,
    taskName: "SelfTuneDaemon-10101010-1010-4010-9010-101010101010",
    userSid: sid,
  });
  const events: string[] = [];
  let state: "absent" | "legacy" | "legacy-stopped" | "owned" | "refused" = initial;
  let legacyResourcesPresent = true;
  const inspect = () =>
    Effect.sync(() => {
      events.push("inspect");
      if (state === "refused") {
        return {
          _tag: "Refused" as const,
          currentUserSid: sid,
          reason: "legacy-artifact-digest-mismatch",
          task: { registered: true, running: true },
        };
      }
      if (state === "absent") {
        return {
          _tag: "Absent" as const,
          currentUserSid: sid,
          task: { registered: false, running: false },
        };
      }
      if (state === "owned") {
        return {
          _tag: "Owned" as const,
          currentUserSid: sid,
          receipt,
          task: { registered: true, running: true },
        };
      }
      return {
        _tag: "LegacyCompatible" as const,
        artifacts: legacy.artifacts,
        currentUserSid: sid,
        runtimeIdentity: legacy.runtimeIdentity,
        task: { registered: true, running: state === "legacy" },
      };
    });
  const backend: WindowsServiceBackend = {
    automated: true,
    diagnoseMutationLock: () => Effect.die("unexpected lock diagnosis"),
    inspectInstallation: inspect,
    install: () =>
      Effect.sync(() => {
        events.push("install");
        legacyResourcesPresent = false;
        state = "owned";
      }),
    platform: "win32",
    repairMutationLock: () => Effect.die("unexpected lock repair"),
    restart: () => Effect.die("unexpected restart"),
    start: () => Effect.die("unexpected start"),
    status: () => Effect.die("unexpected status"),
    stop: () =>
      Effect.sync(() => {
        events.push("stop");
        state = "legacy-stopped";
      }),
    uninstall: () =>
      Effect.sync(() => {
        events.push("uninstall");
        legacyResourcesPresent = false;
        state = "absent";
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
        return recoveryMode === "nonce-bearing-refused"
          ? {
              candidatePids: [4242],
              outcome: "refused" as const,
              port: authorization.port,
              reason: "health-installation-nonce-mismatch" as const,
            }
          : { outcome: "absent" as const, port: authorization.port };
      }),
    verifyAbsent: () =>
      Effect.sync(() => {
        events.push("verify-absent");
        return { outcome: "absent" as const, port: descriptor.port };
      }),
    verifyRunning: (authorization) =>
      Effect.sync(() => {
        events.push(`verify-running:${authorization._tag}`);
        return {
          _tag: "Ready" as const,
          instanceId: "20202020-2020-4020-9020-202020202020",
          owner: authorization.owner,
          ownerExecutablePath: authorization.executablePath,
          ownerVersion: descriptor.version,
          pid: 4242,
          port: descriptor.port,
        };
      }),
  };
  return {
    backend,
    events,
    inspect,
    legacyResourcesPresent: () => legacyResourcesPresent,
    recovery,
    runtime,
  };
}

describe("Windows pre-receipt installation migration", () => {
  it("reconstructs origin/main fixed-name bytes without deriving the fixture", () => {
    const plan = makeWindowsServiceInstallationPlan(descriptor, {
      legacyUser,
      systemRoot: "C:\\Windows",
    });
    const legacy = plan.legacy;
    if (legacy === undefined) throw new Error("Expected legacy plan.");

    expect(matchesLegacyWindowsDaemonWrapper(historicalWrapper, descriptor)).toBe(true);
    expect(generateWindowsHiddenLauncher(legacyPaths.wrapper)).toBe(historicalLauncher);
    expect(
      generateLegacyWindowsTaskXml({
        boot: false,
        launcherPath: legacyPaths.launcher,
        userId: "DOMAIN\\Ada",
      }),
    ).toBe(historicalTaskXml);
    expect(legacy.artifacts).toEqual({
      launcher: { path: legacyPaths.launcher, sha256: sha256Hex(historicalBytes.launcher) },
      taskDefinition: {
        path: legacyPaths.taskDefinition,
        sha256: sha256Hex(historicalBytes.taskDefinition),
      },
      wrapper: expect.objectContaining({ path: legacyPaths.wrapper }),
    });
  });

  it("matches the historical scheduler profile without weakening modern proof", () => {
    const expectation = {
      boot: false,
      launcherPath: legacyPaths.launcher,
      userSid: sid,
      wscriptPath: "wscript.exe",
    };
    expect(matchLegacyWindowsServiceTaskDefinition(normalizedLegacyTaskXml, expectation)).toEqual({
      matches: true,
    });
    expect(
      matchLegacyWindowsServiceTaskDefinition(historicalTaskXml, {
        ...expectation,
        userSid: "DOMAIN\\Ada",
      }),
    ).toEqual({ matches: true });
    expect(matchWindowsServiceTaskDefinition(normalizedLegacyTaskXml, expectation).matches).toBe(
      false,
    );
    expect(
      matchLegacyWindowsServiceTaskDefinition(
        normalizedLegacyTaskXml.replace("<StopOnIdleEnd>true", "<StopOnIdleEnd>false"),
        expectation,
      ).matches,
    ).toBe(false);
  });

  it("recognizes only exact bytes and derives ExactLegacy from the same plan", async () => {
    const { controller, plan } = legacyHarness();
    const evidence = await Effect.runPromise(controller.inspect(plan));
    expect(evidence).toMatchObject({ _tag: "LegacyCompatible" });
    if (evidence._tag !== "LegacyCompatible") throw new Error("Expected legacy evidence.");
    expect(evidence.artifacts.wrapper.sha256).toBe(sha256Hex(historicalBytes.wrapper));
    assert(evidence.runtimeIdentity);
    expect(authorizationFromEvidence(evidence, plan)).toEqual({
      _tag: "Legacy",
      runtime: { _tag: "ExactLegacy", ...evidence.runtimeIdentity },
    });

    const driftedPlan = makeWindowsServiceInstallationPlan(
      { ...descriptor, executablePath: "C:\\Other\\selftune.exe" },
      { legacyUser, systemRoot: "C:\\Windows" },
    );
    expect(authorizationFromEvidence(evidence, driftedPlan)).toEqual({
      _tag: "Legacy",
      runtime: null,
    });
  });

  it("accepts bounded historical drift while refusing authority and grammar drift", async () => {
    await Promise.all(
      (["launcher", "taskDefinition", "wrapper"] as const).map((tamper) => {
        const test = legacyHarness({ tamper });
        return expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject(
          {
            _tag: "Refused",
            reason: "legacy-artifact-digest-mismatch",
          },
        );
      }),
    );
    await Promise.all(
      [
        historicalWrapper.replace(legacyPath, "C:\\Different\\bin"),
        historicalWrapper.replaceAll("0.2.33", "0.2.33+legacy.7"),
      ].map((wrapper) => {
        const compatible = legacyHarness({ wrapper });
        return expect(
          Effect.runPromise(compatible.controller.inspect(compatible.plan)),
        ).resolves.toMatchObject({ _tag: "LegacyCompatible" });
      }),
    );

    const driftCases: ReadonlyArray<LegacyHarnessOptions> = [
      { planDescriptor: { ...descriptor, port: 7999 } },
      { planDescriptor: { ...descriptor, owner: "cli" } },
      { planDescriptor: { ...descriptor, executablePath: "C:\\Other\\selftune.exe" } },
      {
        wrapper: historicalWrapper.replaceAll("0.2.33", "not-semver"),
      },
      {
        wrapper: historicalWrapper.replaceAll("0.2.33", "999.0.0"),
      },
      {
        wrapper: historicalWrapper.replace(legacyPath, "C:\\odd%path"),
      },
    ];
    await Promise.all(
      driftCases.map((options) => {
        const test = legacyHarness(options);
        return expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject(
          {
            _tag: "Refused",
            reason: "legacy-artifact-digest-mismatch",
          },
        );
      }),
    );
    const definitionDrift = legacyHarness({
      registeredDefinition: normalizedLegacyTaskXml.replace("wscript.exe", "powershell.exe"),
    });
    await expect(
      Effect.runPromise(definitionDrift.controller.inspect(definitionDrift.plan)),
    ).resolves.toMatchObject({ _tag: "Refused", reason: "legacy-task-definition-mismatch" });
  });

  it("migrates exact legacy state to an Owned nonce-backed service", async () => {
    const test = orchestrationHarness();
    await Effect.runPromise(
      runWindowsServiceCommand("install", descriptor, test.backend, test.runtime, test.recovery),
    );
    expect(test.events.indexOf("stop")).toBeLessThan(test.events.indexOf("recover:ExactLegacy"));
    expect(test.events.indexOf("recover:ExactLegacy")).toBeLessThan(test.events.indexOf("install"));
    expect(test.events).toContain("verify-running:NonceBound");
    await expect(Effect.runPromise(test.inspect())).resolves.toMatchObject({
      _tag: "Owned",
      receipt: { nonce },
    });
    expect(test.legacyResourcesPresent()).toBe(false);
  });

  it("uninstalls or stops only after exact legacy runtime recovery", async () => {
    const uninstall = orchestrationHarness();
    await Effect.runPromise(
      runWindowsServiceCommand(
        "uninstall",
        descriptor,
        uninstall.backend,
        uninstall.runtime,
        uninstall.recovery,
      ),
    );
    expect(uninstall.events.indexOf("recover:ExactLegacy")).toBeLessThan(
      uninstall.events.indexOf("uninstall"),
    );
    expect(uninstall.events).toContain("verify-absent");
    expect(uninstall.legacyResourcesPresent()).toBe(false);

    const stop = orchestrationHarness();
    await Effect.runPromise(
      runWindowsServiceCommand("stop", descriptor, stop.backend, stop.runtime, stop.recovery),
    );
    expect(stop.events).toContain("recover:ExactLegacy");
    expect(stop.legacyResourcesPresent()).toBe(true);
  });

  it("rejects nonce-bearing runtime under ExactLegacy and preserves legacy resources", async () => {
    const test = orchestrationHarness("legacy", "nonce-bearing-refused");
    await expect(
      Effect.runPromise(
        runWindowsServiceCommand("install", descriptor, test.backend, test.runtime, test.recovery),
      ),
    ).rejects.toThrow("installation-nonce-mismatch");
    expect(test.events).toContain("recover:ExactLegacy");
    expect(test.events).not.toContain("install");
    expect(test.events).not.toContain("uninstall");
    expect(test.legacyResourcesPresent()).toBe(true);
  });

  it("does not mutate refused legacy state and requires deliberate migration before start", async () => {
    const refused = orchestrationHarness("refused");
    await expect(
      Effect.runPromise(
        runWindowsServiceCommand(
          "uninstall",
          descriptor,
          refused.backend,
          refused.runtime,
          refused.recovery,
        ),
      ),
    ).rejects.toThrow("ownership refused");
    expect(refused.events).toEqual(["inspect"]);

    await Promise.all(
      (["start", "restart"] as const).map(async (action) => {
        const legacy = orchestrationHarness();
        await expect(
          Effect.runPromise(
            runWindowsServiceCommand(
              action,
              descriptor,
              legacy.backend,
              legacy.runtime,
              legacy.recovery,
            ),
          ),
        ).rejects.toThrow("must be migrated with install first");
        expect(legacy.events).toEqual(["inspect"]);
        expect(legacy.legacyResourcesPresent()).toBe(true);
      }),
    );
  });
});
