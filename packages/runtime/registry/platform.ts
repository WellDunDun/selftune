import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "@selftune/config";
import { Context, Effect, FileSystem, Layer } from "effect";

import { installFromGithubTarget, type GithubRegistryInstallResult } from "./github-install.js";
import { inspectRegistryArchive, installRegistryArchive } from "./install-utils.js";
import {
  resolveRegistryInstallPath,
  validatePersistedRegistryInstallPath,
  validateRegistrySkillName,
  validateRegistryVersion,
} from "./path-policy.js";
import {
  makeRegistryStateStoreLayer,
  RegistryStateStorage,
  type RegistryStateStore,
  type RegistryStateStoreOptions,
} from "./registry-state-store.js";
import { fromPromise, validate, type RegistryProgramFailure } from "./program-support.js";
import type { RegistryProgramInput } from "./program-types.js";

export interface PreparedRegistryPush {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly archiveBuffer: Buffer;
  readonly archiveHash: string;
  readonly manifest: ReadonlyArray<{
    readonly path: string;
    readonly hash: string;
    readonly size: number;
  }>;
}

export interface RegistryInstallTarget {
  readonly installRoot: string;
  readonly targetDir: string;
}

export interface RegistryPlatformService {
  readonly deviceId: string;
  readonly installArchive: (options: {
    readonly archive: Uint8Array;
    readonly expectedHash: string;
    readonly installRoot: string;
    readonly skillName: string;
    readonly version: string;
    readonly label: string;
  }) => Effect.Effect<void, RegistryProgramFailure>;
  readonly installFromGithub: (
    target: string,
    global: boolean,
  ) => Effect.Effect<GithubRegistryInstallResult, RegistryProgramFailure>;
  readonly loadState: RegistryStateStore["load"];
  readonly computeInstalledContentHash: (
    directory: string,
  ) => Effect.Effect<string, RegistryProgramFailure>;
  readonly findProtectedPaths: (
    directory: string,
  ) => Effect.Effect<ReadonlyArray<string>, RegistryProgramFailure>;
  readonly computeArchiveContentHash: (options: {
    readonly archive: Uint8Array;
    readonly expectedHash: string;
    readonly label: string;
  }) => Effect.Effect<string, RegistryProgramFailure>;
  readonly preparePush: (
    input: Extract<RegistryProgramInput, { operation: "push" | "suggest" }>,
  ) => Effect.Effect<PreparedRegistryPush | null, RegistryProgramFailure>;
  readonly preparePackage: (
    directory: string,
    input: Extract<RegistryProgramInput, { operation: "push" | "suggest" }>,
  ) => Effect.Effect<PreparedRegistryPush | null, RegistryProgramFailure>;
  readonly resolveInstallTarget: (
    skillName: string,
    global: boolean,
  ) => Effect.Effect<RegistryInstallTarget, RegistryProgramFailure>;
  readonly withStateTransaction: RegistryStateStore["withTransaction"];
  readonly validatePersistedTarget: (
    installPath: string,
    skillName: string,
  ) => Effect.Effect<RegistryInstallTarget, RegistryProgramFailure>;
}

const MAX_PACKAGE_FILES = 1_024;
const MAX_PACKAGE_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_PACKAGE_TOTAL_BYTES = 16 * 1_024 * 1_024;

function isExcludedName(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".env" || name.startsWith(".env.");
}

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".npmrc" ||
    /^credentials(?:[._-].*)?\.json$/.test(lower) ||
    /^(?:auth|token|private[-_.]?key)(?:[._-].*)?$/.test(lower) ||
    /^(?:id_rsa|id_ed25519)(?:\.pub)?$/.test(lower) ||
    /\.(?:pem|key)$/.test(lower) ||
    lower === "transcripts" ||
    lower === ".transcripts"
  );
}

function isProtectedName(name: string): boolean {
  return isExcludedName(name) || isSensitiveName(name);
}

export class RegistryPlatform extends Context.Service<RegistryPlatform, RegistryPlatformService>()(
  "@selftune/runtime/RegistryPlatform",
) {}

export interface RegistryPlatformOptions {
  readonly configDirectory?: string;
  readonly cwd?: string;
  readonly deviceId?: string;
  readonly homeDirectory?: string;
  readonly stateStore?: Omit<RegistryStateStoreOptions, "configDirectory">;
}

async function collectFilePaths(
  directory: string,
  base?: string,
  collected: Array<{ path: string; size: number }> = [],
): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcludedName(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    const relativePath = base ? join(base, entry.name) : entry.name;
    if (isSensitiveName(entry.name)) {
      throw new Error(`Registry skill contains a protected local path: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop -- sequential traversal stops at the file/size boundary without queueing an unbounded tree
      await collectFilePaths(fullPath, relativePath, collected);
      continue;
    }
    if (entry.isFile()) {
      // oxlint-disable-next-line no-await-in-loop -- metadata limits are enforced before discovering another file
      const metadata = await lstat(fullPath);
      if (!metadata.isFile()) {
        throw new Error(`Registry skill contains unsupported filesystem entry: ${relativePath}`);
      }
      if (metadata.size > MAX_PACKAGE_FILE_BYTES) {
        throw new Error(`Registry package file exceeds the 2 MiB limit: ${relativePath}`);
      }
      collected.push({ path: relativePath, size: metadata.size });
      if (collected.length > MAX_PACKAGE_FILES) {
        throw new Error(`Registry package exceeds the ${MAX_PACKAGE_FILES} file limit`);
      }
      if (collected.reduce((total, file) => total + file.size, 0) > MAX_PACKAGE_TOTAL_BYTES) {
        throw new Error("Registry package exceeds the 16 MiB uncompressed size limit");
      }
      continue;
    }
    throw new Error(`Registry skill contains unsupported filesystem entry: ${relativePath}`);
  }
  return collected;
}

async function findProtectedPaths(directory: string, base?: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const relativePath = base ? join(base, entry.name) : entry.name;
      if (isProtectedName(entry.name)) return [relativePath];
      if (entry.isDirectory()) return findProtectedPaths(join(directory, entry.name), relativePath);
      return [];
    }),
  );
  return groups.flat().toSorted((left, right) => left.localeCompare(right));
}

async function readBoundedFile(pathname: string, expectedSize: number): Promise<Buffer> {
  if (expectedSize > MAX_PACKAGE_FILE_BYTES) {
    throw new Error(`Registry package file exceeds the 2 MiB limit: ${pathname}`);
  }
  const handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PACKAGE_FILE_BYTES) {
      throw new Error(`Registry package file exceeds the 2 MiB limit: ${pathname}`);
    }
    const output = Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < output.length) {
      // oxlint-disable-next-line no-await-in-loop -- ordered bounded reads prevent whole-file allocation and detect growth past the cap
      const read = await handle.read(output, offset, output.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_PACKAGE_FILE_BYTES) {
      throw new Error(`Registry package file exceeds the 2 MiB limit: ${pathname}`);
    }
    return output.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function assertPackageDirectory(directory: string): Promise<void> {
  const lexical = resolve(directory);
  const [metadata] = await Promise.all([lstat(lexical), realpath(lexical)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Registry skill path is not a real directory: ${directory}`);
  }

  // System paths may themselves have canonical aliases (for example /var -> /private/var on
  // macOS). The managed boundary begins at .claude, so reject links in every component from
  // there through the skill directory without misclassifying those system aliases.
  const segments = lexical.split(sep);
  const managedIndex = segments.lastIndexOf(".claude");
  if (managedIndex >= 0) {
    let current = segments.slice(0, managedIndex).join(sep) || sep;
    for (const segment of segments.slice(managedIndex)) {
      current = join(current, segment);
      // oxlint-disable-next-line no-await-in-loop -- each ancestor must be checked before descending through it
      const component = await lstat(current);
      if (component.isSymbolicLink()) {
        throw new Error(`Registry skill path crosses a symbolic link: ${directory}`);
      }
    }
  }
}

async function collectFiles(directory: string): Promise<Array<{ path: string; content: Buffer }>> {
  await assertPackageDirectory(directory);
  const files = (await collectFilePaths(directory)).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const collected: Array<{ path: string; content: Buffer }> = [];
  let total = 0;
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded buffer at a time caps sidecar memory
    const content = await readBoundedFile(join(directory, file.path), file.size);
    total += content.length;
    if (total > MAX_PACKAGE_TOTAL_BYTES) {
      throw new Error("Registry package exceeds the 16 MiB uncompressed size limit");
    }
    collected.push({ path: file.path, content });
  }
  return collected;
}

function hashCollectedFiles(files: Array<{ path: string; content: Buffer }>): string {
  const digest = createHash("sha256");
  for (const file of files.toSorted((left, right) => left.path.localeCompare(right.path))) {
    digest.update(file.path.replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(createHash("sha256").update(file.content).digest("hex"));
    digest.update("\0");
    digest.update(String(file.content.length));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function makePlatform(
  options: RegistryPlatformOptions,
  stateStore: RegistryStateStore,
): RegistryPlatformService {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDirectory ?? process.env.HOME ?? homedir();

  const preparePackage = Effect.fn("selftune.registry.platform.preparePackage")(function* (
    directory: string,
    input: Extract<RegistryProgramInput, { operation: "push" | "suggest" }>,
  ) {
    const files = yield* fromPromise("push", () => collectFiles(directory));
    const skillFile = files.find((file) => file.path === "SKILL.md");
    if (!skillFile) return null;
    const skillContent = skillFile.content.toString("utf8");
    const nameMatch = skillContent.match(/^name:\s*(.+)$/m);
    const descriptionMatch = skillContent.match(/^description:\s*(.+)$/m);
    const name = yield* validate("push", () =>
      validateRegistrySkillName(input.name || nameMatch?.[1]?.trim() || "unnamed-skill"),
    );
    const version = yield* validate("push", () =>
      validateRegistryVersion(input.version || `0.1.${Date.now()}`),
    );
    const archiveBuffer = yield* Effect.acquireUseRelease(
      fromPromise("push", () => mkdtemp(join(tmpdir(), "selftune-registry-"))),
      (tempRoot) =>
        fromPromise("push", async () => {
          const tarPath = join(tempRoot, "skill.tar");
          const archivePaths = files
            .map((file) => file.path.replaceAll("\\", "/"))
            .toSorted((left, right) => left.localeCompare(right));
          const tar = Bun.spawn(["tar", "cf", tarPath, "-C", directory, "--", ...archivePaths], {
            stdout: "ignore",
            stderr: "pipe",
          });
          await tar.exited;
          if (tar.exitCode !== 0) throw new Error("Failed to create archive");
          const tarBytes = await readFile(tarPath);
          const compressed = new Blob([Uint8Array.from(tarBytes)])
            .stream()
            .pipeThrough(new CompressionStream("gzip"));
          return Buffer.from(await new Response(compressed).arrayBuffer());
        }),
      (tempRoot) =>
        fromPromise("push-cleanup", () => rm(tempRoot, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
    );
    return {
      name,
      description: descriptionMatch?.[1]?.trim() || "",
      version,
      archiveBuffer,
      archiveHash: createHash("sha256").update(archiveBuffer).digest("hex"),
      manifest: files.map((file) => ({
        path: file.path,
        hash: createHash("sha256").update(file.content).digest("hex"),
        size: file.content.length,
      })),
    };
  });

  const preparePush = (input: Extract<RegistryProgramInput, { operation: "push" | "suggest" }>) =>
    preparePackage(cwd, input);

  const computeInstalledContentHash = Effect.fn(
    "selftune.registry.platform.computeInstalledContentHash",
  )(function* (directory: string) {
    const files = yield* fromPromise("installed-content-hash", () => collectFiles(directory));
    return hashCollectedFiles(files);
  });

  return {
    deviceId: options.deviceId ?? hostname(),
    computeInstalledContentHash,
    computeArchiveContentHash: (archiveOptions) =>
      fromPromise("inspect-archive", () =>
        inspectRegistryArchive(
          {
            archiveBuffer: Buffer.from(archiveOptions.archive),
            expectedHash: archiveOptions.expectedHash,
            label: archiveOptions.label,
          },
          async (directory) => hashCollectedFiles(await collectFiles(directory)),
        ),
      ),
    findProtectedPaths: (directory) =>
      fromPromise("protected-paths", async () => {
        await assertPackageDirectory(directory);
        return findProtectedPaths(directory);
      }),
    installArchive: (archiveOptions) =>
      fromPromise("install-archive", () =>
        installRegistryArchive({
          archiveBuffer: Buffer.from(archiveOptions.archive),
          expectedHash: archiveOptions.expectedHash,
          installRoot: archiveOptions.installRoot,
          skillName: archiveOptions.skillName,
          version: archiveOptions.version,
          label: archiveOptions.label,
        }).then(() => undefined),
      ),
    installFromGithub: (target, global) =>
      fromPromise("install-github", () => installFromGithubTarget(target, global)),
    loadState: stateStore.load,
    preparePackage,
    preparePush,
    resolveInstallTarget: (skillName, global) =>
      validate("install", () => {
        const installRoot = global
          ? join(home, ".claude", "skills")
          : join(cwd, ".claude", "skills");
        return { installRoot, targetDir: resolveRegistryInstallPath(installRoot, skillName) };
      }),
    withStateTransaction: stateStore.withTransaction,
    validatePersistedTarget: (installPath, skillName) =>
      Effect.gen(function* () {
        const target = yield* validate("sync", () =>
          validatePersistedRegistryInstallPath(installPath, skillName),
        );
        yield* fromPromise("sync", () => assertPackageDirectory(target.targetDir));
        return target;
      }),
  };
}

export function makeRegistryPlatformLayer(
  options: RegistryPlatformOptions = {},
): Layer.Layer<RegistryPlatform, never, FileSystem.FileSystem> {
  return Layer.effect(
    RegistryPlatform,
    Effect.gen(function* () {
      const stateStore = yield* RegistryStateStorage;
      return makePlatform(options, stateStore);
    }).pipe(
      Effect.provide(
        makeRegistryStateStoreLayer({
          ...options.stateStore,
          configDirectory: options.configDirectory ?? SELFTUNE_CONFIG_DIR,
        }),
      ),
    ),
  );
}

export const registryPlatformLayer = makeRegistryPlatformLayer();
