/* oxlint-disable max-lines, no-await-in-loop -- filesystem safety checks and writes are intentionally ordered */
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import * as Effect from "effect/Effect";

import {
  InstallerMaterializationError,
  type DurableInstallStep,
  type InstallerMaterializationFileSystem,
  type OwnedInstallInspection,
  type VerifiedInstallerFile,
} from "./materializer.js";

function fsError(code: string, message: string, path: string | null = null) {
  return InstallerMaterializationError.make({ code, message, path });
}

function effect<A>(code: string, message: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof InstallerMaterializationError
        ? cause
        : fsError(code, `${message} ${cause instanceof Error ? cause.message : String(cause)}`),
  });
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertDerivedSibling(targetPath: string, candidate: string, label: string): void {
  const target = resolve(targetPath);
  const derived = resolve(candidate);
  if (
    !isAbsolute(targetPath) ||
    !isAbsolute(candidate) ||
    targetPath !== targetPath.normalize("NFC") ||
    candidate !== candidate.normalize("NFC") ||
    dirname(target) !== dirname(derived) ||
    derived === target ||
    parse(target).root === target
  ) {
    throw fsError(
      "INSTALL_INTERNAL_PATH_UNSAFE",
      `${label} must be a canonical sibling of the install target.`,
      candidate,
    );
  }
}

async function pathKind(
  path: string,
): Promise<"missing" | "directory" | "file" | "symlink" | "special"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "special";
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return "missing";
    }
    throw cause;
  }
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const kind = await pathKind(cursor);
    if (kind === "missing") break;
    if (kind === "symlink" || kind === "special") {
      throw fsError(
        "INSTALL_PATH_REPARSE_FORBIDDEN",
        "Install mutations cannot cross symlink, junction, reparse, or special ancestors.",
        cursor,
      );
    }
  }
}

interface TreeFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

async function inspectTree(root: string): Promise<ReadonlyArray<TreeFile>> {
  if ((await pathKind(root)) !== "directory") {
    throw fsError("INSTALL_TARGET_UNSAFE", "Expected an ordinary directory.", root);
  }
  const files: TreeFile[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw fsError(
          "INSTALL_SPECIAL_FILE_FORBIDDEN",
          "Installed skill trees may contain only directories and regular files.",
          absolutePath,
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        const bytes = await readFile(absolutePath);
        files.push({ path: relativePath, sha256: digest(bytes), byteLength: bytes.byteLength });
      }
    }
  };
  await visit(root, "");
  return files;
}

function compareFiles(
  actual: ReadonlyArray<TreeFile>,
  expected: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly byteLength?: number;
  }>,
): OwnedInstallInspection {
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const paths = new Set([...actualByPath.keys(), ...expectedByPath.keys()]);
  const driftedPaths = [...paths]
    .filter((path) => {
      const observed = actualByPath.get(path);
      const wanted = expectedByPath.get(path);
      return (
        !observed ||
        !wanted ||
        observed.sha256 !== wanted.sha256 ||
        (wanted.byteLength !== undefined && observed.byteLength !== wanted.byteLength)
      );
    })
    .toSorted();
  return { matches: driftedPaths.length === 0, driftedPaths };
}

async function assertCurrentMatchesPlan(
  targetPath: string,
  expectedBefore: {
    readonly kind: "missing" | "directory";
    readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  },
): Promise<void> {
  const kind = await pathKind(targetPath);
  if (expectedBefore.kind === "missing" && kind !== "missing") {
    throw fsError("INSTALL_TARGET_CHANGED", "The destination appeared after preview.", targetPath);
  }
  if (expectedBefore.kind === "directory") {
    if (kind !== "directory") {
      throw fsError("INSTALL_TARGET_CHANGED", "The destination kind changed.", targetPath);
    }
    const observed = await inspectTree(targetPath);
    const comparison = compareFiles(observed, expectedBefore.files);
    if (!comparison.matches) {
      throw fsError(
        "INSTALL_TARGET_CHANGED",
        "The destination no longer matches the confirmed preview.",
        targetPath,
      );
    }
  }
}

async function writeVerifiedFiles(
  root: string,
  files: ReadonlyArray<VerifiedInstallerFile>,
  assertFence: Parameters<InstallerMaterializationFileSystem["materialize"]>[0]["assertFence"],
): Promise<void> {
  await assertFence.pipe(Effect.runPromise);
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const file of files) {
    const destination = resolve(root, ...file.path.split("/"));
    if (!isInside(root, destination)) {
      throw fsError("INSTALL_PACKAGE_PATH_ESCAPE", "A package file escaped staging.", file.path);
    }
    await assertFence.pipe(Effect.runPromise);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await assertFence.pipe(Effect.runPromise);
    await writeFile(destination, file.bytes, { flag: "wx", mode: 0o644 });
  }
  const staged = await inspectTree(root);
  const comparison = compareFiles(staged, files);
  if (!comparison.matches) {
    throw fsError(
      "INSTALL_STAGING_VERIFICATION_FAILED",
      "Staged bytes do not match the authorized package manifest.",
      root,
    );
  }
}

async function copySnapshot(
  source: string,
  snapshot: string,
  assertFence: Parameters<InstallerMaterializationFileSystem["materialize"]>[0]["assertFence"],
): Promise<void> {
  if ((await pathKind(snapshot)) !== "missing") {
    throw fsError(
      "INSTALL_SNAPSHOT_COLLISION",
      "A durable snapshot path already exists.",
      snapshot,
    );
  }
  await assertFence.pipe(Effect.runPromise);
  await cp(source, snapshot, { recursive: true, dereference: true, errorOnExist: true });
}

async function removeIfPresent(path: string): Promise<void> {
  if ((await pathKind(path)) !== "missing") await rm(path, { recursive: true, force: false });
}

async function inspectReceiptOwned(
  receipt: Parameters<InstallerMaterializationFileSystem["inspectOwned"]>[0],
  targetPath: string = receipt.targetPath,
): Promise<OwnedInstallInspection> {
  await assertNoSymlinkAncestors(dirname(targetPath));
  if (receipt.strategy === "symlink") {
    if ((await pathKind(targetPath)) !== "symlink") {
      return { matches: false, driftedPaths: ["."] };
    }
    const wanted = receipt.files.length > 0 ? receiptSnapshotRoot(receipt) : null;
    const actual = await realpath(targetPath);
    if (!wanted || actual !== wanted) return { matches: false, driftedPaths: ["."] };
    return compareFiles(await inspectTree(actual), receipt.files);
  }
  if ((await pathKind(targetPath)) !== "directory") {
    return { matches: false, driftedPaths: ["."] };
  }
  return compareFiles(await inspectTree(targetPath), receipt.files);
}

function receiptSnapshotRoot(
  receipt: Parameters<InstallerMaterializationFileSystem["inspectOwned"]>[0],
): string | null {
  return receipt.files.reduce<string | null>((common, file) => {
    const suffix = join(...file.path.split("/"));
    const candidate = file.durableSnapshotRef.slice(0, -suffix.length).replace(/[\\/]$/, "");
    return common === null ? candidate : common === candidate ? common : "";
  }, null);
}

export interface NodeInstallerMaterializationHooks {
  readonly beforeSnapshot?: (input: {
    readonly targetPath: string;
    readonly sourcePath: string | null;
    readonly snapshotPath: string;
  }) => Promise<void>;
  readonly afterSnapshot?: (input: {
    readonly targetPath: string;
    readonly sourcePath: string | null;
    readonly snapshotPath: string;
  }) => Promise<void>;
  readonly beforeTargetCapture?: (input: { readonly targetPath: string }) => Promise<void>;
  readonly afterTargetCapture?: (input: {
    readonly targetPath: string;
    readonly rollbackPath: string;
  }) => Promise<void>;
}

/** Concrete Node/Bun adapter; all stateful policy remains behind the filesystem seam. */
export function makeNodeInstallerMaterializationFileSystem(
  hooks: NodeInstallerMaterializationHooks = {},
): InstallerMaterializationFileSystem {
  return {
    materialize: (input) =>
      effect(
        "INSTALL_FILESYSTEM_FAILED",
        "Unable to atomically materialize the skill.",
        async () => {
          assertDerivedSibling(input.targetPath, input.stagingPath, "Staging path");
          assertDerivedSibling(input.targetPath, input.rollbackPath, "Rollback path");
          assertDerivedSibling(input.targetPath, input.snapshotPath, "Snapshot path");
          await assertNoSymlinkAncestors(dirname(input.targetPath));
          await assertCurrentMatchesPlan(input.targetPath, input.expectedBefore);
          if (
            (await pathKind(input.stagingPath)) !== "missing" ||
            (await pathKind(input.snapshotPath)) !== "missing" ||
            (await pathKind(input.rollbackPath)) !== "missing"
          ) {
            throw fsError(
              "INSTALL_INTERNAL_PATH_COLLISION",
              "A staging, snapshot, or rollback path already exists.",
              input.targetPath,
            );
          }
          if (input.strategy === "copy") {
            await writeVerifiedFiles(input.stagingPath, input.files, input.assertFence);
          } else {
            if (!input.sourcePath || !isAbsolute(input.sourcePath)) {
              throw fsError(
                "INSTALL_SYMLINK_SOURCE_INVALID",
                "Symlink installs require an absolute verified local source.",
              );
            }
            await assertNoSymlinkAncestors(input.sourcePath);
            const sourceFiles = await inspectTree(input.sourcePath);
            const sourceComparison = compareFiles(sourceFiles, input.files);
            if (!sourceComparison.matches) {
              throw fsError(
                "INSTALL_SYMLINK_SOURCE_CHANGED",
                "The local authoring source changed after preview.",
                input.sourcePath,
              );
            }
          }
          await hooks.beforeSnapshot?.({
            targetPath: input.targetPath,
            sourcePath: input.sourcePath,
            snapshotPath: input.snapshotPath,
          });
          await copySnapshot(
            input.strategy === "copy" ? input.stagingPath : input.sourcePath!,
            input.snapshotPath,
            input.assertFence,
          );
          const snapshotComparison = compareFiles(
            await inspectTree(input.snapshotPath),
            input.files,
          );
          if (!snapshotComparison.matches) {
            throw fsError(
              "INSTALL_SNAPSHOT_CORRUPT",
              "The owned snapshot does not match the authorized package.",
              input.snapshotPath,
            );
          }
          await hooks.afterSnapshot?.({
            targetPath: input.targetPath,
            sourcePath: input.sourcePath,
            snapshotPath: input.snapshotPath,
          });
          if (input.strategy === "symlink") {
            await input.assertFence.pipe(Effect.runPromise);
            await symlink(input.snapshotPath, input.stagingPath, "dir");
          }
          await input.assertFence.pipe(Effect.runPromise);
          await hooks.beforeTargetCapture?.({ targetPath: input.targetPath });
          await assertCurrentMatchesPlan(input.targetPath, input.expectedBefore);
          const targetKind = await pathKind(input.targetPath);
          const expectedKind = input.expectedBefore.kind;
          if (targetKind !== expectedKind) {
            throw fsError(
              "INSTALL_TARGET_CHANGED",
              "The destination kind changed immediately before capture.",
              input.targetPath,
            );
          }
          if (targetKind !== "missing") {
            await input.assertFence.pipe(Effect.runPromise);
            await rename(input.targetPath, input.rollbackPath);
            await hooks.afterTargetCapture?.({
              targetPath: input.targetPath,
              rollbackPath: input.rollbackPath,
            });
          }
          if (targetKind !== "missing") {
            const captured = compareFiles(
              await inspectTree(input.rollbackPath),
              input.expectedBefore.files,
            );
            if (!captured.matches) {
              await rename(input.rollbackPath, input.targetPath);
              throw fsError(
                "INSTALL_TARGET_CHANGED",
                "The destination changed while being captured for replacement.",
                input.targetPath,
              );
            }
          }
          try {
            await input.assertFence.pipe(Effect.runPromise);
            await rename(input.stagingPath, input.targetPath);
          } catch (cause) {
            await removeIfPresent(input.targetPath);
            if ((await pathKind(input.rollbackPath)) !== "missing") {
              await rename(input.rollbackPath, input.targetPath);
            }
            throw cause;
          }
          return {
            files: input.files.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              byteLength: file.byteLength,
              durableSnapshotRef: join(input.snapshotPath, ...file.path.split("/")),
            })),
          };
        },
      ),
    rollback: (step: DurableInstallStep, assertFence) =>
      effect("INSTALL_RECOVERY_FAILED", "Unable to roll back an install step.", async () => {
        assertDerivedSibling(step.targetPath, step.stagingPath, "Staging path");
        assertDerivedSibling(step.targetPath, step.rollbackPath, "Rollback path");
        assertDerivedSibling(step.targetPath, step.snapshotPath, "Snapshot path");
        await assertNoSymlinkAncestors(dirname(step.targetPath));
        const rollbackExists = (await pathKind(step.rollbackPath)) !== "missing";
        const promotedNewTarget =
          !rollbackExists &&
          step.mutation === "install" &&
          step.operations.every(
            (operation) => operation.kind === "create_file" || operation.kind === "create_symlink",
          ) &&
          (await pathKind(step.stagingPath)) === "missing" &&
          (await pathKind(step.snapshotPath)) !== "missing";
        if (rollbackExists && step.mutation === "restore" && step.restoreBackupPath) {
          if (assertFence) await assertFence.pipe(Effect.runPromise);
          assertDerivedSibling(step.targetPath, step.restoreBackupPath, "Retained backup path");
          if ((await pathKind(step.restoreBackupPath)) !== "missing") {
            throw fsError(
              "INSTALL_RECOVERY_CONFLICT",
              "The retained unmanaged backup path reappeared during recovery.",
              step.restoreBackupPath,
            );
          }
          if ((await pathKind(step.targetPath)) !== "missing") {
            if (assertFence) await assertFence.pipe(Effect.runPromise);
            await rename(step.targetPath, step.restoreBackupPath);
          }
        } else if (rollbackExists || promotedNewTarget) {
          if (assertFence) await assertFence.pipe(Effect.runPromise);
          await removeIfPresent(step.targetPath);
        }
        if (rollbackExists) {
          if (assertFence) await assertFence.pipe(Effect.runPromise);
          await rename(step.rollbackPath, step.targetPath);
        } else if (
          step.mutation === "restore" &&
          step.restoreBackupPath &&
          (await pathKind(step.stagingPath)) !== "missing"
        ) {
          assertDerivedSibling(step.targetPath, step.restoreBackupPath, "Retained backup path");
          if (assertFence) await assertFence.pipe(Effect.runPromise);
          await rename(step.stagingPath, step.restoreBackupPath);
        }
        if (assertFence) await assertFence.pipe(Effect.runPromise);
        await removeIfPresent(step.stagingPath);
        if (assertFence) await assertFence.pipe(Effect.runPromise);
        await removeIfPresent(step.snapshotPath);
      }),
    cleanupAfterCommit: (step, assertFence) =>
      effect("INSTALL_CLEANUP_FAILED", "Unable to clean install staging paths.", async () => {
        assertDerivedSibling(step.targetPath, step.stagingPath, "Staging path");
        assertDerivedSibling(step.targetPath, step.rollbackPath, "Rollback path");
        await assertNoSymlinkAncestors(dirname(step.targetPath));
        if (assertFence) await assertFence.pipe(Effect.runPromise);
        await removeIfPresent(step.stagingPath);
        if (!step.retainRollbackAfterCommit) {
          if (assertFence) await assertFence.pipe(Effect.runPromise);
          await removeIfPresent(step.rollbackPath);
        }
      }),
    inspectOwned: (receipt) =>
      effect("INSTALL_INSPECTION_FAILED", "Unable to inspect receipt-owned paths.", async () => {
        return inspectReceiptOwned(receipt);
      }),
    removeOwned: ({ receipt, step, assertFence }) =>
      effect("INSTALL_REMOVE_FAILED", "Unable to remove receipt-owned files.", async () => {
        await assertNoSymlinkAncestors(dirname(receipt.targetPath));
        assertDerivedSibling(receipt.targetPath, step.rollbackPath, "Removal rollback path");
        if ((await pathKind(step.rollbackPath)) !== "missing") {
          throw fsError(
            "INSTALL_INTERNAL_PATH_COLLISION",
            "Removal rollback path already exists.",
            step.rollbackPath,
          );
        }
        await assertFence.pipe(Effect.runPromise);
        const fresh = await inspectReceiptOwned(receipt);
        if (!fresh.matches) {
          throw fsError(
            "INSTALL_TARGET_CHANGED",
            "Receipt-owned files changed immediately before removal.",
            receipt.targetPath,
          );
        }
        await rename(receipt.targetPath, step.rollbackPath);
        const captured = await inspectReceiptOwned(receipt, step.rollbackPath);
        if (!captured.matches) {
          await rename(step.rollbackPath, receipt.targetPath);
          throw fsError(
            "INSTALL_TARGET_CHANGED",
            "Receipt-owned files changed while removal was being captured.",
            receipt.targetPath,
          );
        }
      }),
    restoreOwned: ({ receipt, previous, step, assertFence }) =>
      effect("INSTALL_ROLLBACK_FAILED", "Unable to restore the previous install.", async () => {
        await assertNoSymlinkAncestors(dirname(receipt.targetPath));
        assertDerivedSibling(receipt.targetPath, step.stagingPath, "Restore staging path");
        assertDerivedSibling(receipt.targetPath, step.rollbackPath, "Restore rollback path");
        if (
          (await pathKind(step.stagingPath)) !== "missing" ||
          (await pathKind(step.rollbackPath)) !== "missing"
        ) {
          throw fsError(
            "INSTALL_INTERNAL_PATH_COLLISION",
            "Restore staging or rollback path already exists.",
          );
        }
        const restoreSource = receipt.backupPath ?? previous?.files[0]?.durableSnapshotRef;
        if (receipt.backupPath) {
          if ((await pathKind(receipt.backupPath)) === "missing") {
            throw fsError(
              "INSTALL_SNAPSHOT_MISSING",
              "The unmanaged backup required for rollback is missing.",
              receipt.backupPath,
            );
          }
          await rename(receipt.backupPath, step.stagingPath);
        } else if (previous && restoreSource) {
          const snapshotRoot = receiptSnapshotRoot(previous);
          if (!snapshotRoot || (await pathKind(snapshotRoot)) !== "directory") {
            throw fsError(
              "INSTALL_SNAPSHOT_MISSING",
              "The previous durable snapshot required for rollback is missing.",
            );
          }
          await cp(snapshotRoot, step.stagingPath, { recursive: true, errorOnExist: true });
          const comparison = compareFiles(await inspectTree(step.stagingPath), previous.files);
          if (!comparison.matches) {
            await removeIfPresent(step.stagingPath);
            throw fsError(
              "INSTALL_SNAPSHOT_CORRUPT",
              "The previous durable snapshot does not match its receipt.",
            );
          }
        }
        await assertFence.pipe(Effect.runPromise);
        const fresh = await inspectReceiptOwned(receipt);
        if (!fresh.matches) {
          if (receipt.backupPath && (await pathKind(step.stagingPath)) !== "missing") {
            await rename(step.stagingPath, receipt.backupPath);
          } else {
            await removeIfPresent(step.stagingPath);
          }
          throw fsError(
            "INSTALL_TARGET_CHANGED",
            "Receipt-owned files changed immediately before rollback.",
            receipt.targetPath,
          );
        }
        await rename(receipt.targetPath, step.rollbackPath);
        const captured = await inspectReceiptOwned(receipt, step.rollbackPath);
        if (!captured.matches) {
          await rename(step.rollbackPath, receipt.targetPath);
          if (receipt.backupPath && (await pathKind(step.stagingPath)) !== "missing") {
            await rename(step.stagingPath, receipt.backupPath);
          } else {
            await removeIfPresent(step.stagingPath);
          }
          throw fsError(
            "INSTALL_TARGET_CHANGED",
            "Receipt-owned files changed while rollback was being captured.",
            receipt.targetPath,
          );
        }
        if ((await pathKind(step.stagingPath)) !== "missing") {
          try {
            await assertFence.pipe(Effect.runPromise);
            await rename(step.stagingPath, receipt.targetPath);
          } catch (cause) {
            await rename(step.rollbackPath, receipt.targetPath);
            throw cause;
          }
        }
      }),
  };
}
