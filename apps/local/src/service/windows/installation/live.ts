import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import {
  makeWindowsInstallationStoreLayer,
  type WindowsInstallationFileSystem,
  type WindowsInstallationProcess,
} from "./store.js";
import {
  windowsServiceArtifactQuarantinePath,
  type WindowsServiceArtifactRemoval,
  type WindowsServiceInstallationArtifactStore,
} from "../artifact-store.js";
import { sha256Hex } from "./model.js";
import { WindowsInstallationIOError } from "./io-error.js";

export interface LiveWindowsServiceInstallationStoreOptions {
  readonly process: WindowsInstallationProcess;
  readonly systemRoot?: string;
}

export interface LiveWindowsServiceInstallationFile {
  readonly close: () => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly write: (
    contents: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesWritten: number }>;
}

export type LiveWindowsServiceInstallationArtifactFile = LiveWindowsServiceInstallationFile;

export interface LiveWindowsServiceInstallationArtifactFileSystem {
  readonly link: (from: string, to: string) => Promise<void>;
  readonly openExclusive: (
    path: string,
    mode: number,
  ) => Promise<LiveWindowsServiceInstallationArtifactFile>;
  readonly read: (path: string) => Promise<Uint8Array>;
  readonly remove: (path: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

export interface LiveWindowsInstallationFileSystemDependencies {
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly openExclusive: (
    path: string,
    mode: number,
  ) => Promise<LiveWindowsServiceInstallationFile>;
  readonly readUtf8File: (path: string) => Promise<string>;
  readonly remove: (path: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

function isMissingFileError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function promiseEffect<A>(
  operation: WindowsInstallationIOError["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, WindowsInstallationIOError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => WindowsInstallationIOError.fromCause(operation, cause),
  });
}

const liveArtifactFileSystem: LiveWindowsServiceInstallationArtifactFileSystem = {
  link: (from, to) => link(from, to),
  openExclusive: (path, mode) => open(path, "wx", mode),
  read: (path) => readFile(path),
  remove: (path) => unlink(path),
  rename: (from, to) => rename(from, to),
};

const liveInstallationFileSystem: LiveWindowsInstallationFileSystemDependencies = {
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  openExclusive: (path, mode) => open(path, "wx", mode),
  readUtf8File: (path) => readFile(path, "utf8"),
  remove: (path) => unlink(path),
  rename: async (from, to) => {
    await rename(from, to);
  },
};

function writeAllAndSync(
  file: LiveWindowsServiceInstallationFile,
  contents: Uint8Array,
): Effect.Effect<void, WindowsInstallationIOError> {
  return Effect.uninterruptible(
    promiseEffect("writeAndSync", async () => {
      let offset = 0;
      while (offset < contents.byteLength) {
        // oxlint-disable-next-line no-await-in-loop -- each short write determines the next offset
        const result = await file.write(contents, offset, contents.byteLength - offset, offset);
        if (result.bytesWritten === 0) {
          throw new Error("Windows service installation file write made no progress");
        }
        offset += result.bytesWritten;
      }
      await file.sync();
    }),
  );
}

function closePreservingUseFailure(
  file: LiveWindowsServiceInstallationFile,
  useExit: Exit.Exit<void, WindowsInstallationIOError>,
): Effect.Effect<void, WindowsInstallationIOError> {
  return promiseEffect("close", () => file.close()).pipe(
    Effect.catchCause((closeCause) =>
      Exit.isFailure(useExit)
        ? Effect.failCause(Cause.combine(useExit.cause, closeCause))
        : Effect.failCause(closeCause),
    ),
  );
}

async function readArtifactOrNull(
  fileSystem: LiveWindowsServiceInstallationArtifactFileSystem,
  path: string,
): Promise<Uint8Array | null> {
  return fileSystem.read(path).catch((cause: unknown) => {
    if (isMissingFileError(cause)) return null;
    throw cause;
  });
}

async function removeArtifactIfPresent(
  fileSystem: LiveWindowsServiceInstallationArtifactFileSystem,
  path: string,
): Promise<void> {
  await fileSystem.remove(path).catch((cause: unknown) => {
    if (!isMissingFileError(cause)) throw cause;
  });
}

async function restoreQuarantinedMismatch(
  fileSystem: LiveWindowsServiceInstallationArtifactFileSystem,
  path: string,
  quarantinePath: string,
  quarantineContents: Uint8Array,
): Promise<void> {
  const current = await readArtifactOrNull(fileSystem, path);
  if (current === null) {
    await fileSystem.link(quarantinePath, path).catch((cause: unknown) => {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    });
  }
  const restored = await readArtifactOrNull(fileSystem, path);
  if (restored !== null && sha256Hex(restored) === sha256Hex(quarantineContents)) {
    await removeArtifactIfPresent(fileSystem, quarantinePath);
  }
}

async function removeMatchingArtifactAttempt(
  fileSystem: LiveWindowsServiceInstallationArtifactFileSystem,
  removal: WindowsServiceArtifactRemoval,
  quarantinePath: string,
  attemptsRemaining: number,
): Promise<void> {
  const { artifact } = removal;
  let quarantineContents = await readArtifactOrNull(fileSystem, quarantinePath);
  if (quarantineContents === null) {
    try {
      await fileSystem.rename(artifact.path, quarantinePath);
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause;
      quarantineContents = await readArtifactOrNull(fileSystem, quarantinePath);
      if (quarantineContents === null) return;
    }
    quarantineContents = await readArtifactOrNull(fileSystem, quarantinePath);
    if (quarantineContents === null) {
      throw new Error(`Quarantined Windows service artifact disappeared: ${artifact.path}.`);
    }
  }
  if (sha256Hex(quarantineContents) !== artifact.sha256) {
    await restoreQuarantinedMismatch(fileSystem, artifact.path, quarantinePath, quarantineContents);
    throw new Error(`Windows service artifact changed before quarantine: ${artifact.path}.`);
  }
  await removeArtifactIfPresent(fileSystem, quarantinePath);
  if (attemptsRemaining > 1) {
    return removeMatchingArtifactAttempt(
      fileSystem,
      removal,
      quarantinePath,
      attemptsRemaining - 1,
    );
  }
  const [remainingSource, remainingQuarantine] = await Promise.all([
    readArtifactOrNull(fileSystem, artifact.path),
    readArtifactOrNull(fileSystem, quarantinePath),
  ]);
  if (remainingSource !== null || remainingQuarantine !== null) {
    throw new Error(`Windows service artifact removal did not stabilize: ${artifact.path}.`);
  }
}

async function removeMatchingArtifact(
  fileSystem: LiveWindowsServiceInstallationArtifactFileSystem,
  removal: WindowsServiceArtifactRemoval,
): Promise<void> {
  const quarantinePath = windowsServiceArtifactQuarantinePath(
    removal.artifact.path,
    removal.generation,
  );
  return removeMatchingArtifactAttempt(fileSystem, removal, quarantinePath, 3);
}

export function makeLiveWindowsServiceInstallationArtifactStore(
  fileSystem: LiveWindowsServiceInstallationArtifactFileSystem = liveArtifactFileSystem,
): WindowsServiceInstallationArtifactStore<WindowsInstallationIOError> {
  return {
    read: (path) =>
      promiseEffect("read", () =>
        fileSystem.read(path).then(
          (contents) => contents,
          (cause: unknown) => (isMissingFileError(cause) ? null : Promise.reject(cause)),
        ),
      ),
    removeMatching: (removal) =>
      Effect.uninterruptible(
        promiseEffect("removeMatching", () => removeMatchingArtifact(fileSystem, removal)),
      ),
    write: (path, contents) =>
      Effect.acquireUseRelease(
        promiseEffect("openExclusive", () => fileSystem.openExclusive(path, 0o600)),
        (file) => writeAllAndSync(file, contents),
        closePreservingUseFailure,
      ),
  };
}

export function makeLiveWindowsInstallationFileSystem(
  fileSystem: LiveWindowsInstallationFileSystemDependencies = liveInstallationFileSystem,
): WindowsInstallationFileSystem<WindowsInstallationIOError> {
  return {
    makeDirectory: (path) => promiseEffect("makeDirectory", () => fileSystem.makeDirectory(path)),
    readUtf8File: (path) =>
      promiseEffect("readUtf8File", () =>
        fileSystem.readUtf8File(path).then(
          (contents) => contents,
          (cause: unknown) => (isMissingFileError(cause) ? null : Promise.reject(cause)),
        ),
      ),
    removeFile: (path) =>
      promiseEffect("removeFile", () =>
        fileSystem.remove(path).then(
          () => undefined,
          (cause: unknown) => (isMissingFileError(cause) ? undefined : Promise.reject(cause)),
        ),
      ),
    rename: (from, to) =>
      // Receipt persistence invokes this after writeUtf8File synced and closed the temp file.
      // Node has no reliable Windows directory fsync, so metadata durability is not claimed.
      promiseEffect("rename", () => fileSystem.rename(from, to)),
    writeUtf8File: (path, contents, options) =>
      Effect.acquireUseRelease(
        promiseEffect("openExclusive", () => fileSystem.openExclusive(path, options.mode)),
        (file) => writeAllAndSync(file, new TextEncoder().encode(contents)),
        closePreservingUseFailure,
      ),
  };
}

export class WindowsInstallationArtifacts extends Context.Service<
  WindowsInstallationArtifacts,
  WindowsServiceInstallationArtifactStore<WindowsInstallationIOError>
>()("SelfTune/WindowsInstallationArtifacts") {}

export const WindowsInstallationArtifactsLive = Layer.sync(WindowsInstallationArtifacts)(() =>
  makeLiveWindowsServiceInstallationArtifactStore(),
);

export function makeLiveWindowsInstallationStoreLayer(
  options: LiveWindowsServiceInstallationStoreOptions,
) {
  return makeWindowsInstallationStoreLayer({
    clock: {
      now: () => Effect.sync(() => new Date()),
    },
    fileSystem: makeLiveWindowsInstallationFileSystem(),
    process: options.process,
    random: {
      bytes: (length) =>
        Effect.try({
          try: () => randomBytes(length),
          catch: (cause) => WindowsInstallationIOError.fromCause("randomBytes", cause),
        }),
    },
    systemRoot: options.systemRoot,
  });
}
