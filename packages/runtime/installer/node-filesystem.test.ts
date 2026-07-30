import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { makeNodeInstallerMaterializationFileSystem } from "./node-filesystem.js";
import {
  InstallerMaterializationError,
  type DurableInstallStep,
  type VerifiedInstallerFile,
} from "./materializer.js";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const fence = Effect.succeed(undefined);

function verified(path: string, value: string): VerifiedInstallerFile {
  const bytes = new TextEncoder().encode(value);
  return { path, bytes, sha256: sha256(bytes), byteLength: bytes.byteLength };
}

describe("node installer materialization filesystem", () => {
  for (const race of ["before_capture", "after_capture"] as const) {
    test(`rejects a full-tree ${race} race and restores the captured destination`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), `selftune-target-${race}-`)));
      const targetPath = join(root, "research");
      const stagingPath = `${targetPath}.selftune-stage-op-0`;
      const rollbackPath = `${targetPath}.selftune-rollback-op-0`;
      const snapshotPath = `${targetPath}.selftune-owned-receipt`;
      await mkdir(targetPath);
      await writeFile(join(targetPath, "change.txt"), "old change");
      await writeFile(join(targetPath, "keep.txt"), "old keep");
      const filesystem = makeNodeInstallerMaterializationFileSystem({
        beforeTargetCapture:
          race === "before_capture"
            ? async () => writeFile(join(targetPath, "keep.txt"), "raced keep")
            : undefined,
        afterTargetCapture:
          race === "after_capture"
            ? async ({ rollbackPath: captured }) =>
                writeFile(join(captured, "change.txt"), "raced change")
            : undefined,
      });
      try {
        const error = await Effect.runPromise(
          Effect.flip(
            filesystem.materialize({
              operationId: "op",
              receiptId: "receipt",
              targetPath,
              stagingPath,
              rollbackPath,
              snapshotPath,
              backupPath: null,
              strategy: "copy",
              sourcePath: null,
              files: [verified("change.txt", "new change"), verified("keep.txt", "old keep")],
              operations: [],
              expectedBefore: {
                kind: "directory",
                files: [
                  { path: "change.txt", sha256: sha256("old change"), kind: "file" },
                  { path: "keep.txt", sha256: sha256("old keep"), kind: "file" },
                ],
              },
              assertFence: fence,
            }),
          ),
        );
        expect(error.code).toBe("INSTALL_TARGET_CHANGED");
        expect(await Bun.file(join(targetPath, "change.txt")).exists()).toBe(true);
        expect(await Bun.file(join(targetPath, "keep.txt")).exists()).toBe(true);
        expect(await readFile(join(targetPath, "change.txt"), "utf8")).not.toBe("new change");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("aborts instead of promoting when an expected directory disappears before capture", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "selftune-target-disappears-")));
    const targetPath = join(root, "research");
    await mkdir(targetPath);
    await writeFile(join(targetPath, "SKILL.md"), "old");
    const filesystem = makeNodeInstallerMaterializationFileSystem({
      beforeTargetCapture: async () => rm(targetPath, { recursive: true }),
    });
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          filesystem.materialize({
            operationId: "op",
            receiptId: "receipt",
            targetPath,
            stagingPath: `${targetPath}.selftune-stage-op-g1-0`,
            rollbackPath: `${targetPath}.selftune-rollback-op-g1-0`,
            snapshotPath: `${targetPath}.selftune-owned-receipt-g1`,
            backupPath: null,
            strategy: "copy",
            sourcePath: null,
            files: [verified("SKILL.md", "new")],
            operations: [],
            expectedBefore: {
              kind: "directory",
              files: [{ path: "SKILL.md", sha256: sha256("old"), kind: "file" }],
            },
            assertFence: fence,
          }),
        ),
      );
      expect(error.code).toBe("INSTALL_TARGET_CHANGED");
      expect(await Bun.file(targetPath).exists()).toBe(false);
      expect(await Bun.file(join(targetPath, "SKILL.md")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale claimant cannot remove a newer generation's scratch paths", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "selftune-claimant-paths-")));
    const targetPath = join(root, "research");
    const step = (generation: number): DurableInstallStep => ({
      sequence: 0,
      receiptId: "receipt",
      mutation: "install",
      state: "completed",
      targetPath,
      stagingPath: `${targetPath}.selftune-stage-op-g${generation}-0`,
      rollbackPath: `${targetPath}.selftune-rollback-op-g${generation}-0`,
      snapshotPath: `${targetPath}.selftune-owned-receipt-g${generation}`,
      retainRollbackAfterCommit: false,
      restoreBackupPath: null,
      strategy: "copy",
      sourcePath: null,
      expectedSealedPackageSha256: "a".repeat(64),
      expectedBefore: { kind: "missing", files: [] },
      operations: [],
    });
    const oldStep = step(1);
    const newStep = step(2);
    await mkdir(oldStep.rollbackPath);
    await mkdir(newStep.rollbackPath);
    await writeFile(join(oldStep.rollbackPath, "owner"), "generation 1");
    await writeFile(join(newStep.rollbackPath, "owner"), "generation 2");
    const filesystem = makeNodeInstallerMaterializationFileSystem();
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          filesystem.cleanupAfterCommit(
            oldStep,
            Effect.fail(
              InstallerMaterializationError.make({
                code: "INSTALL_RECOVERY_FENCE_LOST",
                message: "stale claimant",
                path: null,
              }),
            ),
          ),
        ),
      );
      expect(error.code).toBe("INSTALL_RECOVERY_FENCE_LOST");
      expect(await readFile(join(oldStep.rollbackPath, "owner"), "utf8")).toBe("generation 1");
      expect(await readFile(join(newStep.rollbackPath, "owner"), "utf8")).toBe("generation 2");

      await Effect.runPromise(filesystem.cleanupAfterCommit(newStep, fence));
      expect(await Bun.file(join(newStep.rollbackPath, "owner")).exists()).toBe(false);
      expect(await readFile(join(oldStep.rollbackPath, "owner"), "utf8")).toBe("generation 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlink installs point at an immutable owned snapshot when the authoring source changes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "selftune-symlink-stable-")));
    const sourcePath = join(root, "source");
    const targetPath = join(root, "research");
    const snapshotPath = `${targetPath}.selftune-owned-receipt`;
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, "SKILL.md"), "authorized");
    const filesystem = makeNodeInstallerMaterializationFileSystem({
      afterSnapshot: async () => writeFile(join(sourcePath, "SKILL.md"), "changed later"),
    });
    try {
      const result = await Effect.runPromise(
        filesystem.materialize({
          operationId: "op",
          receiptId: "receipt",
          targetPath,
          stagingPath: `${targetPath}.selftune-stage-op-0`,
          rollbackPath: `${targetPath}.selftune-rollback-op-0`,
          snapshotPath,
          backupPath: null,
          strategy: "symlink",
          sourcePath,
          files: [verified("SKILL.md", "authorized")],
          operations: [],
          expectedBefore: { kind: "missing", files: [] },
          assertFence: fence,
        }),
      );
      expect(await realpath(targetPath)).toBe(snapshotPath);
      expect(await readFile(join(targetPath, "SKILL.md"), "utf8")).toBe("authorized");
      expect(await readFile(join(sourcePath, "SKILL.md"), "utf8")).toBe("changed later");
      expect(result.files[0]?.durableSnapshotRef).toBe(join(snapshotPath, "SKILL.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlink-source race before promotion instead of copying changed bytes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "selftune-symlink-race-")));
    const sourcePath = join(root, "source");
    const targetPath = join(root, "research");
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, "SKILL.md"), "authorized");
    const filesystem = makeNodeInstallerMaterializationFileSystem({
      beforeSnapshot: async () => writeFile(join(sourcePath, "SKILL.md"), "raced"),
    });
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          filesystem.materialize({
            operationId: "op",
            receiptId: "receipt",
            targetPath,
            stagingPath: `${targetPath}.selftune-stage-op-0`,
            rollbackPath: `${targetPath}.selftune-rollback-op-0`,
            snapshotPath: `${targetPath}.selftune-owned-receipt`,
            backupPath: null,
            strategy: "symlink",
            sourcePath,
            files: [verified("SKILL.md", "authorized")],
            operations: [],
            expectedBefore: { kind: "missing", files: [] },
            assertFence: fence,
          }),
        ),
      );
      expect(error.code).toBe("INSTALL_SNAPSHOT_CORRUPT");
      expect(await Bun.file(targetPath).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
