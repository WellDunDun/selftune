import { serviceFromLayer } from "../helpers/service-layer";
import { WindowsInstallationController } from "@selftune/local/service/windows/installation/controller";
import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  makeWindowsInstallationControllerLayer,
  type WindowsServiceInstallationPlan,
} from "@selftune/local/service/windows/installation/controller";
import {
  createWindowsServiceInstallationReceipt,
  sha256Hex,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import { generateWindowsTaskXml } from "@selftune/local/service/windows/installation/definition";
import type { WindowsServiceInstallationStoreWithLegacyCleanup } from "@selftune/local/service/windows/installation/store";
import type { WindowsTaskScheduler } from "@selftune/local/service/windows/scheduler";

const configDir = "C:\\Users\\Test\\.selftune";
const controlDir = `${configDir}\\server-control`;
const firstInstallId = "30303030-3030-4030-8030-303030303030";
const secondInstallId = "40404040-4040-4040-8040-404040404040";
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890";
const sid = "S-1-5-21-1000-2000-3000-4000";
const encoder = new TextEncoder();

function unreachable(message: string): never {
  return Effect.runSync(Effect.die(message));
}

const plan: WindowsServiceInstallationPlan = {
  artifactPaths: (installId) => ({
    launcher: `${controlDir}\\${installId}-daemon.vbs`,
    taskDefinition: `${controlDir}\\${installId}-daemon.xml`,
    wrapper: `${controlDir}\\${installId}-daemon.cmd`,
  }),
  encodeTaskDefinition: (xml) => encoder.encode(xml),
  receipt: {
    boot: false,
    configDir,
    executableArgsPrefix: ["C:\\SelfTune\\selftune.ts"],
    executablePath: "C:\\Program Files\\Bun\\bun.exe",
    expectedArgvWithoutNonce: [
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
    ],
    owner: "desktop",
    port: 7888,
  },
  renderArtifacts: () => unreachable("orphan inspection must not render artifacts"),
  taskNamePrefix: "SelfTuneDaemon",
  wscriptPath: "C:\\Windows\\System32\\wscript.exe",
};

function mutation<A>(mutations: string[], name: string): Effect.Effect<A> {
  return Effect.sync(() => {
    mutations.push(name);
  }).pipe(Effect.andThen(Effect.die(`unexpected mutation: ${name}`)));
}

interface OwnedFixture {
  readonly definition: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly receipt: WindowsServiceInstallationReceipt;
}

function ownedFixture(): OwnedFixture {
  const paths = plan.artifactPaths(firstInstallId);
  const launcher = encoder.encode("owned-launcher");
  const wrapper = encoder.encode("owned-wrapper");
  const definition = generateWindowsTaskXml({
    boot: false,
    commandPath: plan.wscriptPath,
    launcherPath: paths.launcher,
    userId: sid,
  });
  const taskDefinition = encoder.encode(definition);
  const receipt = createWindowsServiceInstallationReceipt({
    artifacts: {
      launcher: { path: paths.launcher, sha256: sha256Hex(launcher) },
      taskDefinition: { path: paths.taskDefinition, sha256: sha256Hex(taskDefinition) },
      wrapper: { path: paths.wrapper, sha256: sha256Hex(wrapper) },
    },
    ...plan.receipt,
    expectedArgv: [...plan.receipt.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
    installId: firstInstallId,
    installedAt: "2026-07-17T00:00:00.000Z",
    nonce,
    taskName: `SelfTuneDaemon-${firstInstallId}`,
    userSid: sid,
  });
  return {
    definition,
    files: new Map([
      [paths.launcher, launcher],
      [paths.taskDefinition, taskDefinition],
      [paths.wrapper, wrapper],
    ]),
    receipt,
  };
}

function canonicalTaskName(taskName: string): string {
  return `\\${taskName.trim().replaceAll("/", "\\").replace(/^\\+/, "")}`.toLowerCase();
}

function scopedTaskDefinition(
  installId: string,
  options: { readonly configDir?: string; readonly userSid?: string } = {},
): string {
  const scopedConfigDir = options.configDir ?? configDir;
  return generateWindowsTaskXml({
    boot: false,
    commandPath: plan.wscriptPath,
    launcherPath: `${scopedConfigDir}\\server-control\\${installId}-daemon.vbs`,
    userId: options.userSid ?? sid,
  });
}

function taskDefinitions(
  entries: ReadonlyArray<readonly [taskName: string, definition: string]>,
): ReadonlyMap<string, string> {
  return new Map(
    entries.map(([taskName, definition]) => [canonicalTaskName(taskName), definition]),
  );
}

function harness(options: {
  readonly definitionErrors?: ReadonlySet<string>;
  readonly inventoryError?: boolean;
  readonly owned?: OwnedFixture;
  readonly taskDefinitions?: ReadonlyMap<string, string>;
  readonly taskNames: ReadonlyArray<string>;
}) {
  const mutations: string[] = [];
  const schedulerFor = (taskName: string): WindowsTaskScheduler<unknown> => ({
    create: () => mutation(mutations, "task:create"),
    createExclusive: () => mutation(mutations, "task:create-exclusive"),
    delete: () => mutation(mutations, "task:delete"),
    end: () => mutation(mutations, "task:end"),
    listTaskNames: () =>
      options.inventoryError
        ? Effect.fail(new Error("inventory denied"))
        : Effect.succeed(options.taskNames),
    query: () => {
      const registered = options.taskNames.some(
        (candidate) => canonicalTaskName(candidate) === canonicalTaskName(taskName),
      );
      return Effect.succeed({ registered, running: registered });
    },
    readDefinition: () => {
      if (options.definitionErrors?.has(canonicalTaskName(taskName)) === true) {
        return Effect.fail(new Error("definition denied"));
      }
      const definition =
        taskName === options.owned?.receipt.taskName
          ? options.owned.definition
          : options.taskDefinitions?.get(canonicalTaskName(taskName));
      return Effect.succeed(definition ?? null);
    },
    start: () => mutation(mutations, "task:start"),
  });
  const store: WindowsServiceInstallationStoreWithLegacyCleanup = {
    createLegacyCleanup: () => mutation(mutations, "legacy-cleanup:create"),
    createReceipt: () => mutation(mutations, "receipt:create"),
    persistReceipt: () => mutation(mutations, "receipt:persist"),
    prepareServerControl: () => mutation(mutations, "server-control:prepare"),
    readReceipt: () => Effect.succeed(options.owned?.receipt ?? null),
    readLegacyCleanup: () => Effect.succeed(null),
    removeLegacyCleanup: () => mutation(mutations, "legacy-cleanup:remove"),
    removeReceiptAfterCleanup: () => mutation(mutations, "receipt:remove"),
    resolveCurrentUserSid: () => Effect.succeed(sid),
    requireLegacyCleanup: () => mutation(mutations, "legacy-cleanup:require"),
    writeReceipt: () => mutation(mutations, "receipt:write"),
  };
  const controller = serviceFromLayer(
    WindowsInstallationController,
    makeWindowsInstallationControllerLayer({
      artifacts: {
        read: (path) => Effect.succeed(options.owned?.files.get(path) ?? null),
        removeMatching: () => mutation(mutations, "artifact:remove"),
        write: () => mutation(mutations, "artifact:write"),
      },
      schedulerFor,
      store,
    }),
  );
  return { controller, mutations };
}

describe("Windows receipt-less install-scoped task detection", () => {
  it("refuses one canonicalized orphan without querying, adopting, or deleting it", async () => {
    const taskName = `/SELFTUNEDAEMON-${firstInstallId.toUpperCase()}`;
    const test = harness({
      taskDefinitions: taskDefinitions([[taskName, scopedTaskDefinition(firstInstallId)]]),
      taskNames: [taskName],
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Refused",
      reason: `untracked-installation-task-present:\\selftunedaemon-${firstInstallId}`,
      task: { registered: true, running: false },
    });
    await expect(Effect.runPromise(test.controller.install(plan))).rejects.toMatchObject({
      operation: "install",
    });
    expect(test.mutations).toEqual([]);
  });

  it("refuses multiple orphan generations as ambiguous evidence", async () => {
    const firstTaskName = `/selftunedaemon-${firstInstallId}`;
    const secondTaskName = `\\SelfTuneDaemon-${secondInstallId}`;
    const test = harness({
      taskDefinitions: taskDefinitions([
        [firstTaskName, scopedTaskDefinition(firstInstallId)],
        [secondTaskName, scopedTaskDefinition(secondInstallId)],
      ]),
      taskNames: [secondTaskName, firstTaskName],
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Refused",
      reason: `multiple-untracked-installation-tasks-present:\\selftunedaemon-${firstInstallId},\\selftunedaemon-${secondInstallId}`,
    });
    expect(test.mutations).toEqual([]);
  });

  it("refuses an extra generation beside the exact receipted task", async () => {
    const owned = ownedFixture();
    const test = harness({
      owned,
      taskDefinitions: taskDefinitions([
        [`\\SelfTuneDaemon-${secondInstallId}`, scopedTaskDefinition(secondInstallId)],
      ]),
      taskNames: [`\\${owned.receipt.taskName}`, `\\SelfTuneDaemon-${secondInstallId}`],
    });

    await expect(Effect.runPromise(test.controller.status(plan))).resolves.toMatchObject({
      _tag: "Refused",
      reason: `untracked-installation-task-present:\\selftunedaemon-${secondInstallId}`,
    });
    await expect(Effect.runPromise(test.controller.stop(plan))).rejects.toMatchObject({
      operation: "stop",
    });
    expect(test.mutations).toEqual([]);
  });

  it("accepts the exact receipted generation when no additional task exists", async () => {
    const owned = ownedFixture();
    const test = harness({
      owned,
      taskNames: [`/${owned.receipt.taskName.toUpperCase()}`],
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Owned",
      receipt: { installId: firstInstallId },
    });
    expect(test.mutations).toEqual([]);
  });

  it("ignores valid SelfTune tasks belonging to another Windows user", async () => {
    const firstTaskName = `\\SelfTuneDaemon-${firstInstallId}`;
    const test = harness({
      taskDefinitions: taskDefinitions([
        [firstTaskName, scopedTaskDefinition(firstInstallId, { userSid: "S-1-5-21-9999" })],
      ]),
      taskNames: [firstTaskName],
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Absent",
    });
    expect(test.mutations).toEqual([]);
  });

  it("refuses current-user tasks despite other config, command, and settings", async () => {
    const taskName = `\\SelfTuneDaemon-${secondInstallId}`;
    const tamperedDefinition = scopedTaskDefinition(secondInstallId, {
      configDir: "D:\\Other\\.selftune",
    })
      .replace("wscript.exe", "cscript.exe")
      .replace("IgnoreNew", "Parallel");
    const test = harness({
      taskDefinitions: taskDefinitions([[taskName, tamperedDefinition]]),
      taskNames: [taskName],
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Refused",
      reason: `untracked-installation-task-present:\\selftunedaemon-${secondInstallId}`,
    });
    expect(test.mutations).toEqual([]);
  });

  it("fails closed on malformed or unreadable candidate principal evidence", async () => {
    const malformedName = `\\SelfTuneDaemon-${firstInstallId}`;
    const malformed = harness({
      taskDefinitions: taskDefinitions([[malformedName, "<Task><Principals></Task>"]]),
      taskNames: [malformedName],
    });
    await expect(Effect.runPromise(malformed.controller.inspect(plan))).rejects.toMatchObject({
      operation: "inspect-untracked-task-principal",
    });
    expect(malformed.mutations).toEqual([]);

    const unreadableName = `\\SelfTuneDaemon-${secondInstallId}`;
    const unreadable = harness({
      definitionErrors: new Set([canonicalTaskName(unreadableName)]),
      taskNames: [unreadableName],
    });
    await expect(Effect.runPromise(unreadable.controller.inspect(plan))).rejects.toMatchObject({
      operation: "read-untracked-task-definition",
    });
    expect(unreadable.mutations).toEqual([]);
  });

  it("ignores fixed legacy, nested, and invalid UUID lookalikes", async () => {
    const test = harness({
      taskNames: [
        "\\SelfTuneDaemon",
        `\\Folder\\SelfTuneDaemon-${firstInstallId}`,
        "\\SelfTuneDaemon-30303030-3030-1030-8030-303030303030",
        `\\SelfTuneDaemon-${firstInstallId}-backup`,
        `\\SelfTuneDaemon-copy-${firstInstallId}`,
      ],
    });

    await expect(Effect.runPromise(test.controller.inspect(plan))).resolves.toMatchObject({
      _tag: "Absent",
    });
    expect(test.mutations).toEqual([]);
  });

  it("fails closed when the locale-independent inventory cannot be read", async () => {
    const test = harness({ inventoryError: true, taskNames: [] });

    await expect(Effect.runPromise(test.controller.inspect(plan))).rejects.toMatchObject({
      operation: "inventory-service-tasks",
    });
    expect(test.mutations).toEqual([]);
  });
});
