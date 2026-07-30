import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  makeWindowsServiceInstallationController,
  type WindowsServiceInstallationPlan,
} from "@selftune/local/service/windows/installation/controller";
import {
  createWindowsServiceInstallationReceipt,
  sameWindowsServiceInstallationReceipt,
  sha256Hex,
  type WindowsServiceInstallationArtifacts,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import { generateWindowsTaskXml } from "@selftune/local/service/windows/installation/definition";
import type {
  WindowsServiceInstallationReceiptExpectation,
  WindowsServiceInstallationReceiptInput,
  WindowsServiceInstallationStoreWithLegacyCleanup,
} from "@selftune/local/service/windows/installation/store";
import type { WindowsTaskScheduler } from "@selftune/local/service/windows/scheduler";

const encoder = new TextEncoder();
const configDir = "C:\\Users\\Test\\.selftune";
const controlDir = `${configDir}\\server-control`;
const executablePath = "C:\\Program Files\\Bun\\bun.exe";
const sourcePath = "C:\\SelfTune\\selftune.ts";
const sid = "S-1-5-21-1000-2000-3000-4000";
const wscriptPath = "C:\\Windows\\System32\\wscript.exe";
const installId = "10101010-1010-4010-9010-101010101010";
const predecessorInstallId = "20202020-2020-4020-9020-202020202020";
const successorInstallId = "30303030-3030-4030-8030-303030303030";
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";

function artifactPaths(id: string) {
  return {
    launcher: `${controlDir}\\${id}-daemon.vbs`,
    taskDefinition: `${controlDir}\\${id}-daemon.xml`,
    wrapper: `${controlDir}\\${id}-daemon.cmd`,
  };
}

function taskXml(launcherPath: string, principalId = sid): string {
  return generateWindowsTaskXml({
    boot: false,
    commandPath: wscriptPath,
    launcherPath,
    userId: principalId,
  });
}

function renderedArtifacts(receipt: WindowsServiceInstallationReceipt) {
  return {
    launcher: encoder.encode(`launcher:${receipt.artifacts.wrapper.path}`),
    taskDefinitionXml: taskXml(receipt.artifacts.launcher.path),
    wrapper: encoder.encode(`wrapper:${receipt.nonce}`),
  };
}

const receiptInput: WindowsServiceInstallationPlan["receipt"] = {
  boot: false,
  configDir,
  executableArgsPrefix: [sourcePath],
  executablePath,
  expectedArgvWithoutNonce: [
    sourcePath,
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
  ],
  owner: "desktop",
  port: 7888,
};

const plan: WindowsServiceInstallationPlan = {
  artifactPaths,
  encodeTaskDefinition: (xml) => encoder.encode(xml),
  receipt: receiptInput,
  renderArtifacts: renderedArtifacts,
  taskNamePrefix: "SelfTuneDaemon",
  wscriptPath,
};

function makeDraft(input: WindowsServiceInstallationReceiptInput) {
  return createWindowsServiceInstallationReceipt({
    artifacts: input.artifacts,
    boot: input.boot,
    configDir: input.configDir,
    executableArgsPrefix: input.executableArgsPrefix,
    executablePath: input.executablePath,
    expectedArgv: [...input.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
    installId,
    installedAt: "2026-07-16T12:30:00.000Z",
    nonce,
    owner: input.owner,
    port: input.port,
    taskName: input.taskName,
    userSid: sid,
  });
}

function makeOwnedReceipt(receiptInstallId = installId): {
  readonly artifacts: ReturnType<typeof renderedArtifacts>;
  readonly receipt: WindowsServiceInstallationReceipt;
} {
  const paths = artifactPaths(receiptInstallId);
  const placeholder: WindowsServiceInstallationArtifacts = {
    launcher: { path: paths.launcher, sha256: "0".repeat(64) },
    taskDefinition: { path: paths.taskDefinition, sha256: "0".repeat(64) },
    wrapper: { path: paths.wrapper, sha256: "0".repeat(64) },
  };
  const draft = createWindowsServiceInstallationReceipt({
    ...receiptInput,
    artifacts: placeholder,
    expectedArgv: [...receiptInput.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
    installId: receiptInstallId,
    installedAt: "2026-07-16T12:00:00.000Z",
    nonce,
    taskName: `SelfTuneDaemon-${receiptInstallId}`,
    userSid: sid,
  });
  const artifacts = renderedArtifacts(draft);
  const receipt = createWindowsServiceInstallationReceipt({
    ...draft,
    artifacts: {
      launcher: { path: paths.launcher, sha256: sha256Hex(artifacts.launcher) },
      taskDefinition: {
        path: paths.taskDefinition,
        sha256: sha256Hex(encoder.encode(artifacts.taskDefinitionXml)),
      },
      wrapper: { path: paths.wrapper, sha256: sha256Hex(artifacts.wrapper) },
    },
  });
  return { artifacts, receipt };
}

function makeForeignConfigReceipt(
  receipt: WindowsServiceInstallationReceipt,
): WindowsServiceInstallationReceipt {
  const foreignConfigDir = "C:\\Users\\Other\\.selftune";
  const foreignControlDir = `${foreignConfigDir}\\server-control`;
  const paths = {
    launcher: `${foreignControlDir}\\${receipt.installId}-daemon.vbs`,
    taskDefinition: `${foreignControlDir}\\${receipt.installId}-daemon.xml`,
    wrapper: `${foreignControlDir}\\${receipt.installId}-daemon.cmd`,
  };
  const launcher = encoder.encode(`launcher:${paths.wrapper}`);
  const taskDefinition = encoder.encode(taskXml(paths.launcher));
  const wrapper = encoder.encode(`wrapper:${receipt.nonce}`);
  return createWindowsServiceInstallationReceipt({
    ...receipt,
    artifacts: {
      launcher: { path: paths.launcher, sha256: sha256Hex(launcher) },
      taskDefinition: {
        path: paths.taskDefinition,
        sha256: sha256Hex(taskDefinition),
      },
      wrapper: { path: paths.wrapper, sha256: sha256Hex(wrapper) },
    },
    configDir: foreignConfigDir,
  });
}

interface HarnessOptions {
  readonly artifactRemoveFailsAt?: number;
  readonly artifactWriteFailsAt?: number;
  readonly createFails?: boolean;
  readonly createFailsAt?: number;
  readonly deleteFails?: boolean;
  readonly initialReceipt?: WindowsServiceInstallationReceipt | null;
  readonly receiptRemovalFailsAt?: number;
  readonly receiptDriftsAfterCreate?: boolean;
  readonly receiptDriftsAfterEnd?: boolean;
  readonly receiptChangesBeforeWriteTo?: WindowsServiceInstallationReceipt;
  readonly receiptChangesDuringCleanupTo?: WindowsServiceInstallationReceipt;
  readonly receiptWriteFails?: boolean;
  readonly receiptWriteFailsAt?: number;
  readonly replacementDuringArtifactRemovalPath?: string;
  readonly startFailsAt?: number;
  readonly tamperAfterEnd?: boolean;
  readonly taskDefinition?: string;
  readonly taskRegistered?: boolean;
  readonly taskRunning?: boolean;
}

type TaskState = { definition: string | null; registered: boolean; running: boolean };

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const files = new Map<string, Uint8Array>();
  let artifactRemoveAttempts = 0;
  let artifactWriteAttempts = 0;
  let createAttempts = 0;
  let receipt = options.initialReceipt ?? null;
  let receiptRemovalAttempts = 0;
  let receiptWriteAttempts = 0;
  let startAttempts = 0;
  const taskStates = new Map<string, TaskState>();

  if (receipt !== null) {
    const rendered = renderedArtifacts(receipt);
    files.set(receipt.artifacts.wrapper.path, rendered.wrapper);
    files.set(receipt.artifacts.launcher.path, rendered.launcher);
    files.set(receipt.artifacts.taskDefinition.path, encoder.encode(rendered.taskDefinitionXml));
    taskStates.set(receipt.taskName, {
      definition: options.taskDefinition ?? rendered.taskDefinitionXml,
      registered: options.taskRegistered ?? true,
      running: options.taskRunning ?? true,
    });
  }

  const receiptMatches = (expected: WindowsServiceInstallationReceiptExpectation): boolean => {
    if (expected._tag === "Absent") return receipt === null;
    return receipt !== null && sameWindowsServiceInstallationReceipt(receipt, expected.receipt);
  };

  const store: WindowsServiceInstallationStoreWithLegacyCleanup = {
    createLegacyCleanup: () => Effect.die("unused createLegacyCleanup"),
    createReceipt: (input) =>
      Effect.sync(() => {
        events.push("receipt:create");
        return makeDraft(input);
      }),
    persistReceipt: (input, _expectedPrior) =>
      Effect.sync(() => {
        events.push("receipt:persist");
        const created = makeDraft(input);
        receipt = created;
        return created;
      }),
    prepareServerControl: () =>
      Effect.sync(() => {
        events.push("server-control:prepare");
        return controlDir;
      }),
    readReceipt: () =>
      Effect.sync(() => {
        events.push("receipt:read");
        return receipt;
      }),
    readLegacyCleanup: () => Effect.succeed(null),
    removeLegacyCleanup: () => Effect.die("unused removeLegacyCleanup"),
    removeReceiptAfterCleanup: (_configDir, expected, cleanup) =>
      Effect.suspend(() =>
        receiptMatches(expected)
          ? cleanup.pipe(
              Effect.flatMap(() =>
                Effect.try({
                  try: () => {
                    if (options.receiptChangesDuringCleanupTo !== undefined) {
                      receipt = options.receiptChangesDuringCleanupTo;
                    }
                    if (!receiptMatches(expected)) throw new Error("receipt generation changed");
                    receiptRemovalAttempts += 1;
                    events.push("receipt:remove");
                    if (receiptRemovalAttempts === options.receiptRemovalFailsAt) {
                      throw new Error("receipt removal denied");
                    }
                    receipt = null;
                  },
                  catch: (cause) => cause,
                }),
              ),
            )
          : Effect.fail(new Error("receipt generation changed")),
      ),
    resolveCurrentUserSid: () =>
      Effect.sync(() => {
        events.push("sid:read");
        return sid;
      }),
    requireLegacyCleanup: () => Effect.die("unused requireLegacyCleanup"),
    writeReceipt: (next, expectedPrior) =>
      Effect.try({
        try: () => {
          if (options.receiptChangesBeforeWriteTo !== undefined) {
            receipt = options.receiptChangesBeforeWriteTo;
          }
          if (!receiptMatches(expectedPrior)) throw new Error("receipt generation changed");
          receiptWriteAttempts += 1;
          events.push("receipt:write");
          if (options.receiptWriteFails || receiptWriteAttempts === options.receiptWriteFailsAt) {
            throw new Error("receipt write denied");
          }
          receipt = next;
        },
        catch: (cause) => cause,
      }),
  };

  const schedulerFor = (taskName: string): WindowsTaskScheduler<unknown> => {
    const state = () => {
      const found = taskStates.get(taskName);
      if (found !== undefined) return found;
      const created = { definition: null, registered: false, running: false };
      taskStates.set(taskName, created);
      return created;
    };
    return {
      create: () => Effect.die("replace-capable create must never be called"),
      createExclusive: (xmlPath) =>
        Effect.try({
          try: () => {
            createAttempts += 1;
            events.push(`task:create-exclusive:${taskName}`);
            if (options.createFails || createAttempts === options.createFailsAt) {
              throw new Error("create denied");
            }
            const current = state();
            if (current.registered) throw new Error("task already exists");
            const bytes = files.get(xmlPath);
            if (bytes === undefined) throw new Error("task XML missing");
            current.definition = new TextDecoder().decode(bytes);
            current.registered = true;
            if (options.receiptDriftsAfterCreate && receipt !== null) {
              receipt = createWindowsServiceInstallationReceipt({
                ...receipt,
                installedAt: "2026-07-16T12:31:00.000Z",
              });
            }
          },
          catch: (cause) => cause,
        }),
      delete: () =>
        Effect.try({
          try: () => {
            events.push(`task:delete:${taskName}`);
            if (options.deleteFails) throw new Error("task deletion denied");
            state().registered = false;
            state().running = false;
          },
          catch: (cause) => cause,
        }),
      end: () =>
        Effect.sync(() => {
          events.push(`task:end:${taskName}`);
          state().running = false;
          if (options.receiptDriftsAfterEnd && receipt !== null) {
            receipt = createWindowsServiceInstallationReceipt({
              ...receipt,
              installedAt: "2026-07-16T12:01:00.000Z",
            });
          }
          if (options.tamperAfterEnd) state().definition = "<Task/>";
        }),
      listTaskNames: () => Effect.succeed([]),
      query: () =>
        Effect.sync(() => {
          events.push(`task:query:${taskName}`);
          const current = state();
          return { registered: current.registered, running: current.running };
        }),
      readDefinition: () =>
        Effect.sync(() => {
          events.push(`task:read-definition:${taskName}`);
          return state().registered ? state().definition : null;
        }),
      start: () =>
        Effect.try({
          try: () => {
            startAttempts += 1;
            events.push(`task:start:${taskName}`);
            if (startAttempts === options.startFailsAt) throw new Error("start denied");
            state().running = true;
          },
          catch: (cause) => cause,
        }),
    };
  };

  const controller = makeWindowsServiceInstallationController({
    artifacts: {
      read: (path) => Effect.succeed(files.get(path) ?? null),
      removeMatching: ({ artifact, generation }) =>
        Effect.try({
          try: () => {
            artifactRemoveAttempts += 1;
            events.push(`artifact:remove:${artifact.path}`);
            if (artifactRemoveAttempts === options.artifactRemoveFailsAt) {
              throw new Error("artifact removal denied");
            }
            const current = files.get(artifact.path);
            if (current === undefined) return;
            if (sha256Hex(current) !== artifact.sha256) {
              throw new Error("artifact digest changed before quarantine");
            }
            if (generation.length === 0) throw new Error("artifact generation missing");
            files.delete(artifact.path);
            if (artifact.path === options.replacementDuringArtifactRemovalPath) {
              files.set(artifact.path, encoder.encode("foreign-replacement"));
              throw new Error("artifact changed during quarantine removal");
            }
          },
          catch: (cause) => cause,
        }),
      write: (path, contents) =>
        Effect.try({
          try: () => {
            artifactWriteAttempts += 1;
            events.push(`artifact:write:${path}`);
            if (artifactWriteAttempts === options.artifactWriteFailsAt) {
              throw new Error("artifact write denied");
            }
            files.set(path, contents);
          },
          catch: (cause) => cause,
        }),
    },
    schedulerFor,
    store,
  });
  return {
    controller,
    events,
    files,
    get receipt() {
      return receipt;
    },
    taskStates,
  };
}

function mutationEvents(events: ReadonlyArray<string>) {
  return events.filter(
    (event) =>
      event.startsWith("artifact:") ||
      event === "receipt:remove" ||
      event === "receipt:write" ||
      event.startsWith("task:create") ||
      event.startsWith("task:delete") ||
      event.startsWith("task:end") ||
      event.startsWith("task:start"),
  );
}

type Harness = ReturnType<typeof harness>;
type ControlOperation = "restart" | "start" | "stop" | "uninstall";

function expectNoEventStartingWith(events: ReadonlyArray<string>, prefixes: ReadonlyArray<string>) {
  expect(events.filter((event) => prefixes.some((prefix) => event.startsWith(prefix)))).toEqual([]);
}

function expectArtifactsPresent(test: Harness, receipt: WindowsServiceInstallationReceipt): void {
  expect(test.files.has(receipt.artifacts.wrapper.path)).toBe(true);
  expect(test.files.has(receipt.artifacts.launcher.path)).toBe(true);
  expect(test.files.has(receipt.artifacts.taskDefinition.path)).toBe(true);
}

function expectAllEventsBefore(
  events: ReadonlyArray<string>,
  beforePrefix: string,
  afterPrefix: string,
): void {
  const beforeIndexes = events.flatMap((event, index) =>
    event.startsWith(beforePrefix) ? [index] : [],
  );
  const afterIndex = events.findIndex((event) => event.startsWith(afterPrefix));
  expect(beforeIndexes.length).toBeGreaterThan(0);
  expect(afterIndex).toBeGreaterThanOrEqual(0);
  expect(beforeIndexes.every((index) => index < afterIndex)).toBe(true);
}

function control(test: Harness, operation: ControlOperation) {
  switch (operation) {
    case "restart":
      return test.controller.restart(plan);
    case "start":
      return test.controller.start(plan);
    case "stop":
      return test.controller.stop(plan);
    case "uninstall":
      return test.controller.uninstall(plan);
  }
}

describe("Windows service installation ownership controller", () => {
  it("classifies owned and owned-incomplete state without mutating it", async () => {
    const owned = makeOwnedReceipt();
    const active = harness({ initialReceipt: owned.receipt });
    await expect(Effect.runPromise(active.controller.status(plan))).resolves.toMatchObject({
      _tag: "Owned",
      receipt: { installId },
    });
    expect(mutationEvents(active.events)).toEqual([]);

    const partial = harness({
      initialReceipt: owned.receipt,
      taskRegistered: false,
    });
    partial.files.delete(owned.receipt.artifacts.launcher.path);
    await expect(Effect.runPromise(partial.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "OwnedIncomplete",
    });
    expect(mutationEvents(partial.events)).toEqual([]);
  });

  it("fails closed on definition mismatch before scheduler mutation", async () => {
    const owned = makeOwnedReceipt();
    const test = harness({
      initialReceipt: owned.receipt,
      taskDefinition: "<Task/>",
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Refused",
      reason: "registered-task-definition-task-namespace-mismatch",
    });
    await expect(Effect.runPromise(test.controller.stop(plan))).rejects.toMatchObject({
      operation: "stop",
    });
    expect(mutationEvents(test.events)).toEqual([]);
  });

  it("persists install intent before unique artifacts, exclusive create, and start", async () => {
    const test = harness();
    const installed = await Effect.runPromise(test.controller.install(plan));
    const mutations = mutationEvents(test.events);

    expect(installed.taskName).toBe(`SelfTuneDaemon-${installId}`);
    expect(installed.artifacts.wrapper.path).toContain(installId);
    expect(test.events.indexOf("server-control:prepare")).toBeLessThan(
      test.events.findIndex((event) => event.startsWith("artifact:write:")),
    );
    expect(mutations.map((event) => event.split(":")[0])).toEqual([
      "receipt",
      "artifact",
      "artifact",
      "artifact",
      "task",
      "task",
    ]);
    expect(mutations[0]).toBe("receipt:write");
    expect(mutations[4]).toBe(`task:create-exclusive:${installed.taskName}`);
    expect(mutations[5]).toBe(`task:start:${installed.taskName}`);
  });

  it("cleans a proven predecessor before persisting its replacement", async () => {
    const predecessor = makeOwnedReceipt(predecessorInstallId);
    const test = harness({ initialReceipt: predecessor.receipt });

    await Effect.runPromise(test.controller.install(plan));

    expect(test.files.has(predecessor.receipt.artifacts.wrapper.path)).toBe(false);
    expect(test.files.has(predecessor.receipt.artifacts.launcher.path)).toBe(false);
    expect(test.files.has(predecessor.receipt.artifacts.taskDefinition.path)).toBe(false);
    expectAllEventsBefore(test.events, "artifact:remove:", "receipt:write");
    expectAllEventsBefore(
      test.events,
      `task:delete:${predecessor.receipt.taskName}`,
      "receipt:write",
    );
  });

  it("retains predecessor cleanup references and converges after partial cleanup fails", async () => {
    const predecessor = makeOwnedReceipt(predecessorInstallId);
    const test = harness({
      artifactRemoveFailsAt: 2,
      initialReceipt: predecessor.receipt,
    });

    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "remove-installation-artifact",
    });
    expect(test.receipt).toEqual(predecessor.receipt);
    expect(test.taskStates.get(predecessor.receipt.taskName)?.registered).toBe(false);
    expectNoEventStartingWith(test.events, ["artifact:write", "receipt:write", "task:create"]);

    const installed = await Effect.runPromise(test.controller.install(plan));
    expect(installed.installId).toBe(installId);
  });

  it("keeps the predecessor receipt until replacement receipt persistence succeeds", async () => {
    const predecessor = makeOwnedReceipt(predecessorInstallId);
    const test = harness({
      initialReceipt: predecessor.receipt,
      receiptWriteFailsAt: 1,
    });

    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "persist-installation-receipt",
    });
    expect(test.receipt).toEqual(predecessor.receipt);
    expect(test.taskStates.get(predecessor.receipt.taskName)?.registered).toBe(false);
    expectNoEventStartingWith(test.events, ["task:create", "task:start"]);

    const installed = await Effect.runPromise(test.controller.install(plan));
    expectArtifactsPresent(test, installed);
  });

  it("retains receipt-backed install intent after any artifact write fails", async () => {
    await Promise.all(
      [1, 2, 3].map(async (artifactWriteFailsAt) => {
        const test = harness({ artifactWriteFailsAt });

        await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
          operation: "write-installation-artifact",
        });
        expect(test.receipt?.installId).toBe(installId);
        await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
          _tag: "OwnedIncomplete",
        });
        expectNoEventStartingWith(test.events, ["task:create", "task:start"]);
      }),
    );
  });

  it("does not write artifacts when the receipt write fails", async () => {
    const test = harness({ receiptWriteFails: true });

    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "persist-installation-receipt",
    });
    expect(test.receipt).toBeNull();
    expect(test.files.size).toBe(0);
    expectNoEventStartingWith(test.events, ["artifact:write", "task:create", "task:start"]);
  });

  it("passes the initially observed absent generation and blocks a stale installer", async () => {
    const successor = makeOwnedReceipt(successorInstallId);
    const test = harness({ receiptChangesBeforeWriteTo: successor.receipt });
    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "persist-installation-receipt",
    });
    expect(test.receipt).toEqual(successor.receipt);
    expectNoEventStartingWith(test.events, ["receipt:write", "artifact:write"]);
    expectNoEventStartingWith(test.events, ["task:create", "task:start"]);
  });

  it("leaves a receipt-backed incomplete installation when exclusive create fails", async () => {
    const test = harness({ createFails: true });

    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "create-owned-task",
    });
    expect(test.receipt?.installId).toBe(installId);
    if (test.receipt === null) throw new Error("expected persisted installation receipt");
    expectArtifactsPresent(test, test.receipt);
    expect(mutationEvents(test.events).some((event) => event.startsWith("task:start"))).toBe(false);
    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "OwnedIncomplete",
    });
  });

  it("retries a receipt-backed replacement after exclusive create fails", async () => {
    const predecessor = makeOwnedReceipt(predecessorInstallId);
    const test = harness({
      createFailsAt: 1,
      initialReceipt: predecessor.receipt,
    });

    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "create-owned-task",
    });
    expect(test.receipt?.installId).toBe(installId);
    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "OwnedIncomplete",
    });

    const installed = await Effect.runPromise(test.controller.install(plan));
    expect(test.taskStates.get(installed.taskName)?.registered).toBe(true);
    expect(test.taskStates.get(installed.taskName)?.running).toBe(true);
  });

  it("leaves a proven stopped replacement and converges when start fails", async () => {
    const predecessor = makeOwnedReceipt(predecessorInstallId);
    const test = harness({
      initialReceipt: predecessor.receipt,
      startFailsAt: 1,
    });

    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "start-owned-task",
    });
    expect(test.receipt?.installId).toBe(installId);
    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Owned",
      task: { registered: true, running: false },
    });

    const installed = await Effect.runPromise(test.controller.install(plan));
    expect(test.taskStates.get(installed.taskName)?.running).toBe(true);
  });

  it("deletes a proven task before artifacts and removes the receipt last", async () => {
    const owned = makeOwnedReceipt();
    const test = harness({ initialReceipt: owned.receipt });
    await Effect.runPromise(test.controller.uninstall(plan));
    const mutations = mutationEvents(test.events);
    expect(mutations[0]).toBe(`task:end:${owned.receipt.taskName}`);
    expect(mutations[1]).toBe(`task:delete:${owned.receipt.taskName}`);
    expect(mutations.slice(2, 5).every((event) => event.startsWith("artifact:remove:"))).toBe(true);
    expect(mutations[5]).toBe("receipt:remove");
    expect(test.receipt).toBeNull();
  });

  it("preserves a replacement created after artifact ownership proof", async () => {
    const owned = makeOwnedReceipt();
    const replacementPath = owned.receipt.artifacts.wrapper.path;
    const test = harness({
      initialReceipt: owned.receipt,
      replacementDuringArtifactRemovalPath: replacementPath,
    });
    await expect(Effect.runPromise(test.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "remove-receipt-after-cleanup",
    });
    expect(new TextDecoder().decode(test.files.get(replacementPath))).toBe("foreign-replacement");
    expect(test.receipt).toEqual(owned.receipt);
  });

  it("passes the proven receipt generation and preserves a successor during uninstall", async () => {
    const owned = makeOwnedReceipt();
    const successor = makeOwnedReceipt(successorInstallId);
    const test = harness({
      initialReceipt: owned.receipt,
      receiptChangesDuringCleanupTo: successor.receipt,
    });
    await expect(Effect.runPromise(test.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "remove-receipt-after-cleanup",
    });
    expect(test.receipt).toEqual(successor.receipt);
    expect(test.events).not.toContain("receipt:remove");
    expect(mutationEvents(test.events).join()).not.toContain(successorInstallId);
  });

  it("keeps the receipt and every artifact when scheduler deletion fails", async () => {
    const owned = makeOwnedReceipt();
    const test = harness({ deleteFails: true, initialReceipt: owned.receipt });

    await expect(Effect.runPromise(test.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "delete-owned-task",
    });
    expect(test.receipt).toEqual(owned.receipt);
    expectArtifactsPresent(test, owned.receipt);
    expectNoEventStartingWith(test.events, ["artifact:remove", "receipt:remove"]);
    expect(test.taskStates.get(owned.receipt.taskName)?.registered).toBe(true);
  });

  it("retains the receipt after cleanup fails and converges on retry", async () => {
    const owned = makeOwnedReceipt();
    const test = harness({
      artifactRemoveFailsAt: 2,
      initialReceipt: owned.receipt,
    });

    await expect(Effect.runPromise(test.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "remove-receipt-after-cleanup",
    });
    expect(test.taskStates.get(owned.receipt.taskName)?.registered).toBe(false);
    expect(test.receipt).toEqual(owned.receipt);
    expect(test.events).not.toContain("receipt:remove");

    await expect(Effect.runPromise(test.controller.uninstall(plan))).resolves.toBeUndefined();
    expect(test.receipt).toBeNull();
    expect(test.files.size).toBe(0);
  });

  it("attempts receipt removal only after task and artifact cleanup", async () => {
    const owned = makeOwnedReceipt();
    const test = harness({
      initialReceipt: owned.receipt,
      receiptRemovalFailsAt: 1,
    });

    await expect(Effect.runPromise(test.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "remove-receipt-after-cleanup",
    });
    expect(test.receipt).toEqual(owned.receipt);
    expect(test.files.size).toBe(0);
    expectAllEventsBefore(test.events, "task:delete:", "receipt:remove");
    expectAllEventsBefore(test.events, "artifact:remove:", "receipt:remove");

    await expect(Effect.runPromise(test.controller.uninstall(plan))).resolves.toBeUndefined();
    expect(test.receipt).toBeNull();
  });

  it("converges an interrupted cleanup but rejects a present digest mismatch", async () => {
    const owned = makeOwnedReceipt();
    const retry = harness({
      initialReceipt: owned.receipt,
      taskRegistered: false,
    });
    retry.files.delete(owned.receipt.artifacts.taskDefinition.path);
    await Effect.runPromise(retry.controller.uninstall(plan));
    expect(retry.receipt).toBeNull();

    const changed = harness({
      initialReceipt: owned.receipt,
      taskRegistered: false,
    });
    changed.files.set(owned.receipt.artifacts.wrapper.path, encoder.encode("foreign"));
    await expect(Effect.runPromise(changed.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "uninstall",
    });
    expect(mutationEvents(changed.events)).toEqual([]);
  });

  it("blocks deletion when task evidence changes after end", async () => {
    const owned = makeOwnedReceipt();
    const test = harness({
      initialReceipt: owned.receipt,
      tamperAfterEnd: true,
    });

    await expect(Effect.runPromise(test.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "reprove-before-delete",
    });
    expect(mutationEvents(test.events)).toEqual([`task:end:${owned.receipt.taskName}`]);
    expect(test.taskStates.get(owned.receipt.taskName)?.registered).toBe(true);
  });

  it("rejects full-receipt generation drift with the same install id and nonce", async () => {
    const owned = makeOwnedReceipt();
    const beforeDelete = harness({
      initialReceipt: owned.receipt,
      receiptDriftsAfterEnd: true,
    });
    await expect(Effect.runPromise(beforeDelete.controller.uninstall(plan))).rejects.toMatchObject({
      operation: "reprove-before-delete",
    });
    expect(mutationEvents(beforeDelete.events)).toEqual([`task:end:${owned.receipt.taskName}`]);

    const afterCreate = harness({ receiptDriftsAfterCreate: true });
    await expect(Effect.runPromise(afterCreate.controller.install(plan))).rejects.toMatchObject({
      operation: "verify-created-task",
    });
    expect(afterCreate.taskStates.get(`SelfTuneDaemon-${installId}`)?.registered).toBe(true);
  });

  it("refuses every control mutation for definition, receipt, SID, and artifact mismatches", async () => {
    const owned = makeOwnedReceipt();
    const mismatches: ReadonlyArray<{
      readonly makeHarness: () => Harness;
      readonly name: string;
    }> = [
      {
        makeHarness: () => harness({ initialReceipt: owned.receipt, taskDefinition: "<Task/>" }),
        name: "definition",
      },
      {
        makeHarness: () =>
          harness({
            initialReceipt: makeForeignConfigReceipt(owned.receipt),
          }),
        name: "receipt",
      },
      {
        makeHarness: () =>
          harness({
            initialReceipt: createWindowsServiceInstallationReceipt({
              ...owned.receipt,
              userSid: "S-1-5-21-9999-9999-9999-9999",
            }),
          }),
        name: "SID",
      },
      {
        makeHarness: () => {
          const test = harness({ initialReceipt: owned.receipt });
          test.files.set(owned.receipt.artifacts.wrapper.path, encoder.encode("foreign"));
          return test;
        },
        name: "artifact",
      },
    ];

    const operations: ReadonlyArray<ControlOperation> = ["start", "stop", "restart", "uninstall"];
    await Promise.all(
      mismatches.flatMap((mismatch) =>
        operations.map(async (operation) => {
          const test = mismatch.makeHarness();
          await expect(Effect.runPromise(control(test, operation))).rejects.toBeDefined();
          expect(
            mutationEvents(test.events),
            `${mismatch.name} mismatch during ${operation}`,
          ).toEqual([]);
        }),
      ),
    );
  });

  it("refuses an existing legacy task when exact migration evidence is unavailable", async () => {
    const test = harness();
    test.taskStates.set("SelfTuneDaemon", {
      definition: taskXml(`${controlDir}\\run-daemon.vbs`, "DOMAIN\\Test"),
      registered: true,
      running: true,
    });

    await expect(
      Effect.runPromise(test.controller.install({ ...plan, legacyTaskName: "SelfTuneDaemon" })),
    ).rejects.toMatchObject({ operation: "install" });
    expect(mutationEvents(test.events)).toEqual([]);
  });
});
