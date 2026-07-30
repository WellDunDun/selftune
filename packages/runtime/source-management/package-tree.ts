import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import {
  SkillSourceUpdateFailure,
  type SkillSourceUpdateLocalState,
} from "@selftune/source-management/contracts";
import { sourceFolderPath, type GitHubTree } from "@selftune/source-management/metadata";

export interface FileTreeComparison {
  state: SkillSourceUpdateLocalState;
  reason: string;
}

function failure(code: string, message: string): SkillSourceUpdateFailure {
  return SkillSourceUpdateFailure.make({ code, message });
}

function gitBlobHash(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function localBlobTree(root: string): ReadonlyMap<string, string> | null {
  const blobs = new Map<string, string>();
  const walk = (directory: string, prefix: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._") || entry.name === "__MACOSX") {
        continue;
      }
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!walk(path, relativePath)) return false;
        continue;
      }
      if (stat.isFile()) blobs.set(relativePath, gitBlobHash(readFileSync(path)));
    }
    return true;
  };
  return walk(root, "") ? blobs : null;
}

export function comparePackageToTree(
  packagePath: string,
  expectedTree: GitHubTree | null,
): FileTreeComparison {
  if (!expectedTree) {
    return {
      state: "unverifiable",
      reason: "The installed upstream revision could not be loaded.",
    };
  }
  const actual = localBlobTree(packagePath);
  if (!actual) {
    return {
      state: "modified",
      reason: "The local package contains symbolic links that cannot be verified safely.",
    };
  }
  const expected = new Map(
    expectedTree.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry.sha]),
  );
  if (actual.size !== expected.size) {
    return {
      state: "modified",
      reason: "Local files differ from the recorded upstream revision.",
    };
  }
  for (const [path, hash] of expected) {
    if (actual.get(path) !== hash) {
      return {
        state: "modified",
        reason: `Local file differs from upstream: ${path}`,
      };
    }
  }
  return { state: "clean", reason: "Matches the recorded upstream revision." };
}

export function directorySnapshot(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._") || entry.name === "__MACOSX") {
        continue;
      }
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw failure(
          "MERGE_UNSAFE",
          `Symbolic links are not supported in merge candidates: ${path}`,
        );
      }
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        files.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path));
      }
    }
  };
  walk(root);
  return files;
}

export function snapshotFingerprint(snapshot: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const path of [...snapshot.keys()].toSorted()) {
    const bytes = snapshot.get(path);
    if (!bytes) continue;
    hash.update(path).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

export function directoryFingerprint(root: string): string {
  return snapshotFingerprint(directorySnapshot(root));
}

export function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

export function isText(bytes: Buffer | undefined): boolean {
  if (!bytes) return true;
  if (bytes.includes(0)) return false;
  return !bytes.toString("utf8").includes("�");
}

export function diffDirectories(before: string, after: string, root: string): string {
  const beforeName = `before-${randomUUID()}`;
  const afterName = `after-${randomUUID()}`;
  const beforePath = join(root, beforeName);
  const afterPath = join(root, afterName);
  cpSync(before, beforePath, { recursive: true });
  cpSync(after, afterPath, { recursive: true });
  try {
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", beforeName, afterName],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0 && result.status !== 1) {
      throw failure(
        "DIFF_FAILED",
        result.stderr.trim() || "The package diff could not be created.",
      );
    }
    return result.stdout
      .replaceAll(`a/${beforeName}/`, "a/")
      .replaceAll(`b/${afterName}/`, "b/")
      .replaceAll(`${beforeName}/`, "a/")
      .replaceAll(`${afterName}/`, "b/")
      .trim();
  } finally {
    rmSync(beforePath, { recursive: true, force: true });
    rmSync(afterPath, { recursive: true, force: true });
  }
}

function runTar(args: string[], message: string): string {
  const result = spawnSync("tar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw failure("ARCHIVE_INVALID", result.stderr.trim() || message);
  }
  return result.stdout;
}

function assertSafeArchiveEntries(entries: string[]): void {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().replaceAll("\\", "/");
    if (!entry) continue;
    const segments = entry.split("/").filter(Boolean);
    if (entry.startsWith("/") || segments.includes("..")) {
      throw failure("ARCHIVE_INVALID", `Unsafe archive entry: ${rawEntry}`);
    }
  }
}

export function extractSkillPackage(archive: Buffer, skillPath: string, root: string): string {
  const archivePath = join(root, "source.tar.gz");
  const extractRoot = join(root, "source");
  mkdirSync(extractRoot, { recursive: true });
  writeFileSync(archivePath, archive, { mode: 0o600 });
  const listing = runTar(["tzf", archivePath], "The source archive could not be inspected.");
  assertSafeArchiveEntries(listing.split("\n"));
  runTar(["xzf", archivePath, "-C", extractRoot], "The source archive could not be extracted.");
  const roots = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  if (roots.length !== 1 || !roots[0]) {
    throw failure("ARCHIVE_INVALID", "The source archive does not have one repository root.");
  }
  const packagePath = join(extractRoot, roots[0].name, sourceFolderPath(skillPath));
  if (!existsSync(join(packagePath, "SKILL.md"))) {
    throw failure("ARCHIVE_INVALID", "The upstream skill package does not contain SKILL.md.");
  }
  return packagePath;
}
