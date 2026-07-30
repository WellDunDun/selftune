import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { SkillUpdateStatus } from "@selftune/control-plane";
import {
  GitHubTree,
  normalizeGitHubRepository,
  SkillLock,
  sourceFolderPath,
  sourceOrigin,
  sourceSubtreeHash,
  type InstalledSkillMetadata,
  type SkillSourceMetadataOptions,
  type TrackedSkillSource,
} from "@selftune/source-management/metadata";
import { Data, Effect } from "effect";
import * as Schema from "effect/Schema";

import type { InstalledSkillPackage } from "../utils/skill-discovery.js";

const RegistryInstallation = Schema.Struct({
  entryId: Schema.String,
  name: Schema.String,
  versionHash: Schema.String,
  installPath: Schema.String,
});

const RegistryState = Schema.Array(RegistryInstallation);

const SkillUpdateCacheEntry = Schema.Struct({
  checkedAt: Schema.Number,
  latestHash: Schema.NullOr(Schema.String),
});

const SkillUpdateCache = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String, SkillUpdateCacheEntry),
});

export {
  normalizeGitHubRepository,
  sourceFolderPath,
  sourceSubtreeHash,
} from "@selftune/source-management/metadata";
export type {
  GitHubTree,
  InstalledSkillMetadata,
  SkillLockEntry,
  SkillSourceMetadataOptions,
  TrackedSkillSource,
} from "@selftune/source-management/metadata";

interface CachedTree {
  expiresAt: number;
  value: Promise<GitHubTree | null>;
}

const TREE_CACHE_TTL_MS = 60 * 60 * 1_000;
const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const treeCache = new Map<string, CachedTree>();
let cliTokenCache: { expiresAt: number; value: string | null } | null = null;

function readUpdateCache(path: string): typeof SkillUpdateCache.Type {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    return Schema.decodeUnknownSync(SkillUpdateCache)(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeUpdateCache(path: string, cache: typeof SkillUpdateCache.Type): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function defaultGitHubToken(): string | null {
  const environmentToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  if (cliTokenCache && cliTokenCache.expiresAt > Date.now()) return cliTokenCache.value;
  try {
    const result = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
    });
    const value = result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
    cliTokenCache = { expiresAt: Date.now() + 5 * 60 * 1_000, value };
    return value;
  } catch {
    cliTokenCache = { expiresAt: Date.now() + 5 * 60 * 1_000, value: null };
    return null;
  }
}

function resolveGitHubToken(options: SkillSourceMetadataOptions): string | null {
  if (options.githubToken !== undefined) return options.githubToken;
  return (options.githubTokenLoader ?? defaultGitHubToken)();
}

export function readSkillLock(path: string): SkillLock | null {
  if (!existsSync(path)) return null;
  try {
    return Schema.decodeUnknownSync(SkillLock)(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function readRegistryState(path: string): typeof RegistryState.Type {
  if (!existsSync(path)) return [];
  try {
    return Schema.decodeUnknownSync(RegistryState)(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

async function fetchGitHubTree(
  source: string,
  ref: string | null,
  token: string | null,
): Promise<GitHubTree | null> {
  const repository = normalizeGitHubRepository(source);
  if (!repository) return null;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "selftune-desktop",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(
      `https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(ref ?? "HEAD")}?recursive=1`,
      {
        headers,
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) return null;
    return Schema.decodeUnknownSync(GitHubTree)(await response.json());
  } catch {
    return null;
  }
}

function cachedGitHubTree(
  source: string,
  ref: string | null,
  token: string | null,
  options: SkillSourceMetadataOptions,
): Promise<GitHubTree | null> {
  if (options.githubTreeLoader) return options.githubTreeLoader(source, ref);
  const now = options.now ?? Date.now();
  const key = `${source}\u0000${ref ?? ""}`;
  const cached = treeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = fetchGitHubTree(source, ref, token);
  treeCache.set(key, { expiresAt: now + TREE_CACHE_TTL_MS, value });
  return value;
}

export function loadGitHubTree(
  source: string,
  ref: string | null,
  options: SkillSourceMetadataOptions = {},
): Promise<GitHubTree | null> {
  const token = options.githubTreeLoader ? null : resolveGitHubToken(options);
  return cachedGitHubTree(source, ref, token, options);
}

export async function loadGitHubArchive(
  source: string,
  ref: string | null,
  options: SkillSourceMetadataOptions = {},
): Promise<Buffer | null> {
  const repository = normalizeGitHubRepository(source);
  if (!repository) return null;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "selftune-desktop",
    };
    const token = resolveGitHubToken(options);
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(
      `https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(ref ?? "HEAD")}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function loadGitHubBlob(
  source: string,
  sha: string,
  options: SkillSourceMetadataOptions = {},
): Promise<Buffer | null> {
  const repository = normalizeGitHubRepository(source);
  if (!repository) return null;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "selftune-desktop",
    };
    const token = resolveGitHubToken(options);
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(
      `https://api.github.com/repos/${repository}/git/blobs/${encodeURIComponent(sha)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { content?: unknown; encoding?: unknown };
    if (payload.encoding !== "base64" || typeof payload.content !== "string") return null;
    return Buffer.from(payload.content.replace(/\s/g, ""), "base64");
  } catch {
    return null;
  }
}

function updateCacheKey(source: string, ref: string | null, skillPath: string): string {
  return JSON.stringify([source, ref, sourceFolderPath(skillPath)]);
}

export function resolveTrackedSkillSources(
  installedSkills: ReadonlyArray<InstalledSkillPackage>,
  options: Pick<SkillSourceMetadataOptions, "homeDir" | "xdgStateHome"> = {},
): ReadonlyMap<string, TrackedSkillSource> {
  const homeDir = resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir());
  const xdgStateHome = options.xdgStateHome ?? process.env.XDG_STATE_HOME;
  const globalLockPath = xdgStateHome
    ? join(xdgStateHome, "skills", ".skill-lock.json")
    : join(homeDir, ".agents", ".skill-lock.json");
  const globalLock = readSkillLock(globalLockPath);
  const projectLocks = new Map<string, { path: string; lock: SkillLock | null }>();
  const tracked = new Map<string, TrackedSkillSource>();

  for (const installed of installedSkills) {
    const projectRoot = installed.skill_project_root;
    if (installed.skill_scope === "project" && projectRoot && !projectLocks.has(projectRoot)) {
      const path = join(projectRoot, "skills-lock.json");
      projectLocks.set(projectRoot, { path, lock: readSkillLock(path) });
    }

    const lockPath =
      installed.skill_scope === "project" && projectRoot
        ? projectLocks.get(projectRoot)?.path
        : globalLockPath;
    const lock =
      installed.skill_scope === "project" && projectRoot
        ? projectLocks.get(projectRoot)?.lock
        : globalLock;
    const entry = lock?.skills[installed.name];
    if (entry && lockPath) {
      tracked.set(installed.skill_path, {
        lockPath,
        lockKey: installed.name,
        entry,
      });
    }
  }

  return tracked;
}

export class InstalledSkillMetadataUnavailable extends Data.TaggedError(
  "InstalledSkillMetadataUnavailable",
)<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

function metadataFailure(operation: string) {
  return (cause: unknown): InstalledSkillMetadataUnavailable =>
    new InstalledSkillMetadataUnavailable({
      operation,
      message: `Installed skill metadata failed while ${operation}.`,
      cause,
    });
}

export const resolveInstalledSkillMetadataEffect = Effect.fn(
  "selftune.runtime.sourceManagement.resolveInstalledSkillMetadata",
)(function* (
  installedSkills: ReadonlyArray<InstalledSkillPackage>,
  options: SkillSourceMetadataOptions = {},
): Effect.fn.Return<
  ReadonlyMap<string, InstalledSkillMetadata>,
  InstalledSkillMetadataUnavailable
> {
  const state = yield* Effect.try({
    try: () => {
      const homeDir = resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir());
      const trackedSources = resolveTrackedSkillSources(installedSkills, options);
      const registryState = readRegistryState(join(homeDir, ".selftune", "registry-state.json"));
      const updateCachePath =
        options.updateCachePath ?? join(homeDir, ".selftune", "cache", "skill-updates-v1.json");
      const storedUpdateCache = readUpdateCache(updateCachePath);
      const updateCache: {
        version: 1;
        entries: Record<string, { checkedAt: number; latestHash: string | null }>;
      } = { version: 1, entries: { ...storedUpdateCache.entries } };
      const updateCacheTtlMs = options.updateCacheTtlMs ?? UPDATE_CACHE_TTL_MS;
      const now = options.now ?? Date.now();
      const cacheFirst = options.updateMode === "cache-first";
      const needsGitHubToken =
        !cacheFirst &&
        !options.githubTreeLoader &&
        installedSkills.some((installed) => {
          const lockEntry = trackedSources.get(installed.skill_path)?.entry;
          if (
            lockEntry?.sourceType !== "github" ||
            !lockEntry.skillFolderHash ||
            !lockEntry.skillPath
          ) {
            return false;
          }
          const cached =
            updateCache.entries[
              updateCacheKey(lockEntry.source, lockEntry.ref ?? null, lockEntry.skillPath)
            ];
          return !cached || cached.checkedAt + updateCacheTtlMs <= now;
        });
      const githubToken = needsGitHubToken ? resolveGitHubToken(options) : null;
      return {
        trackedSources,
        registryState,
        updateCachePath,
        updateCache,
        updateCacheTtlMs,
        now,
        cacheFirst,
        githubToken,
      };
    },
    catch: metadataFailure("initializing source state"),
  });
  let updateCacheChanged = false;
  const metadata = new Map<string, InstalledSkillMetadata>();

  yield* Effect.forEach(
    installedSkills,
    (installed) =>
      Effect.tryPromise({
        try: async () => {
          const lockEntry = state.trackedSources.get(installed.skill_path)?.entry;
          if (lockEntry) {
            let updateStatus: SkillUpdateStatus = "unknown";
            if (
              lockEntry.sourceType === "github" &&
              lockEntry.skillFolderHash &&
              lockEntry.skillPath
            ) {
              const cacheKey = updateCacheKey(
                lockEntry.source,
                lockEntry.ref ?? null,
                lockEntry.skillPath,
              );
              const cachedUpdate = state.updateCache.entries[cacheKey];
              const cacheIsFresh =
                cachedUpdate !== undefined &&
                cachedUpdate.checkedAt + state.updateCacheTtlMs > state.now;
              let latestHash = cachedUpdate?.latestHash ?? null;
              if (!cacheIsFresh && !state.cacheFirst) {
                const tree = await cachedGitHubTree(
                  lockEntry.source,
                  lockEntry.ref ?? null,
                  state.githubToken,
                  options,
                );
                latestHash = tree ? sourceSubtreeHash(tree, lockEntry.skillPath) : null;
                if (!latestHash && cachedUpdate?.latestHash) {
                  latestHash = cachedUpdate.latestHash;
                }
                state.updateCache.entries[cacheKey] = { checkedAt: state.now, latestHash };
                updateCacheChanged = true;
              }
              updateStatus = latestHash
                ? latestHash === lockEntry.skillFolderHash
                  ? "current"
                  : "available"
                : "unknown";
            }
            metadata.set(installed.skill_path, {
              origin: sourceOrigin(lockEntry),
              updateStatus,
            });
            return;
          }

          const registry = state.registryState.find(
            (entry) =>
              resolve(entry.installPath) === resolve(installed.package_path) ||
              entry.name.toLowerCase() === installed.name.toLowerCase(),
          );
          if (registry) {
            metadata.set(installed.skill_path, {
              origin: { kind: "registry", label: "SelfTune Registry", url: null },
              updateStatus: "unknown",
            });
            return;
          }

          metadata.set(installed.skill_path, {
            origin: { kind: "local", label: "Local package", url: null },
            updateStatus: "untracked",
          });
        },
        catch: metadataFailure(`resolving ${installed.name}`),
      }),
    { concurrency: 4, discard: true },
  );

  if (updateCacheChanged) {
    yield* Effect.try({
      try: () => writeUpdateCache(state.updateCachePath, state.updateCache),
      catch: metadataFailure("writing the update cache"),
    });
  }

  return metadata;
});

export function resolveInstalledSkillMetadata(
  installedSkills: ReadonlyArray<InstalledSkillPackage>,
  options: SkillSourceMetadataOptions = {},
): Promise<ReadonlyMap<string, InstalledSkillMetadata>> {
  return Effect.runPromise(
    resolveInstalledSkillMetadataEffect(installedSkills, options).pipe(
      Effect.mapError((error) => error.cause),
    ),
  );
}
