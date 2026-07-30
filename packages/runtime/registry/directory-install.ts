import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function replaceDirectoryAtomically(
  stagedDir: string,
  targetDir: string,
): Promise<void> {
  const parentDir = path.dirname(targetDir);
  const backupDir = path.join(
    parentDir,
    `.${path.basename(targetDir)}.selftune-backup-${Date.now()}-${randomUUID()}`,
  );

  let movedExisting = false;
  try {
    await rename(targetDir, backupDir);
    movedExisting = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  try {
    await rename(stagedDir, targetDir);
    if (movedExisting) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    if (movedExisting) {
      try {
        await rename(backupDir, targetDir);
      } catch (rollbackError) {
        // oxlint-disable-next-line preserve-caught-error -- both failures are retained in AggregateError.errors and the original is also the cause
        throw new AggregateError(
          [error, rollbackError],
          `Failed to replace '${targetDir}' and restore its previous contents`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export async function stageDirectoryReplacement(
  targetDir: string,
  populate: (stagedDir: string) => Promise<void>,
): Promise<void> {
  const parentDir = path.dirname(targetDir);
  await mkdir(parentDir, { recursive: true });
  const tempRoot = await mkdtemp(
    path.join(parentDir, `.${path.basename(targetDir)}.selftune-stage-`),
  );
  const stagedDir = path.join(tempRoot, "content");

  try {
    await populate(stagedDir);
    await replaceDirectoryAtomically(stagedDir, targetDir);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
