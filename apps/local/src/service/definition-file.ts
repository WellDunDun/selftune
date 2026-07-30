import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import * as Effect from "effect/Effect";

import { serviceFailure, type ServiceFailure } from "../service-contract.js";

export interface ServiceDefinitionFileReplacement {
  readonly contents: string;
  readonly operation: "write-launchd-plist" | "write-systemd-unit";
  readonly path: string;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

const DEFINITION_MODE = 0o600;
const POSIX = process.platform !== "win32";

function fileIdentity(stats: BigIntStats): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function sameFile(left: FileIdentity, right: BigIntStats): boolean {
  return left.device === right.dev && left.inode === right.ino;
}

function currentEffectiveUid(): bigint {
  if (typeof process.geteuid !== "function") {
    throw new Error("The current effective user ID is unavailable.");
  }
  return BigInt(process.geteuid());
}

function verifyDefinitionFile(
  path: string,
  stats: BigIntStats,
  expectedIdentity?: FileIdentity,
): void {
  if (!stats.isFile()) throw new Error(`Service definition is not a regular file: ${path}`);
  if (stats.nlink !== 1n) {
    throw new Error(`Service definition must have exactly one hard link: ${path}`);
  }
  if (expectedIdentity !== undefined && !sameFile(expectedIdentity, stats)) {
    throw new Error(`Service definition file identity changed: ${path}`);
  }
  if (!POSIX) return;
  if ((stats.mode & 0o777n) !== BigInt(DEFINITION_MODE)) {
    throw new Error(`Service definition mode is not 0600: ${path}`);
  }
  if (stats.uid !== currentEffectiveUid()) {
    throw new Error(`Service definition is not owned by the current effective user: ${path}`);
  }
}

function isUnsupportedDirectorySync(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false;
  return cause.code === "EINVAL" || cause.code === "ENOTSUP";
}

function syncParentDirectory(path: string): void {
  if (!POSIX) return;
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, flags);
    fsyncSync(descriptor);
  } catch (cause) {
    if (!isUnsupportedDirectorySync(cause)) throw cause;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, contents: Uint8Array): void {
  let offset = 0;
  while (offset < contents.byteLength) {
    const written = writeSync(descriptor, contents, offset, contents.byteLength - offset, offset);
    if (written === 0) throw new Error("Service definition write made no progress.");
    offset += written;
  }
}

function cleanupOwnedTemporary(path: string, identity: FileIdentity | null): void {
  if (identity === null) return;
  try {
    const current = lstatSync(path, { bigint: true });
    if (sameFile(identity, current)) unlinkSync(path);
  } catch {
    // Cleanup is best-effort and may remove only the exact file created by this operation.
  }
}

function replaceDefinitionFile(replacement: ServiceDefinitionFileReplacement): void {
  const parent = dirname(replacement.path);
  const temporary = join(
    parent,
    `.${basename(replacement.path)}.selftune-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (POSIX ? (constants.O_NOFOLLOW ?? 0) : 0);
  let descriptor: number | null = null;
  let identity: FileIdentity | null = null;
  let renamed = false;
  try {
    descriptor = openSync(temporary, flags, DEFINITION_MODE);
    const opened = fstatSync(descriptor, { bigint: true });
    identity = fileIdentity(opened);
    if (POSIX) fchmodSync(descriptor, DEFINITION_MODE);
    writeAll(descriptor, Buffer.from(replacement.contents, "utf8"));
    fsyncSync(descriptor);
    verifyDefinitionFile(temporary, fstatSync(descriptor, { bigint: true }), identity);
    verifyDefinitionFile(temporary, lstatSync(temporary, { bigint: true }), identity);
    closeSync(descriptor);
    descriptor = null;

    renameSync(temporary, replacement.path);
    renamed = true;
    verifyDefinitionFile(replacement.path, lstatSync(replacement.path, { bigint: true }), identity);
    syncParentDirectory(parent);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the replacement failure; the owned temp is handled below.
      }
    }
    if (!renamed) cleanupOwnedTemporary(temporary, identity);
  }
}

export const replaceServiceDefinitionFile = Effect.fn("SelfTuneService.definitionFile.replace")(
  (replacement: ServiceDefinitionFileReplacement): Effect.Effect<void, ServiceFailure> =>
    Effect.try({
      try: () => replaceDefinitionFile(replacement),
      catch: (cause) => serviceFailure(replacement.operation, cause),
    }),
);
