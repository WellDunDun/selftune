import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeArchiveHash,
  installRegistryArchive,
} from "../../cli/selftune/registry/install-utils.js";

async function createArchive(sourceDir: string, archivePath: string): Promise<Buffer> {
  const proc = Bun.spawn(["tar", "czf", archivePath, "-C", sourceDir, "."], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr || "failed to create test archive");
  }
  return readFile(archivePath);
}

describe("registry archive install utilities", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "selftune-registry-install-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("rejects a mismatched archive hash before touching the target directory", async () => {
    const targetDir = path.join(rootDir, "skills", "reviewer");
    await mkdir(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, "SKILL.md"), "# old", "utf-8");

    await expect(
      installRegistryArchive({
        archiveBuffer: Buffer.from("not a tar archive"),
        expectedHash: "sha256-does-not-match",
        targetDir,
        label: "reviewer",
      }),
    ).rejects.toThrow(/hash mismatch/);

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf-8")).toBe("# old");
  });

  test("stages and replaces the full skill directory so deleted files disappear", async () => {
    const sourceDir = path.join(rootDir, "source");
    const targetDir = path.join(rootDir, "skills", "reviewer");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "SKILL.md"), "# new", "utf-8");
    writeFileSync(path.join(sourceDir, "README.md"), "new readme", "utf-8");
    writeFileSync(path.join(targetDir, "SKILL.md"), "# old", "utf-8");
    writeFileSync(path.join(targetDir, "removed.md"), "remove me", "utf-8");

    const archivePath = path.join(rootDir, "skill.tar.gz");
    const archiveBuffer = await createArchive(sourceDir, archivePath);
    const archiveHash = computeArchiveHash(archiveBuffer);

    await expect(
      installRegistryArchive({
        archiveBuffer,
        expectedHash: archiveHash,
        targetDir,
        label: "reviewer",
      }),
    ).resolves.toEqual({ archiveHash });

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf-8")).toBe("# new");
    expect(readFileSync(path.join(targetDir, "README.md"), "utf-8")).toBe("new readme");
    expect(existsSync(path.join(targetDir, "removed.md"))).toBe(false);
  });
});
