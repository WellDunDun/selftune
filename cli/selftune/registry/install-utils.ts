import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function computeArchiveHash(archiveBuffer: Buffer): string {
  return createHash("sha256").update(archiveBuffer).digest("hex");
}

export function verifyArchiveHash(
  archiveBuffer: Buffer,
  expectedHash: string,
  label = "registry archive",
): string {
  const actualHash = computeArchiveHash(archiveBuffer);
  if (actualHash !== expectedHash) {
    throw new Error(`${label} hash mismatch: expected ${expectedHash}, received ${actualHash}`);
  }
  return actualHash;
}

async function runTar(args: string[], errorPrefix: string): Promise<string> {
  const proc = Bun.spawn(["tar", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(detail ? `${errorPrefix}: ${detail}` : errorPrefix);
  }

  return stdout;
}

function assertSafeArchiveEntries(entries: string[]): void {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry || entry === ".") {
      continue;
    }

    const normalized = entry.replace(/\\/g, "/");
    const withoutDotPrefix = normalized.startsWith("./") ? normalized.slice(2) : normalized;
    const segments = withoutDotPrefix.split("/").filter(Boolean);
    if (
      path.posix.isAbsolute(normalized) ||
      segments.includes("..") ||
      withoutDotPrefix.startsWith("../")
    ) {
      throw new Error(`Unsafe archive entry path: ${entry}`);
    }
  }
}

async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  const listing = await runTar(["tzf", archivePath], "Failed to inspect archive");
  assertSafeArchiveEntries(listing.split("\n"));
  await runTar(["xzf", archivePath, "-C", targetDir], "Failed to extract archive");
}

async function replaceDirectoryAtomically(stagedDir: string, targetDir: string): Promise<void> {
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
      await rename(backupDir, targetDir).catch(() => {});
    }
    throw error;
  }
}

export async function installRegistryArchive(options: {
  archiveBuffer: Buffer;
  expectedHash: string;
  targetDir: string;
  label?: string;
}): Promise<{ archiveHash: string }> {
  const { archiveBuffer, expectedHash, targetDir, label } = options;
  const archiveHash = verifyArchiveHash(archiveBuffer, expectedHash, label);

  const parentDir = path.dirname(targetDir);
  await mkdir(parentDir, { recursive: true });
  const tempRoot = await mkdtemp(
    path.join(parentDir, `.${path.basename(targetDir)}.selftune-stage-`),
  );
  const stagedDir = path.join(tempRoot, "skill");
  const archivePath = path.join(tempRoot, "skill.tar.gz");

  try {
    await mkdir(stagedDir, { recursive: true });
    await writeFile(archivePath, archiveBuffer);
    await extractArchive(archivePath, stagedDir);
    await replaceDirectoryAtomically(stagedDir, targetDir);
    return { archiveHash };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function readRegistryArchive(pathname: string): Promise<Buffer> {
  return readFile(pathname);
}
