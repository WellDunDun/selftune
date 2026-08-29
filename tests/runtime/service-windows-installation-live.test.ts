import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  makeLiveWindowsInstallationFileSystem,
  makeLiveWindowsServiceInstallationArtifactStore,
  makeLiveWindowsServiceInstallationStore,
  type LiveWindowsServiceInstallationArtifactFile,
  type LiveWindowsServiceInstallationArtifactFileSystem,
  type LiveWindowsInstallationFileSystemDependencies,
} from "@selftune/local/service/windows/installation/live";
import { windowsServiceArtifactQuarantinePath } from "@selftune/local/service/windows/artifact-store";
import { sha256Hex } from "@selftune/local/service/windows/installation/model";
import type {
  WindowsInstallationCommandResult,
  WindowsInstallationProcess,
} from "@selftune/local/service/windows/installation/store";

const temporaryDirectories = new Set<string>();
const generation = "10101010-1010-4010-9010-101010101010";

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "selftune-windows-installation-live-"));
  temporaryDirectories.add(path);
  return path;
}

function commandResult(code = 0, stdout = "", stderr = ""): WindowsInstallationCommandResult {
  return { code, stderr, stdout };
}

function installationFileSystemWithFile(
  file: LiveWindowsServiceInstallationArtifactFile,
  events: string[],
): LiveWindowsInstallationFileSystemDependencies {
  return {
    makeDirectory: async (path) => {
      events.push(`mkdir:${path}`);
    },
    openExclusive: async (path, mode) => {
      events.push(`open:${path}:${mode.toString(8)}`);
      return file;
    },
    readUtf8File: async () => "",
    remove: async () => undefined,
    rename: async (from, to) => {
      events.push(`rename:${from}:${to}`);
    },
  };
}

function artifactFileSystem(
  renameArtifact: (from: string, to: string) => Promise<void> = rename,
): LiveWindowsServiceInstallationArtifactFileSystem {
  return {
    link,
    openExclusive: (path, mode) => open(path, "wx", mode),
    read: (path) => readFile(path),
    remove: unlink,
    rename: renameArtifact,
  };
}

async function expectFailureCause(
  effect: Effect.Effect<void, unknown>,
  expectedFailures: ReadonlyArray<unknown>,
): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual(
    expectedFailures,
  );
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) => rm(path, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe("live Windows service installation dependencies", () => {
  it("reads and writes artifact bytes exclusively with mode 0600", async () => {
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore();
    const directory = await temporaryDirectory();
    const path = join(directory, "installation-id-daemon.cmd");
    const contents = new Uint8Array([0, 1, 2, 127, 128, 255]);

    await Effect.runPromise(artifacts.write(path, contents));

    await expect(Effect.runPromise(artifacts.read(path))).resolves.toEqual(contents);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      Effect.runPromise(artifacts.write(path, new Uint8Array([9]))),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(new Uint8Array(await readFile(path))).toEqual(contents);
  });

  it("returns null only for a missing artifact and preserves other read failures", async () => {
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore();
    const directory = await temporaryDirectory();

    await expect(Effect.runPromise(artifacts.read(join(directory, "missing")))).resolves.toBeNull();
    await expect(Effect.runPromise(artifacts.read(directory))).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("quarantines matching artifacts idempotently", async () => {
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore();
    const directory = await temporaryDirectory();
    const path = join(directory, "installation-id-daemon.vbs");

    const contents = new Uint8Array([1]);
    const removal = { artifact: { path, sha256: sha256Hex(contents) }, generation };
    await Effect.runPromise(artifacts.write(path, contents));
    await Effect.runPromise(artifacts.removeMatching(removal));
    await expect(Effect.runPromise(artifacts.removeMatching(removal))).resolves.toBeUndefined();
  });

  it("restores mismatched bytes and never overwrites a replacement", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "installation-id-daemon.cmd");
    const quarantinePath = windowsServiceArtifactQuarantinePath(path, generation);
    const expected = new Uint8Array([1]);
    const foreign = new Uint8Array([9]);
    const replacement = new Uint8Array([7]);
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore();

    await writeFile(path, foreign);
    await expect(
      Effect.runPromise(
        artifacts.removeMatching({ artifact: { path, sha256: sha256Hex(expected) }, generation }),
      ),
    ).rejects.toThrow("changed before quarantine");
    expect(new Uint8Array(await readFile(path))).toEqual(foreign);
    await expect(readFile(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });

    await rename(path, quarantinePath);
    await writeFile(path, replacement);
    await expect(
      Effect.runPromise(
        artifacts.removeMatching({ artifact: { path, sha256: sha256Hex(expected) }, generation }),
      ),
    ).rejects.toThrow("changed before quarantine");
    expect(new Uint8Array(await readFile(path))).toEqual(replacement);
    expect(new Uint8Array(await readFile(quarantinePath))).toEqual(foreign);
  });

  it("recovers a matching crash quarantine but fails closed on a replacement", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "installation-id-daemon.cmd");
    const quarantinePath = windowsServiceArtifactQuarantinePath(path, generation);
    const expected = new Uint8Array([1]);
    const replacement = new Uint8Array([7]);
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore();

    await writeFile(quarantinePath, expected);
    await writeFile(path, replacement);
    await expect(
      Effect.runPromise(
        artifacts.removeMatching({ artifact: { path, sha256: sha256Hex(expected) }, generation }),
      ),
    ).rejects.toThrow("changed before quarantine");

    expect(new Uint8Array(await readFile(path))).toEqual(replacement);
    await expect(readFile(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement created after the atomic quarantine move", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "installation-id-daemon.cmd");
    const expected = new Uint8Array([1]);
    const replacement = new Uint8Array([7]);
    const fileSystem = artifactFileSystem(async (from, to) => {
      await rename(from, to);
      await writeFile(from, replacement);
    });
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore(fileSystem);
    await writeFile(path, expected);

    await expect(
      Effect.runPromise(
        artifacts.removeMatching({ artifact: { path, sha256: sha256Hex(expected) }, generation }),
      ),
    ).rejects.toThrow("changed before quarantine");

    expect(new Uint8Array(await readFile(path))).toEqual(replacement);
  });

  it("bounds retries when matching bytes keep reappearing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "installation-id-daemon.cmd");
    const expected = new Uint8Array([1]);
    let moves = 0;
    const fileSystem = artifactFileSystem(async (from, to) => {
      moves += 1;
      await rename(from, to);
      await writeFile(from, expected);
    });
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore(fileSystem);
    await writeFile(path, expected);

    await expect(
      Effect.runPromise(
        artifacts.removeMatching({ artifact: { path, sha256: sha256Hex(expected) }, generation }),
      ),
    ).rejects.toThrow("removal did not stabilize");

    expect(moves).toBe(3);
    expect(new Uint8Array(await readFile(path))).toEqual(expected);
  });

  it("writes every byte, fsyncs, and closes the handle", async () => {
    const writes: Array<{ readonly length: number; readonly offset: number }> = [];
    let closed = 0;
    let synced = 0;
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => {
        closed += 1;
      },
      sync: async () => {
        synced += 1;
      },
      write: async (_contents, offset, length) => {
        writes.push({ length, offset });
        return { bytesWritten: Math.min(length, 2) };
      },
    };
    const fileSystem: LiveWindowsServiceInstallationArtifactFileSystem = {
      link: async () => undefined,
      openExclusive: async () => file,
      read: async () => new Uint8Array(),
      remove: async () => undefined,
      rename: async () => undefined,
    };
    const artifacts = makeLiveWindowsServiceInstallationArtifactStore(fileSystem);

    await Effect.runPromise(artifacts.write("artifact", new Uint8Array([1, 2, 3, 4, 5])));

    expect(writes).toEqual([
      { length: 5, offset: 0 },
      { length: 3, offset: 2 },
      { length: 1, offset: 4 },
    ]);
    expect(synced).toBe(1);
    expect(closed).toBe(1);
  });

  it("closes the handle and preserves write and close failures", async () => {
    const writeFailure = new Error("write denied");
    let closedAfterWriteFailure = 0;
    const failedWriteFile: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => {
        closedAfterWriteFailure += 1;
      },
      sync: async () => undefined,
      write: async () => Promise.reject(writeFailure),
    };
    const failedWriteFileSystem: LiveWindowsServiceInstallationArtifactFileSystem = {
      link: async () => undefined,
      openExclusive: async () => failedWriteFile,
      read: async () => new Uint8Array(),
      remove: async () => undefined,
      rename: async () => undefined,
    };
    const writeArtifacts = makeLiveWindowsServiceInstallationArtifactStore(failedWriteFileSystem);

    await expect(
      Effect.runPromise(writeArtifacts.write("artifact", new Uint8Array([1]))),
    ).rejects.toBe(writeFailure);
    expect(closedAfterWriteFailure).toBe(1);

    const closeFailure = new Error("close denied");
    const failedCloseFile: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => Promise.reject(closeFailure),
      sync: async () => undefined,
      write: async (_contents, _offset, length) => ({ bytesWritten: length }),
    };
    const failedCloseFileSystem: LiveWindowsServiceInstallationArtifactFileSystem = {
      link: async () => undefined,
      openExclusive: async () => failedCloseFile,
      read: async () => new Uint8Array(),
      remove: async () => undefined,
      rename: async () => undefined,
    };
    const closeArtifacts = makeLiveWindowsServiceInstallationArtifactStore(failedCloseFileSystem);

    await expect(
      Effect.runPromise(closeArtifacts.write("artifact", new Uint8Array([1]))),
    ).rejects.toBe(closeFailure);
  });

  it("fully writes and syncs a receipt temp before close and rename", async () => {
    const events: string[] = [];
    const writes: Array<{ readonly length: number; readonly offset: number }> = [];
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => {
        events.push("close");
      },
      sync: async () => {
        events.push("sync");
      },
      write: async (_contents, offset, length) => {
        writes.push({ length, offset });
        events.push(`write:${offset}`);
        return { bytesWritten: Math.min(length, 2) };
      },
    };
    const fileSystem = makeLiveWindowsInstallationFileSystem(
      installationFileSystemWithFile(file, events),
    );

    await Effect.runPromise(
      fileSystem.writeUtf8File("receipt.tmp", "hello", { flag: "wx", mode: 0o600 }),
    );
    await Effect.runPromise(fileSystem.rename("receipt.tmp", "receipt.json"));

    expect(writes).toEqual([
      { length: 5, offset: 0 },
      { length: 3, offset: 2 },
      { length: 1, offset: 4 },
    ]);
    expect(events).toEqual([
      "open:receipt.tmp:600",
      "write:0",
      "write:2",
      "write:4",
      "sync",
      "close",
      "rename:receipt.tmp:receipt.json",
    ]);
  });

  it("fails a zero-progress receipt write and closes without syncing", async () => {
    const events: string[] = [];
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => {
        events.push("close");
      },
      sync: async () => {
        events.push("sync");
      },
      write: async () => {
        events.push("write");
        return { bytesWritten: 0 };
      },
    };
    const fileSystem = makeLiveWindowsInstallationFileSystem(
      installationFileSystemWithFile(file, events),
    );

    await expect(
      Effect.runPromise(
        fileSystem.writeUtf8File("receipt.tmp", "receipt", { flag: "wx", mode: 0o600 }),
      ),
    ).rejects.toThrow("Windows service installation file write made no progress");
    expect(events).toEqual(["open:receipt.tmp:600", "write", "close"]);
  });

  it("closes a receipt temp when sync fails", async () => {
    const events: string[] = [];
    const syncFailure = new Error("sync denied");
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => {
        events.push("close");
      },
      sync: async () => {
        events.push("sync");
        throw syncFailure;
      },
      write: async (_contents, _offset, length) => {
        events.push("write");
        return { bytesWritten: length };
      },
    };
    const fileSystem = makeLiveWindowsInstallationFileSystem(
      installationFileSystemWithFile(file, events),
    );

    await expect(
      Effect.runPromise(
        fileSystem.writeUtf8File("receipt.tmp", "receipt", { flag: "wx", mode: 0o600 }),
      ),
    ).rejects.toBe(syncFailure);
    expect(events).toEqual(["open:receipt.tmp:600", "write", "sync", "close"]);
  });

  it("preserves both write and close failures in the Effect cause", async () => {
    const writeFailure = new Error("write denied");
    const closeFailure = new Error("close denied");
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => Promise.reject(closeFailure),
      sync: async () => undefined,
      write: async () => Promise.reject(writeFailure),
    };
    const fileSystem = makeLiveWindowsInstallationFileSystem(
      installationFileSystemWithFile(file, []),
    );

    await expectFailureCause(
      fileSystem.writeUtf8File("receipt.tmp", "receipt", { flag: "wx", mode: 0o600 }),
      [writeFailure, closeFailure],
    );
  });

  it("preserves both sync and close failures in the Effect cause", async () => {
    const syncFailure = new Error("sync denied");
    const closeFailure = new Error("close denied");
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => Promise.reject(closeFailure),
      sync: async () => Promise.reject(syncFailure),
      write: async (_contents, _offset, length) => ({ bytesWritten: length }),
    };
    const fileSystem = makeLiveWindowsInstallationFileSystem(
      installationFileSystemWithFile(file, []),
    );

    await expectFailureCause(
      fileSystem.writeUtf8File("receipt.tmp", "receipt", { flag: "wx", mode: 0o600 }),
      [syncFailure, closeFailure],
    );
  });

  it("finishes non-cancellable receipt I/O before closing an interrupted write", async () => {
    const events: string[] = [];
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ readonly bytesWritten: number }>();
    let writeCount = 0;
    const file: LiveWindowsServiceInstallationArtifactFile = {
      close: async () => {
        events.push("close");
      },
      sync: async () => {
        events.push("sync");
      },
      write: async (_contents, offset, length) => {
        events.push(`write:${offset}`);
        writeCount += 1;
        if (writeCount === 1) {
          entered.resolve();
          return pending.promise;
        }
        return { bytesWritten: length };
      },
    };
    const fileSystem = makeLiveWindowsInstallationFileSystem(
      installationFileSystemWithFile(file, events),
    );
    const fiber = Effect.runFork(
      fileSystem.writeUtf8File("receipt.tmp", "receipt", { flag: "wx", mode: 0o600 }),
    );
    await entered.promise;

    let interrupted = false;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interrupted = true;
      return interrupted;
    });
    await Promise.resolve();
    expect(interrupted).toBe(false);
    expect(events).toEqual(["open:receipt.tmp:600", "write:0"]);

    pending.resolve({ bytesWritten: 2 });
    await interruption;

    expect(events).toEqual(["open:receipt.tmp:600", "write:0", "write:2", "sync", "close"]);
  });

  it("returns null only for a missing file and preserves other read failures", async () => {
    const fileSystem = makeLiveWindowsInstallationFileSystem();
    const directory = await temporaryDirectory();

    await expect(
      Effect.runPromise(fileSystem.readUtf8File(join(directory, "missing.json"))),
    ).resolves.toBeNull();
    await expect(Effect.runPromise(fileSystem.readUtf8File(directory))).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("creates directories recursively and writes receipt temps exclusively with mode 0600", async () => {
    const fileSystem = makeLiveWindowsInstallationFileSystem();
    const directory = await temporaryDirectory();
    const nestedDirectory = join(directory, "server-control", "receipts");
    const receiptTemp = join(nestedDirectory, "receipt.tmp");

    await Effect.runPromise(fileSystem.makeDirectory(nestedDirectory));
    await Effect.runPromise(
      fileSystem.writeUtf8File(receiptTemp, "first", { flag: "wx", mode: 0o600 }),
    );

    await expect(
      Effect.runPromise(
        fileSystem.writeUtf8File(receiptTemp, "replacement", { flag: "wx", mode: 0o600 }),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(receiptTemp, "utf8")).toBe("first");
    expect((await stat(receiptTemp)).mode & 0o777).toBe(0o600);
  });

  it("renames atomically and removes files idempotently without masking other failures", async () => {
    const fileSystem = makeLiveWindowsInstallationFileSystem();
    const directory = await temporaryDirectory();
    const source = join(directory, "receipt.tmp");
    const destination = join(directory, "receipt.json");

    await Effect.runPromise(
      fileSystem.writeUtf8File(source, "receipt", { flag: "wx", mode: 0o600 }),
    );
    await Effect.runPromise(fileSystem.rename(source, destination));
    expect(await readFile(destination, "utf8")).toBe("receipt");

    await Effect.runPromise(fileSystem.removeFile(destination));
    await expect(Effect.runPromise(fileSystem.removeFile(destination))).resolves.toBeUndefined();

    await chmod(directory, 0o500);
    try {
      await expect(Effect.runPromise(fileSystem.removeFile(directory))).rejects.toMatchObject({
        // Node reports EPERM on macOS and EISDIR on Linux for unlinking a directory.
        code: expect.stringMatching(/^(?:EISDIR|EPERM)$/),
      });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("passes the injected process executor and SystemRoot through to SID resolution", async () => {
    const calls: Array<{ readonly args: ReadonlyArray<string>; readonly command: string }> = [];
    const process: WindowsInstallationProcess = {
      execute: (command, args) =>
        Effect.sync(() => {
          calls.push({ args, command });
          return commandResult(0, '"WORKGROUP\\Test","S-1-5-21-1000-2000-3000-4000"\r\n');
        }),
    };
    const store = makeLiveWindowsServiceInstallationStore({
      process,
      systemRoot: "D:\\Windows",
    });

    await expect(Effect.runPromise(store.resolveCurrentUserSid())).resolves.toBe(
      "S-1-5-21-1000-2000-3000-4000",
    );
    expect(calls).toEqual([
      {
        args: ["/user", "/fo", "csv", "/nh"],
        command: "D:\\Windows\\System32\\whoami.exe",
      },
    ]);
  });
});
