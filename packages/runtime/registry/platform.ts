import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "@selftune/config";
import { Context, Effect, FileSystem, Layer } from "effect";

import { installFromGithubTarget, type GithubRegistryInstallResult } from "./github-install.js";
import { installRegistryArchive } from "./install-utils.js";
import {
  resolveRegistryInstallPath,
  validatePersistedRegistryInstallPath,
  validateRegistrySkillName,
  validateRegistryVersion,
} from "./path-policy.js";
import {
  makeRegistryStateStore,
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
  readonly preparePush: (
    input: Extract<RegistryProgramInput, { operation: "push" }>,
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

async function collectFiles(
  directory: string,
  base?: string,
): Promise<Array<{ path: string; content: Buffer }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry): Promise<Array<{ path: string; content: Buffer }>> => {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      ) {
        return [];
      }
      const fullPath = join(directory, entry.name);
      const relativePath = base ? join(base, entry.name) : entry.name;
      if (entry.isDirectory()) return collectFiles(fullPath, relativePath);
      if (entry.isFile()) {
        return [{ path: relativePath, content: await readFile(fullPath) }];
      }
      throw new Error(`Registry skill contains unsupported filesystem entry: ${relativePath}`);
    }),
  );
  return groups.flat();
}

function makePlatform(
  options: RegistryPlatformOptions,
  stateStore: RegistryStateStore,
): RegistryPlatformService {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDirectory ?? process.env.HOME ?? homedir();

  const preparePush = Effect.fn("selftune.registry.platform.preparePush")(function* (
    input: Extract<RegistryProgramInput, { operation: "push" }>,
  ) {
    const skillPath = join(cwd, "SKILL.md");
    const exists = yield* fromPromise("push", () =>
      stat(skillPath)
        .then(() => true)
        .catch(() => false),
    );
    if (!exists) return null;
    const skillContent = yield* fromPromise("push", () => readFile(skillPath, "utf8"));
    const nameMatch = skillContent.match(/^name:\s*(.+)$/m);
    const descriptionMatch = skillContent.match(/^description:\s*(.+)$/m);
    const name = yield* validate("push", () =>
      validateRegistrySkillName(input.name || nameMatch?.[1]?.trim() || "unnamed-skill"),
    );
    const version = yield* validate("push", () =>
      validateRegistryVersion(input.version || `0.1.${Date.now()}`),
    );
    const files = yield* fromPromise("push", () => collectFiles(cwd));
    const archiveBuffer = yield* Effect.acquireUseRelease(
      fromPromise("push", () => mkdtemp(join(tmpdir(), "selftune-registry-"))),
      (tempRoot) =>
        fromPromise("push", async () => {
          const archivePath = join(tempRoot, "skill.tar.gz");
          const tar = Bun.spawn(
            [
              "tar",
              "czf",
              archivePath,
              "-C",
              cwd,
              "--exclude=.git",
              "--exclude=node_modules",
              "--exclude=.env",
              "--exclude=.env.*",
              ".",
            ],
            { stdout: "ignore", stderr: "pipe" },
          );
          await tar.exited;
          if (tar.exitCode !== 0) throw new Error("Failed to create archive");
          return await readFile(archivePath);
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

  return {
    deviceId: options.deviceId ?? hostname(),
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
      validate("sync", () => validatePersistedRegistryInstallPath(installPath, skillName)),
  };
}

export function makeRegistryPlatformLayer(
  options: RegistryPlatformOptions = {},
): Layer.Layer<RegistryPlatform, never, FileSystem.FileSystem> {
  return Layer.effect(
    RegistryPlatform,
    Effect.gen(function* () {
      const stateStore = yield* makeRegistryStateStore({
        ...options.stateStore,
        configDirectory: options.configDirectory ?? SELFTUNE_CONFIG_DIR,
      });
      return makePlatform(options, stateStore);
    }),
  );
}

export const registryPlatformLayer = makeRegistryPlatformLayer();
