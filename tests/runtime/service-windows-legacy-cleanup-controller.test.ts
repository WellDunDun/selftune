import { serviceFromLayer } from "../helpers/service-layer";
import { WindowsInstallationController } from "@selftune/local/service/windows/installation/controller";
import { Buffer } from "node:buffer";

import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import {
  generateLegacyWindowsTaskXml,
  generateWindowsTaskXml,
} from "@selftune/local/service/windows/installation/definition";
import {
  makeWindowsInstallationControllerLayer,
  type WindowsServiceInstallationPlan,
} from "@selftune/local/service/windows/installation/controller";
import {
  createWindowsServiceInstallationReceipt,
  sha256Hex,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import type { WindowsServiceInstallationStoreWithLegacyCleanup } from "@selftune/local/service/windows/installation/store";
import { WindowsServiceInstallationStoreError } from "@selftune/local/service/windows/installation/store";
import { makeWindowsServiceLegacyCleanupController } from "@selftune/local/service/windows/installation/legacy-cleanup-controller";
import {
  createWindowsServiceLegacyCleanupJournal,
  matchesWindowsServiceLegacyCleanupExpectation,
  type WindowsServiceLegacyCleanupJournal,
  type WindowsServiceLegacyCleanupJournalInput,
} from "@selftune/local/service/windows/installation/legacy-cleanup";
import type { WindowsTaskScheduler } from "@selftune/local/service/windows/scheduler";

const configDir = "C:\\Users\\Test\\.selftune";
const controlDir = `${configDir}\\server-control`;
const sid = "S-1-5-21-1000-2000-3000-4000";
const paths = {
  launcher: `${controlDir}\\run-daemon.vbs`,
  taskDefinition: `${controlDir}\\run-daemon.xml`,
  wrapper: `${controlDir}\\run-daemon.cmd`,
};
const contents = {
  launcher: Buffer.from("legacy-launcher", "utf8"),
  taskDefinition: Buffer.from("legacy-task-definition", "utf8"),
  wrapper: Buffer.from("legacy-wrapper", "utf8"),
};
const input: WindowsServiceLegacyCleanupJournalInput = {
  artifacts: {
    launcher: { path: paths.launcher, sha256: sha256Hex(contents.launcher) },
    taskDefinition: {
      path: paths.taskDefinition,
      sha256: sha256Hex(contents.taskDefinition),
    },
    wrapper: { path: paths.wrapper, sha256: sha256Hex(contents.wrapper) },
  },
  boot: false,
  configDir,
  initiatedBy: "install",
  runtimeIdentity: {
    configDir,
    executablePath: "C:\\Program Files\\Bun\\bun.exe",
    owner: "desktop",
    port: 7888,
  },
  taskName: "SelfTuneDaemon",
  userSid: sid,
  wscriptPath: "wscript.exe",
};
const metadata = {
  cleanupId: "10101010-1010-4010-9010-101010101010",
  createdAt: "2026-07-17T12:30:00.000Z",
};
const modernInstallId = "20202020-2020-4020-9020-202020202020";
const modernNonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";
const modernWscript = "C:\\Windows\\System32\\wscript.exe";
const expectedArgvWithoutNonce = [
  "C:\\SelfTune\\selftune.ts",
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
];

type FailurePoint = "artifact" | "delete" | "end" | "journal-remove";

interface HarnessOptions {
  readonly artifactFailurePath?: string;
  readonly failure?: FailurePoint;
  readonly files?: ReadonlyArray<"launcher" | "taskDefinition" | "wrapper">;
  readonly journal?: WindowsServiceLegacyCleanupJournal;
  readonly replacementDuringArtifactRemovalPath?: string;
  readonly taskDefinition?: string;
  readonly taskRegistered?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const files = new Map<string, Uint8Array>();
  for (const key of options.files ?? ["launcher", "taskDefinition", "wrapper"]) {
    files.set(paths[key], contents[key]);
  }
  let failure = options.failure;
  let artifactFailurePath = options.artifactFailurePath;
  let journal = options.journal ?? null;
  let registered = options.taskRegistered ?? true;
  let running = registered;
  let definition =
    options.taskDefinition ??
    generateLegacyWindowsTaskXml({
      boot: false,
      launcherPath: paths.launcher,
      userId: sid,
    });

  const store: WindowsServiceInstallationStoreWithLegacyCleanup = {
    createLegacyCleanup: (creation) =>
      Effect.try({
        try: () => {
          events.push("journal:create");
          if (journal !== null) throw new Error("journal already exists");
          journal = createWindowsServiceLegacyCleanupJournal(creation, metadata);
          return journal;
        },
        catch: (cause) =>
          new WindowsServiceInstallationStoreError({
            operation: "create cleanup journal",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    createReceipt: () => Effect.die("unused createReceipt"),
    persistReceipt: () => Effect.die("unused persistReceipt"),
    prepareServerControl: () => Effect.die("unused prepareServerControl"),
    readLegacyCleanup: () =>
      Effect.sync(() => {
        events.push("journal:read");
        return journal;
      }),
    readReceipt: () => Effect.die("unused readReceipt"),
    removeLegacyCleanup: (_configDir, expectation) =>
      Effect.try({
        try: () => {
          events.push("journal:remove");
          if (failure === "journal-remove") throw new Error("journal removal failed");
          if (!matchesWindowsServiceLegacyCleanupExpectation(journal, expectation)) {
            throw new Error("journal generation changed");
          }
          journal = null;
        },
        catch: (cause) =>
          new WindowsServiceInstallationStoreError({
            operation: "remove cleanup journal",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    removeReceiptAfterCleanup: () => Effect.die("unused removeReceiptAfterCleanup"),
    requireLegacyCleanup: (_configDir, expectation) =>
      Effect.try({
        try: () => {
          events.push("journal:require");
          if (!matchesWindowsServiceLegacyCleanupExpectation(journal, expectation)) {
            throw new Error("journal generation changed");
          }
        },
        catch: (cause) =>
          new WindowsServiceInstallationStoreError({
            operation: "require cleanup journal",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    resolveCurrentUserSid: () => Effect.succeed(sid),
    writeReceipt: () => Effect.die("unused writeReceipt"),
  };
  const scheduler: WindowsTaskScheduler<unknown> = {
    create: () => Effect.die("unused create"),
    createExclusive: () => Effect.die("unused createExclusive"),
    delete: () =>
      Effect.try({
        try: () => {
          events.push("task:delete");
          if (failure === "delete") throw new Error("delete failed");
          registered = false;
          running = false;
        },
        catch: (cause) => cause,
      }),
    end: () =>
      Effect.try({
        try: () => {
          events.push("task:end");
          if (failure === "end") throw new Error("end failed");
          running = false;
        },
        catch: (cause) => cause,
      }),
    listTaskNames: () => Effect.succeed(registered ? ["SelfTuneDaemon"] : []),
    query: () => Effect.succeed({ registered, running }),
    readDefinition: () => Effect.succeed(registered ? definition : null),
    start: () => Effect.die("unused start"),
  };
  const controller = makeWindowsServiceLegacyCleanupController({
    artifacts: {
      read: (path) => Effect.succeed(files.get(path) ?? null),
      removeMatching: ({ artifact, generation }) =>
        Effect.try({
          try: () => {
            events.push(`artifact:remove:${artifact.path}`);
            if (generation !== metadata.cleanupId) throw new Error("cleanup generation mismatch");
            if (failure === "artifact" && artifact.path === artifactFailurePath) {
              throw new Error("artifact removal failed");
            }
            files.delete(artifact.path);
            if (artifact.path === options.replacementDuringArtifactRemovalPath) {
              files.set(artifact.path, Buffer.from("foreign-replacement", "utf8"));
              throw new Error("artifact changed during quarantine removal");
            }
          },
          catch: (cause) => cause,
        }),
    },
    schedulerFor: () => scheduler,
    store,
  });
  return {
    controller,
    events,
    files,
    journal: () => journal,
    mutateJournal: () => {
      if (journal === null) throw new Error("journal missing");
      journal = createWindowsServiceLegacyCleanupJournal(
        { ...input, initiatedBy: "uninstall" },
        metadata,
      );
    },
    setArtifactFailure: (path?: string) => {
      artifactFailurePath = path;
      failure = path === undefined ? undefined : "artifact";
    },
    setDefinition: (value: string) => {
      definition = value;
    },
    setFailure: (value?: FailurePoint) => {
      failure = value;
    },
  };
}

function installationHarness(initial: "absent" | "legacy" | "pending") {
  const events: string[] = [];
  const files = new Map<string, Uint8Array>([
    [paths.launcher, contents.launcher],
    [paths.taskDefinition, contents.taskDefinition],
    [paths.wrapper, contents.wrapper],
  ]);
  const tasks = new Map<string, { definition: string; registered: boolean; running: boolean }>();
  if (initial !== "absent") {
    tasks.set("SelfTuneDaemon", {
      definition: generateLegacyWindowsTaskXml({
        boot: false,
        launcherPath: paths.launcher,
        userId: sid,
      }),
      registered: true,
      running: true,
    });
  }
  let journal: WindowsServiceLegacyCleanupJournal | null =
    initial === "pending" ? createWindowsServiceLegacyCleanupJournal(input, metadata) : null;
  let receipt: WindowsServiceInstallationReceipt | null = null;
  const plan: WindowsServiceInstallationPlan = {
    artifactPaths: (installId) => ({
      launcher: `${controlDir}\\${installId}-run-daemon.vbs`,
      taskDefinition: `${controlDir}\\${installId}-run-daemon.xml`,
      wrapper: `${controlDir}\\${installId}-run-daemon.cmd`,
    }),
    encodeTaskDefinition: (xml) => Buffer.from(xml, "utf8"),
    legacy: {
      artifacts: input.artifacts,
      boot: false,
      runtimeIdentity: input.runtimeIdentity,
      taskName: "SelfTuneDaemon",
      wscriptPath: "wscript.exe",
    },
    receipt: {
      boot: false,
      configDir,
      executableArgsPrefix: ["C:\\SelfTune\\selftune.ts"],
      executablePath: input.runtimeIdentity.executablePath,
      expectedArgvWithoutNonce,
      owner: "desktop",
      port: 7888,
    },
    renderArtifacts: (next) => ({
      launcher: Buffer.from("modern-launcher", "utf8"),
      taskDefinitionXml: generateWindowsTaskXml({
        boot: false,
        commandPath: modernWscript,
        launcherPath: next.artifacts.launcher.path,
        userId: sid,
      }),
      wrapper: Buffer.from("modern-wrapper", "utf8"),
    }),
    taskNamePrefix: "SelfTuneDaemon",
    wscriptPath: modernWscript,
  };
  const store: WindowsServiceInstallationStoreWithLegacyCleanup = {
    createLegacyCleanup: (creation) =>
      Effect.sync(() => {
        events.push("journal:create");
        journal = createWindowsServiceLegacyCleanupJournal(creation, metadata);
        return journal;
      }),
    createReceipt: (creation) =>
      Effect.sync(() =>
        createWindowsServiceInstallationReceipt({
          ...creation,
          expectedArgv: [
            ...creation.expectedArgvWithoutNonce,
            "--service-installation-nonce",
            modernNonce,
          ],
          installId: modernInstallId,
          installedAt: metadata.createdAt,
          nonce: modernNonce,
          userSid: sid,
        }),
      ),
    persistReceipt: () => Effect.die("unused persistReceipt"),
    prepareServerControl: () => Effect.succeed(controlDir),
    readLegacyCleanup: () => Effect.succeed(journal),
    readReceipt: () => Effect.succeed(receipt),
    removeLegacyCleanup: (_configDir, expectation) =>
      Effect.sync(() => {
        events.push("journal:remove");
        if (!matchesWindowsServiceLegacyCleanupExpectation(journal, expectation)) {
          throw new Error("journal generation changed");
        }
        journal = null;
      }),
    removeReceiptAfterCleanup: (_configDir, _expectation, cleanup) => cleanup,
    requireLegacyCleanup: (_configDir, expectation) =>
      Effect.sync(() => {
        if (!matchesWindowsServiceLegacyCleanupExpectation(journal, expectation)) {
          throw new Error("journal generation changed");
        }
      }),
    resolveCurrentUserSid: () => Effect.succeed(sid),
    writeReceipt: (next) =>
      Effect.sync(() => {
        events.push("receipt:write");
        receipt = next;
      }),
  };
  const schedulerFor = (taskName: string): WindowsTaskScheduler<unknown> => ({
    create: () => Effect.die("unused create"),
    createExclusive: (definitionPath) =>
      Effect.sync(() => {
        const definition = files.get(definitionPath);
        if (definition === undefined) throw new Error("missing task definition");
        tasks.set(taskName, {
          definition: Buffer.from(definition).toString("utf8"),
          registered: true,
          running: false,
        });
      }),
    delete: () =>
      Effect.sync(() => {
        events.push(`task:delete:${taskName}`);
        tasks.delete(taskName);
      }),
    end: () =>
      Effect.sync(() => {
        events.push(`task:end:${taskName}`);
        const task = tasks.get(taskName);
        if (task !== undefined) task.running = false;
      }),
    listTaskNames: () =>
      Effect.succeed(
        [...tasks.entries()].filter(([, task]) => task.registered).map(([name]) => name),
      ),
    query: () => {
      const task = tasks.get(taskName);
      return Effect.succeed({
        registered: task?.registered ?? false,
        running: task?.running ?? false,
      });
    },
    readDefinition: () => Effect.succeed(tasks.get(taskName)?.definition ?? null),
    start: () =>
      Effect.sync(() => {
        const task = tasks.get(taskName);
        if (task !== undefined) task.running = true;
      }),
  });
  const controller = serviceFromLayer(
    WindowsInstallationController,
    makeWindowsInstallationControllerLayer({
      artifacts: {
        read: (path) => Effect.succeed(files.get(path) ?? null),
        removeMatching: ({ artifact }) =>
          Effect.sync(() => {
            events.push(`artifact:remove:${artifact.path}`);
            files.delete(artifact.path);
          }),
        write: (path, value) =>
          Effect.sync(() => {
            files.set(path, value);
          }),
      },
      schedulerFor,
      store,
    }),
  );
  return {
    controller,
    events,
    files,
    journal: () => journal,
    plan,
    replaceTaskDefinition: (taskName: string, definition: string) => {
      const task = tasks.get(taskName);
      if (task !== undefined) task.definition = definition;
    },
  };
}

describe("Windows legacy cleanup controller", () => {
  it("persists exact authority before mutation and removes the journal last", async () => {
    const test = harness();
    await Effect.runPromise(test.controller.begin(input));
    expect(test.events.indexOf("journal:create")).toBeLessThan(test.events.indexOf("task:end"));
    expect(test.events.indexOf("task:end")).toBeLessThan(test.events.indexOf("task:delete"));
    expect(test.events.at(-1)).toBe("journal:remove");
    expect(test.journal()).toBeNull();
    expect(test.files.size).toBe(0);
  });

  it("leaves durable authority when task stop or deletion fails and converges on retry", async () => {
    const taskFailures: ReadonlyArray<FailurePoint> = ["end", "delete"];
    await Promise.all(
      taskFailures.map(async (failure) => {
        const test = harness({ failure });
        await expect(Effect.runPromise(test.controller.begin(input))).rejects.toBeDefined();
        expect(test.journal()).not.toBeNull();
        test.setFailure();
        await Effect.runPromise(test.controller.resume(configDir));
        expect(test.journal()).toBeNull();
        expect(test.files.size).toBe(0);
      }),
    );
  });

  it("resumes after every artifact-removal crash without reauthorizing missing files", async () => {
    await Promise.all(
      [paths.taskDefinition, paths.launcher, paths.wrapper].map(async (path) => {
        const test = harness({ artifactFailurePath: path, failure: "artifact" });
        await expect(Effect.runPromise(test.controller.begin(input))).rejects.toBeDefined();
        expect(test.journal()).not.toBeNull();
        test.setArtifactFailure();
        await Effect.runPromise(test.controller.resume(configDir));
        expect(test.journal()).toBeNull();
        expect(test.files.size).toBe(0);
      }),
    );
  });

  it("keeps the journal after final unlink failure and retries only the last transition", async () => {
    const test = harness({ failure: "journal-remove" });
    await expect(Effect.runPromise(test.controller.begin(input))).rejects.toBeDefined();
    expect(test.journal()).not.toBeNull();
    expect(test.files.size).toBe(0);
    test.events.length = 0;
    test.setFailure();
    await Effect.runPromise(test.controller.resume(configDir));
    expect(test.events).not.toContain("task:end");
    expect(test.events).not.toContain("task:delete");
    expect(test.events.at(-1)).toBe("journal:remove");
  });

  it("fails closed on digest, task-definition, and full journal-generation drift", async () => {
    const digestDrift = harness({
      journal: createWindowsServiceLegacyCleanupJournal(input, metadata),
    });
    digestDrift.files.set(paths.wrapper, Buffer.from("foreign", "utf8"));
    await expect(Effect.runPromise(digestDrift.controller.resume(configDir))).rejects.toMatchObject(
      { operation: "verify-legacy-cleanup-artifacts" },
    );
    expect(digestDrift.events).not.toContain("task:end");

    const taskDrift = harness({
      journal: createWindowsServiceLegacyCleanupJournal(input, metadata),
    });
    taskDrift.setDefinition("<foreign-task />");
    await expect(Effect.runPromise(taskDrift.controller.resume(configDir))).rejects.toMatchObject({
      operation: "verify-legacy-cleanup-task-definition",
    });
    expect(taskDrift.events).not.toContain("task:end");

    const generationDrift = harness({
      failure: "end",
      journal: createWindowsServiceLegacyCleanupJournal(input, metadata),
    });
    await expect(
      Effect.runPromise(generationDrift.controller.resume(configDir)),
    ).rejects.toBeDefined();
    generationDrift.mutateJournal();
    generationDrift.setFailure();
    await expect(
      Effect.runPromise(
        generationDrift.controller.complete(
          createWindowsServiceLegacyCleanupJournal(input, metadata),
        ),
      ),
    ).rejects.toMatchObject({ operation: "verify-legacy-cleanup-before-task-query" });
    expect(generationDrift.events.filter((event) => event === "task:delete")).toHaveLength(0);
  });

  it("accepts partial progress only after the recorded task is absent", async () => {
    const journal = createWindowsServiceLegacyCleanupJournal(input, metadata);
    const partial = harness({ files: ["wrapper"], journal, taskRegistered: false });
    await Effect.runPromise(partial.controller.resume(configDir));
    expect(partial.journal()).toBeNull();
    expect(partial.files.size).toBe(0);

    const unsafe = harness({ files: ["wrapper"], journal });
    await expect(Effect.runPromise(unsafe.controller.resume(configDir))).rejects.toMatchObject({
      operation: "verify-legacy-cleanup-artifacts",
    });
    expect(unsafe.events).not.toContain("task:end");
  });

  it("preserves a replacement created after legacy artifact proof", async () => {
    const journal = createWindowsServiceLegacyCleanupJournal(input, metadata);
    const test = harness({
      journal,
      replacementDuringArtifactRemovalPath: paths.wrapper,
      taskRegistered: false,
    });

    await expect(Effect.runPromise(test.controller.resume(configDir))).rejects.toMatchObject({
      operation: "remove-legacy-cleanup-artifact",
    });
    expect(Buffer.from(test.files.get(paths.wrapper) ?? []).toString("utf8")).toBe(
      "foreign-replacement",
    );
    expect(test.journal()).toEqual(journal);
  });

  it("reports only fully proven journals as pending cleanup authority", async () => {
    const journal = createWindowsServiceLegacyCleanupJournal(input, metadata);
    const pending = harness({ journal });
    await expect(Effect.runPromise(pending.controller.inspect(configDir, sid))).resolves.toEqual({
      _tag: "Pending",
      journal,
      task: { registered: true, running: true },
    });

    const replacement = harness({ journal, taskDefinition: "<foreign-task />" });
    await expect(
      Effect.runPromise(replacement.controller.inspect(configDir, sid)),
    ).resolves.toMatchObject({
      _tag: "Refused",
      reason: "legacy-cleanup-task-definition-mismatch",
    });
    expect(replacement.events).not.toContain("task:end");

    const digestDrift = harness({ journal });
    digestDrift.files.set(paths.wrapper, Buffer.from("foreign", "utf8"));
    await expect(
      Effect.runPromise(digestDrift.controller.inspect(configDir, sid)),
    ).resolves.toMatchObject({ _tag: "Refused", reason: "legacy-cleanup-artifact-state-mismatch" });
    expect(digestDrift.events).not.toContain("task:end");

    const missingWhileRegistered = harness({ files: ["wrapper"], journal });
    await expect(
      Effect.runPromise(missingWhileRegistered.controller.inspect(configDir, sid)),
    ).resolves.toMatchObject({ _tag: "Refused", reason: "legacy-cleanup-artifact-state-mismatch" });

    const missingAfterTaskRemoval = harness({
      files: ["wrapper"],
      journal,
      taskRegistered: false,
    });
    await expect(
      Effect.runPromise(missingAfterTaskRemoval.controller.inspect(configDir, sid)),
    ).resolves.toMatchObject({ _tag: "Pending", task: { registered: false, running: false } });
  });

  it("refuses a journal whose canonical config differs from its locator", async () => {
    const otherConfigDir = "C:\\Users\\Other\\.selftune";
    const otherControlDir = `${otherConfigDir}\\server-control`;
    const otherInput: WindowsServiceLegacyCleanupJournalInput = {
      ...input,
      artifacts: {
        launcher: { ...input.artifacts.launcher, path: `${otherControlDir}\\run-daemon.vbs` },
        taskDefinition: {
          ...input.artifacts.taskDefinition,
          path: `${otherControlDir}\\run-daemon.xml`,
        },
        wrapper: { ...input.artifacts.wrapper, path: `${otherControlDir}\\run-daemon.cmd` },
      },
      configDir: otherConfigDir,
      runtimeIdentity: { ...input.runtimeIdentity, configDir: otherConfigDir },
    };
    const test = harness({
      journal: createWindowsServiceLegacyCleanupJournal(otherInput, metadata),
    });

    await expect(Effect.runPromise(test.controller.inspect(configDir, sid))).resolves.toMatchObject(
      {
        _tag: "Refused",
        reason: "legacy-cleanup-config-mismatch",
      },
    );
    expect(test.events).not.toContain("task:end");
  });
});

describe("Windows installation controller legacy cleanup integration", () => {
  it("journals before legacy mutation and installs an owned nonce-backed generation", async () => {
    const test = installationHarness("legacy");
    const receipt = await Effect.runPromise(test.controller.install(test.plan));
    expect(test.events.indexOf("journal:create")).toBeLessThan(
      test.events.indexOf("task:end:SelfTuneDaemon"),
    );
    expect(test.events.indexOf("journal:create")).toBeLessThan(
      test.events.indexOf("task:delete:SelfTuneDaemon"),
    );
    expect(test.events.indexOf("journal:remove")).toBeLessThan(
      test.events.indexOf("receipt:write"),
    );
    expect(receipt.nonce).toBe(modernNonce);
    await expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject({
      _tag: "Owned",
      receipt: { installId: modernInstallId, nonce: modernNonce },
    });
  });

  it("journals before legacy uninstall and ends absent", async () => {
    const test = installationHarness("legacy");
    await Effect.runPromise(test.controller.uninstall(test.plan));
    expect(test.events.indexOf("journal:create")).toBeLessThan(
      test.events.indexOf("task:end:SelfTuneDaemon"),
    );
    expect(test.events.at(-1)).toBe("journal:remove");
    await expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject({
      _tag: "Absent",
    });
  });

  it("surfaces a durable pending journal first and stop leaves it resumable", async () => {
    const test = installationHarness("pending");
    await expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject({
      _tag: "LegacyCleanupPending",
      journal: { cleanupId: metadata.cleanupId },
      task: { registered: true, running: true },
    });

    await Effect.runPromise(test.controller.stop(test.plan));

    expect(test.events).toContain("task:end:SelfTuneDaemon");
    expect(test.journal()).not.toBeNull();
    await expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject({
      _tag: "LegacyCleanupPending",
      task: { registered: true, running: false },
    });
  });

  it("does not stop a replacement task covered only by a stale cleanup journal", async () => {
    const test = installationHarness("pending");
    test.replaceTaskDefinition("SelfTuneDaemon", "<foreign-task />");

    await expect(Effect.runPromise(test.controller.stop(test.plan))).rejects.toThrow(
      "legacy-cleanup-task-definition-mismatch",
    );
    expect(test.events).not.toContain("task:end:SelfTuneDaemon");
    expect(test.journal()).not.toBeNull();
    await expect(Effect.runPromise(test.controller.inspect(test.plan))).resolves.toMatchObject({
      _tag: "Refused",
      reason: "legacy-cleanup-task-definition-mismatch",
    });
  });

  it("never derives fixed-name artifact deletion authority from an absent current plan", async () => {
    const test = installationHarness("absent");
    await Effect.runPromise(test.controller.install(test.plan));
    expect(test.files.get(paths.taskDefinition)).toEqual(contents.taskDefinition);
    expect(test.files.get(paths.launcher)).toEqual(contents.launcher);
    expect(test.files.get(paths.wrapper)).toEqual(contents.wrapper);
    expect(test.events.filter((event) => event.startsWith("artifact:remove:"))).toEqual([]);
  });
});
