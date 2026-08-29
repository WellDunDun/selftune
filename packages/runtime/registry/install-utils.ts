import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { replaceDirectoryAtomically } from "./directory-install.js";
import { resolveRegistryInstallPath, validateRegistryVersion } from "./path-policy.js";
export {
  MAX_REGISTRY_ARCHIVE_COMPRESSED_BYTES,
  MAX_REGISTRY_ARCHIVE_EXPANDED_BYTES,
} from "./archive-policy.js";
import {
  MAX_REGISTRY_ARCHIVE_COMPRESSED_BYTES,
  MAX_REGISTRY_ARCHIVE_EXPANDED_BYTES,
} from "./archive-policy.js";

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

const TAR_BLOCK_SIZE = 512;
function readTarString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString("utf8");
}

function readTarNumber(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if ((field[0] ?? 0) & 0x80) {
    if ((field[0] ?? 0) & 0x40) {
      throw new Error("Negative tar entry sizes are not supported");
    }

    let value = BigInt((field[0] ?? 0) & 0x3f);
    for (const byte of field.subarray(1)) {
      value = value * 256n + BigInt(byte);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Tar entry size exceeds the supported range");
    }
    return Number(value);
  }

  const encoded = field.toString("ascii").replaceAll("\0", "").trim();
  if (!encoded) {
    return 0;
  }
  if (!/^[0-7]+$/.test(encoded)) {
    throw new Error(`Invalid tar number: ${encoded}`);
  }
  return Number.parseInt(encoded, 8);
}

function assertValidTarChecksum(block: Buffer): void {
  const expected = readTarNumber(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 0x7f ? byte - 0x100 : byte;
  }
  if (unsigned !== expected && signed !== expected) {
    throw new Error("Invalid tar header checksum");
  }
}

function assertSafeArchivePath(entry: string, label: "entry path" | "link target"): void {
  const normalized = entry.replace(/\\/g, "/");
  if (label === "entry path" && (normalized === "." || normalized === "./")) {
    return;
  }
  const withoutDotPrefix = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  const segments = withoutDotPrefix.split("/").filter(Boolean);
  if (
    !withoutDotPrefix ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    segments.includes("..") ||
    withoutDotPrefix.startsWith("../")
  ) {
    throw new Error(`Unsafe archive ${label}: ${entry}`);
  }
}

function readPaxAttributes(payload: Buffer): Map<string, string> {
  const attributes = new Map<string, string>();
  let offset = 0;

  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) {
      throw new Error("Invalid PAX archive metadata");
    }
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error("Invalid PAX archive record length");
    }
    const recordLength = Number.parseInt(lengthText, 10);
    const recordEnd = offset + recordLength;
    if (
      !Number.isSafeInteger(recordLength) ||
      recordEnd <= space + 2 ||
      recordEnd > payload.length
    ) {
      throw new Error("Invalid PAX archive record bounds");
    }

    const record = payload.subarray(space + 1, recordEnd);
    if (record.at(-1) !== 0x0a) {
      throw new Error("Invalid PAX archive record terminator");
    }
    const separator = record.indexOf(0x3d);
    if (separator === -1) {
      throw new Error("Invalid PAX archive attribute");
    }
    const key = record.subarray(0, separator).toString("utf8");
    const value = record.subarray(separator + 1, -1).toString("utf8");
    attributes.set(key, value);
    offset = recordEnd;
  }

  return attributes;
}

function mergePaxAttributes(target: Map<string, string>, source: Map<string, string>): void {
  for (const [key, value] of source) {
    if (value === "") {
      target.delete(key);
    } else {
      target.set(key, value);
    }
  }
}

function readPaxOverride(
  local: Map<string, string>,
  global: Map<string, string>,
  key: string,
): string | undefined {
  if (local.has(key)) {
    const value = local.get(key);
    return value === "" ? undefined : value;
  }
  return global.get(key);
}

function assertSafePaxAttributes(attributes: Map<string, string>): void {
  const overriddenPath = attributes.get("path");
  if (overriddenPath !== undefined && overriddenPath !== "") {
    assertSafeArchivePath(overriddenPath, "entry path");
  }
  const overriddenLinkPath = attributes.get("linkpath");
  if (overriddenLinkPath !== undefined && overriddenLinkPath !== "") {
    assertSafeArchivePath(overriddenLinkPath, "link target");
  }
  for (const key of attributes.keys()) {
    if (key.startsWith("GNU.sparse.")) {
      throw new Error(`Unsupported sparse archive metadata: ${key}`);
    }
  }
}

function assertPaxSizeMatchesHeader(encodedSize: string | undefined, headerSize: number): void {
  if (encodedSize === undefined) {
    return;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(encodedSize)) {
    throw new Error(`Invalid PAX archive size: ${encodedSize}`);
  }
  const paxSize = Number.parseInt(encodedSize, 10);
  if (!Number.isSafeInteger(paxSize) || paxSize !== headerSize) {
    throw new Error("PAX archive size does not match its tar header");
  }
}

function readMetadataString(payload: Buffer): string {
  const terminator = payload.indexOf(0);
  return payload.subarray(0, terminator === -1 ? payload.length : terminator).toString("utf8");
}

function assertSafeArchive(archiveBuffer: Buffer): void {
  if (archiveBuffer.byteLength > MAX_REGISTRY_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error(
      "Registry archive exceeds the 16 MiB compressed size limit; remove generated or binary files from the skill package",
    );
  }

  let tarBuffer: Buffer;
  try {
    tarBuffer = gunzipSync(archiveBuffer, {
      maxOutputLength: MAX_REGISTRY_ARCHIVE_EXPANDED_BYTES,
    });
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE")
    ) {
      throw new Error(
        "Registry archive expands beyond the 32 MiB extracted size limit; remove generated or binary files from the skill package",
        { cause: error },
      );
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Failed to inspect archive${detail}`, { cause: error });
  }

  const globalPax = new Map<string, string>();
  let localPax = new Map<string, string>();
  let longPath: string | undefined;
  let longLinkPath: string | undefined;
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (localPax.size > 0 || longPath !== undefined || longLinkPath !== undefined) {
        throw new Error("Tar archive ends with incomplete metadata");
      }
      return;
    }

    assertValidTarChecksum(header);
    const size = readTarNumber(header, 124, 12);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataOffset + size;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > tarBuffer.length) {
      throw new Error("Tar entry exceeds archive bounds");
    }
    const payload = tarBuffer.subarray(dataOffset, dataEnd);
    const type = String.fromCharCode(header[156] ?? 0);

    if (type === "g") {
      const attributes = readPaxAttributes(payload);
      assertSafePaxAttributes(attributes);
      mergePaxAttributes(globalPax, attributes);
    } else if (type === "x") {
      localPax = readPaxAttributes(payload);
      assertSafePaxAttributes(localPax);
    } else if (type === "L") {
      longPath = readMetadataString(payload);
      assertSafeArchivePath(longPath, "entry path");
    } else if (type === "K") {
      longLinkPath = readMetadataString(payload);
      assertSafeArchivePath(longLinkPath, "link target");
    } else {
      const prefix = readTarString(header, 345, 155);
      const headerPath = readTarString(header, 0, 100);
      const defaultPath = prefix ? `${prefix}/${headerPath}` : headerPath;
      const entryPath = readPaxOverride(localPax, globalPax, "path") ?? longPath ?? defaultPath;
      assertSafeArchivePath(entryPath, "entry path");
      assertPaxSizeMatchesHeader(readPaxOverride(localPax, globalPax, "size"), size);

      if (type === "1" || type === "2") {
        const linkTarget =
          readPaxOverride(localPax, globalPax, "linkpath") ??
          longLinkPath ??
          readTarString(header, 157, 100);
        assertSafeArchivePath(linkTarget, "link target");
        throw new Error(`Archive link entries are not allowed: ${entryPath} -> ${linkTarget}`);
      }
      if (type !== "\0" && type !== "0" && type !== "5") {
        throw new Error(`Unsupported archive entry type ${JSON.stringify(type)}: ${entryPath}`);
      }

      localPax = new Map<string, string>();
      longPath = undefined;
      longLinkPath = undefined;
    }

    offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  throw new Error("Tar archive is missing its end marker");
}

async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  await runTar(["xzf", archivePath, "-C", targetDir], "Failed to extract archive");
}

export async function inspectRegistryArchive<A>(
  options: {
    archiveBuffer: Buffer;
    expectedHash: string;
    label?: string;
  },
  inspect: (directory: string) => Promise<A>,
): Promise<A> {
  verifyArchiveHash(options.archiveBuffer, options.expectedHash, options.label);
  assertSafeArchive(options.archiveBuffer);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "selftune-registry-inspect-"));
  const stagedDir = path.join(tempRoot, "skill");
  const archivePath = path.join(tempRoot, "skill.tar.gz");
  try {
    await mkdir(stagedDir, { recursive: true });
    await writeFile(archivePath, options.archiveBuffer);
    await extractArchive(archivePath, stagedDir);
    return await inspect(stagedDir);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function installRegistryArchive(options: {
  archiveBuffer: Buffer;
  expectedHash: string;
  installRoot: string;
  skillName: string;
  version: string;
  label?: string;
}): Promise<{ archiveHash: string }> {
  const { archiveBuffer, expectedHash, installRoot, skillName, version, label } = options;
  const targetDir = resolveRegistryInstallPath(installRoot, skillName);
  validateRegistryVersion(version);
  const archiveHash = verifyArchiveHash(archiveBuffer, expectedHash, label);
  assertSafeArchive(archiveBuffer);

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
