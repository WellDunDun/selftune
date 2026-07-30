import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import { sha256Hex } from "@selftune/local/service/windows/installation/model";
import {
  makeWindowsServiceInstallationStore,
  type WindowsInstallationCommandResult,
  type WindowsInstallationFileSystem,
} from "@selftune/local/service/windows/installation/store";
import {
  createWindowsServiceLegacyCleanupJournal,
  decodeWindowsServiceLegacyCleanupJournal,
  expectWindowsServiceLegacyCleanup,
  windowsServiceLegacyCleanupPath,
  type WindowsServiceLegacyCleanupJournalInput,
} from "@selftune/local/service/windows/installation/legacy-cleanup";

const configDir = "C:\\Users\\Test\\.selftune";
const controlDir = `${configDir}\\server-control`;
const userSid = "S-1-5-21-1000-2000-3000-4000";
const journalPath = windowsServiceLegacyCleanupPath(configDir);
const input: WindowsServiceLegacyCleanupJournalInput = {
  artifacts: {
    launcher: {
      path: `${controlDir}\\run-daemon.vbs`,
      sha256: sha256Hex("launcher"),
    },
    taskDefinition: {
      path: `${controlDir}\\run-daemon.xml`,
      sha256: sha256Hex("task-definition"),
    },
    wrapper: {
      path: `${controlDir}\\run-daemon.cmd`,
      sha256: sha256Hex("wrapper"),
    },
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
  userSid,
  wscriptPath: "wscript.exe",
};
const metadata = {
  cleanupId: "10101010-1010-4010-9010-101010101010",
  createdAt: "2026-07-17T12:30:00.000Z",
};

interface JournalHarnessOptions {
  readonly replaceAfterRename?: (contents: string) => string;
  readonly removeFailure?: boolean;
  readonly renameFailure?: boolean;
}

function commandResult(code = 0, stdout = "", stderr = ""): WindowsInstallationCommandResult {
  return { code, stderr, stdout };
}

function journalHarness(options: JournalHarnessOptions = {}) {
  const files = new Map<string, string>();
  const events: string[] = [];
  const fileSystem: WindowsInstallationFileSystem = {
    makeDirectory: (path) =>
      Effect.sync(() => {
        events.push(`mkdir:${path}`);
      }),
    readUtf8File: (path) =>
      Effect.sync(() => {
        events.push(`read:${path}`);
        return files.get(path) ?? null;
      }),
    removeFile: (path) =>
      Effect.try({
        try: () => {
          events.push(`remove:${path}`);
          if (options.removeFailure && path === journalPath) throw new Error("remove denied");
          files.delete(path);
        },
        catch: (cause) => cause,
      }),
    rename: (from, to) =>
      Effect.try({
        try: () => {
          events.push(`rename:${from}:${to}`);
          if (options.renameFailure) throw new Error("rename denied");
          const contents = files.get(from);
          if (contents === undefined) throw new Error("missing temp journal");
          files.delete(from);
          files.set(to, options.replaceAfterRename?.(contents) ?? contents);
        },
        catch: (cause) => cause,
      }),
    writeUtf8File: (path, contents) =>
      Effect.try({
        try: () => {
          events.push(`write:${path}`);
          if (files.has(path)) throw new Error("exclusive create denied");
          files.set(path, contents);
        },
        catch: (cause) => cause,
      }),
  };
  const store = makeWindowsServiceInstallationStore({
    clock: { now: () => Effect.succeed(new Date(metadata.createdAt)) },
    fileSystem,
    process: {
      execute: (command) =>
        Effect.succeed(
          command.endsWith("whoami.exe")
            ? commandResult(0, `"WORKGROUP\\Test","${userSid}"\r\n`)
            : commandResult(0, "SELFTUNE_ACL_VERIFIED_V1\r\n"),
        ),
    },
    random: { bytes: (length) => Effect.succeed(new Uint8Array(length).fill(16)) },
    systemRoot: "C:\\Windows",
  });
  return { events, files, store };
}

describe("Windows legacy cleanup journal", () => {
  it("accepts only the SID-bound fixed-name legacy cleanup authority", () => {
    const journal = createWindowsServiceLegacyCleanupJournal(input, metadata);
    expect(decodeWindowsServiceLegacyCleanupJournal(JSON.parse(JSON.stringify(journal)))).toEqual(
      journal,
    );

    const invalid = [
      { ...journal, userSid: userSid.toLowerCase() },
      { ...journal, taskName: "ForeignTask" },
      { ...journal, wscriptPath: "C:\\Windows\\wscript.exe" },
      {
        ...journal,
        runtimeIdentity: { ...journal.runtimeIdentity, configDir: "C:\\Other" },
      },
      {
        ...journal,
        artifacts: {
          ...journal.artifacts,
          wrapper: { ...journal.artifacts.wrapper, path: `${controlDir}\\other.cmd` },
        },
      },
    ];
    for (const candidate of invalid) {
      expect(() => decodeWindowsServiceLegacyCleanupJournal(candidate)).toThrow();
    }
  });

  it("syncs through the existing file seam, promotes atomically, and verifies the full payload", async () => {
    const test = journalHarness();
    const journal = await Effect.runPromise(test.store.createLegacyCleanup(input));
    expect(journal).toMatchObject({
      cleanupId: metadata.cleanupId,
      kind: "selftune-windows-legacy-cleanup",
      userSid,
      version: 1,
    });
    const writeIndex = test.events.findIndex((event) => event.startsWith("write:"));
    const renameIndex = test.events.findIndex((event) => event.startsWith("rename:"));
    expect(writeIndex).toBeGreaterThan(-1);
    expect(renameIndex).toBeGreaterThan(writeIndex);
    expect(await Effect.runPromise(test.store.readLegacyCleanup(configDir))).toEqual(journal);

    const changed = { ...journal, initiatedBy: "uninstall" };
    test.files.set(journalPath, `${JSON.stringify(changed)}\n`);
    await expect(
      Effect.runPromise(
        test.store.requireLegacyCleanup(
          configDir,
          expectWindowsServiceLegacyCleanup(journal),
          "test-generation",
        ),
      ),
    ).rejects.toMatchObject({ operation: "test-generation" });
  });

  it("does not acknowledge a substituted promotion and cleans its temp file", async () => {
    const test = journalHarness({
      replaceAfterRename: (contents) =>
        contents.replace('"initiatedBy":"install"', '"initiatedBy":"uninstall"'),
    });
    await expect(Effect.runPromise(test.store.createLegacyCleanup(input))).rejects.toMatchObject({
      operation: "verify-promoted-legacy-cleanup-generation",
    });
    expect([...test.files.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("rereads the exact generation immediately before unlink and removes the journal last", async () => {
    const test = journalHarness();
    const journal = await Effect.runPromise(test.store.createLegacyCleanup(input));
    test.events.length = 0;
    await Effect.runPromise(
      test.store.removeLegacyCleanup(configDir, expectWindowsServiceLegacyCleanup(journal)),
    );
    expect(test.events).toEqual([
      `read:${journalPath}`,
      `remove:${journalPath}`,
      `read:${journalPath}`,
    ]);
    expect(test.files.has(journalPath)).toBe(false);
  });

  it("keeps a fully verified journal when unlink fails", async () => {
    const test = journalHarness({ removeFailure: true });
    const journal = await Effect.runPromise(test.store.createLegacyCleanup(input));
    await expect(
      Effect.runPromise(
        test.store.removeLegacyCleanup(configDir, expectWindowsServiceLegacyCleanup(journal)),
      ),
    ).rejects.toMatchObject({ operation: "remove-legacy-cleanup" });
    expect(await Effect.runPromise(test.store.readLegacyCleanup(configDir))).toEqual(journal);
  });
});
