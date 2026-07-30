import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  computeArchiveHash,
  installRegistryArchive,
  MAX_REGISTRY_ARCHIVE_EXPANDED_BYTES,
} from "../../packages/runtime/registry/install-utils.js";
import { RegistryIdentifierValidationError } from "../../packages/runtime/registry/path-policy.js";
import {
  replaceDirectoryAtomically,
  stageDirectoryReplacement,
} from "../../packages/runtime/registry/directory-install.js";

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

interface TestTarEntry {
  readonly name: string;
  readonly type?: string;
  readonly linkName?: string;
  readonly contents?: string;
}

function writeTarNumber(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function createTestArchive(entries: readonly TestTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeTarNumber(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
    writeTarNumber(header, 108, 8, 0);
    writeTarNumber(header, 116, 8, 0);
    writeTarNumber(header, 124, 12, contents.length);
    writeTarNumber(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write(entry.linkName ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function createPaxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let recordLength = Buffer.byteLength(body) + 2;
  while (true) {
    const record = `${recordLength} ${body}`;
    const actualLength = Buffer.byteLength(record);
    if (actualLength === recordLength) {
      return record;
    }
    recordLength = actualLength;
  }
}

async function expectArchiveRejected(
  rootDir: string,
  archiveBuffer: Buffer,
  message: RegExp,
): Promise<void> {
  const installRoot = path.join(rootDir, "skills");
  await expect(
    installRegistryArchive({
      archiveBuffer,
      expectedHash: computeArchiveHash(archiveBuffer),
      installRoot,
      skillName: "reviewer",
      version: "1.0.0",
    }),
  ).rejects.toThrow(message);
  expect(existsSync(installRoot)).toBe(false);
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
        installRoot: path.dirname(targetDir),
        skillName: path.basename(targetDir),
        version: "1.0.0",
        label: "reviewer",
      }),
    ).rejects.toThrow(/hash mismatch/);

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf-8")).toBe("# old");
  });

  test("rejects an unsafe skill name before creating archive staging paths", async () => {
    const installRoot = path.join(rootDir, "skills");
    const archiveBuffer = Buffer.from("not a tar archive");

    await expect(
      installRegistryArchive({
        archiveBuffer,
        expectedHash: computeArchiveHash(archiveBuffer),
        installRoot,
        skillName: "../outside",
        version: "1.0.0",
      }),
    ).rejects.toBeInstanceOf(RegistryIdentifierValidationError);

    expect(existsSync(path.join(rootDir, "outside"))).toBe(false);
    expect(existsSync(installRoot)).toBe(false);
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
        installRoot: path.dirname(targetDir),
        skillName: path.basename(targetDir),
        version: "1.0.0",
        label: "reviewer",
      }),
    ).resolves.toEqual({ archiveHash });

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf-8")).toBe("# new");
    expect(readFileSync(path.join(targetDir, "README.md"), "utf-8")).toBe("new readme");
    expect(existsSync(path.join(targetDir, "removed.md"))).toBe(false);
  });

  test("installs ordinary system-tar archives with long paths", async () => {
    const sourceDir = path.join(rootDir, "long-source");
    const targetDir = path.join(rootDir, "skills", "long-skill");
    const longName = `${"long-segment-".repeat(10)}file.md`;
    await mkdir(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "SKILL.md"), "# long skill", "utf8");
    writeFileSync(path.join(sourceDir, longName), "long path contents", "utf8");
    const archivePath = path.join(rootDir, "long-skill.tar.gz");
    const archiveBuffer = await createArchive(sourceDir, archivePath);

    await installRegistryArchive({
      archiveBuffer,
      expectedHash: computeArchiveHash(archiveBuffer),
      installRoot: path.dirname(targetDir),
      skillName: path.basename(targetDir),
      version: "1.0.0",
    });

    expect(readFileSync(path.join(targetDir, longName), "utf8")).toBe("long path contents");
  });

  test("rejects symlinks with absolute targets before extraction", async () => {
    const archiveBuffer = createTestArchive([
      { name: "SKILL.md", contents: "# reviewer" },
      { name: "escape", type: "2", linkName: path.join(rootDir, "outside") },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsafe archive link target/);
    expect(existsSync(path.join(rootDir, "outside"))).toBe(false);
  });

  test("rejects symlinks with parent-traversing targets before extraction", async () => {
    const archiveBuffer = createTestArchive([
      { name: "SKILL.md", contents: "# reviewer" },
      { name: "escape", type: "2", linkName: "../../outside" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsafe archive link target/);
    expect(existsSync(path.join(rootDir, "outside"))).toBe(false);
  });

  test("rejects a symlink before a later entry can follow it", async () => {
    const archiveBuffer = createTestArchive([
      { name: "SKILL.md", contents: "# reviewer" },
      { name: "pivot", type: "2", linkName: "nested" },
      { name: "pivot/owned.md", contents: "must not be written" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Archive link entries are not allowed/);
  });

  test("rejects link targets overridden through PAX metadata", async () => {
    const archiveBuffer = createTestArchive([
      {
        name: "PaxHeader/link",
        type: "x",
        contents: createPaxRecord("linkpath", path.join(rootDir, "outside")),
      },
      { name: "escape", type: "2", linkName: "safe-relative-target" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsafe archive link target/);
  });

  test("rejects entry paths overridden through PAX metadata", async () => {
    const archiveBuffer = createTestArchive([
      {
        name: "PaxHeader/file",
        type: "x",
        contents: createPaxRecord("path", "../../outside.md"),
      },
      { name: "apparently-safe.md", contents: "must not be written" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsafe archive entry path/);
  });

  test("rejects entry paths overridden through GNU long-name metadata", async () => {
    const archiveBuffer = createTestArchive([
      { name: "././@LongLink", type: "L", contents: "../../outside.md\0" },
      { name: "apparently-safe.md", contents: "must not be written" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsafe archive entry path/);
  });

  test("installs safe paths carried by GNU long-name metadata", async () => {
    const longPath = `nested/${"long-name-".repeat(12)}file.md`;
    const archiveBuffer = createTestArchive([
      { name: "SKILL.md", contents: "# reviewer" },
      { name: "nested/", type: "5" },
      { name: "././@LongLink", type: "L", contents: `${longPath}\0` },
      { name: "placeholder.md", contents: "long-name contents" },
    ]);

    await installRegistryArchive({
      archiveBuffer,
      expectedHash: computeArchiveHash(archiveBuffer),
      installRoot: path.join(rootDir, "skills"),
      skillName: "reviewer",
      version: "1.0.0",
    });

    expect(readFileSync(path.join(rootDir, "skills", "reviewer", longPath), "utf8")).toBe(
      "long-name contents",
    );
  });

  test("rejects malformed PAX metadata before extraction", async () => {
    const archiveBuffer = createTestArchive([
      { name: "PaxHeader/file", type: "x", contents: "999 path=safe.md\n" },
      { name: "apparently-safe.md", contents: "must not be written" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Invalid PAX archive record bounds/);
  });

  test("rejects GNU long-link targets that escape the install root", async () => {
    const archiveBuffer = createTestArchive([
      { name: "././@LongLink", type: "K", contents: `${path.join(rootDir, "outside")}\0` },
      { name: "escape", type: "2", linkName: "apparently-safe" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsafe archive link target/);
  });

  test("rejects mismatched PAX size overrides before extraction", async () => {
    const archiveBuffer = createTestArchive([
      { name: "PaxHeader/file", type: "x", contents: createPaxRecord("size", "999") },
      { name: "SKILL.md", contents: "# reviewer" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /PAX archive size does not match/);
  });

  test("rejects PAX sparse-file metadata before extraction", async () => {
    const archiveBuffer = createTestArchive([
      {
        name: "PaxHeader/file",
        type: "x",
        contents: createPaxRecord("GNU.sparse.map", "0,10"),
      },
      { name: "SKILL.md", contents: "# reviewer" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Unsupported sparse archive metadata/);
  });

  test("rejects hardlinks even when their target path is relative and safe", async () => {
    const archiveBuffer = createTestArchive([
      { name: "SKILL.md", contents: "# reviewer" },
      { name: "SKILL-copy.md", type: "1", linkName: "SKILL.md" },
    ]);

    await expectArchiveRejected(rootDir, archiveBuffer, /Archive link entries are not allowed/);
  });

  test("rejects device, fifo, and sparse special entries", async () => {
    await Promise.all(
      ["3", "4", "6", "S"].map((type) => {
        const archiveBuffer = createTestArchive([
          { name: "SKILL.md", contents: "# reviewer" },
          { name: `special-${type}`, type },
        ]);

        return expectArchiveRejected(rootDir, archiveBuffer, /Unsupported archive entry type/);
      }),
    );
  });

  test("rejects archives with corrupted header checksums", async () => {
    const tarBuffer = gunzipSync(createTestArchive([{ name: "SKILL.md", contents: "# reviewer" }]));
    tarBuffer[0] = (tarBuffer[0] ?? 0) ^ 0xff;
    await expectArchiveRejected(rootDir, gzipSync(tarBuffer), /Invalid tar header checksum/);
  });

  test("rejects truncated archives before extraction", async () => {
    const tarBuffer = gunzipSync(createTestArchive([{ name: "SKILL.md", contents: "# reviewer" }]));
    await expectArchiveRejected(
      rootDir,
      gzipSync(tarBuffer.subarray(0, 515)),
      /Tar entry exceeds archive bounds/,
    );
  });

  test("rejects high-expansion gzip archives at the decompressed size limit", async () => {
    const archiveBuffer = gzipSync(Buffer.alloc(MAX_REGISTRY_ARCHIVE_EXPANDED_BYTES + 1, 0x61));

    await expectArchiveRejected(rootDir, archiveBuffer, /32 MiB extracted size limit/);
  });
});

describe("registry directory replacement", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "selftune-directory-replacement-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("leaves an existing target untouched when staging fails after a partial write", async () => {
    const targetDir = path.join(rootDir, "skills", "reviewer");
    await mkdir(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, "SKILL.md"), "# old", "utf8");

    await expect(
      stageDirectoryReplacement(targetDir, async (stagedDir) => {
        await mkdir(stagedDir, { recursive: true });
        writeFileSync(path.join(stagedDir, "SKILL.md"), "# partial", "utf8");
        throw new Error("simulated copy failure");
      }),
    ).rejects.toThrow(/simulated copy failure/);

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# old");
    expect(
      readdirSync(path.dirname(targetDir)).filter((entry) => entry.includes("selftune-")),
    ).toEqual([]);
  });

  test("restores an existing target when the staged-directory swap fails", async () => {
    const targetDir = path.join(rootDir, "skills", "reviewer");
    await mkdir(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, "SKILL.md"), "# old", "utf8");

    await expect(
      replaceDirectoryAtomically(path.join(rootDir, "missing-stage"), targetDir),
    ).rejects.toThrow();

    expect(readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# old");
    expect(
      readdirSync(path.dirname(targetDir)).filter((entry) => entry.includes("selftune-")),
    ).toEqual([]);
  });
});
