import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { LibraryOrigin, SkillUpdateStatus } from "@selftune/control-plane";
import { Effect } from "effect";
import * as Schema from "effect/Schema";

import type { InstalledSkillPackage } from "./utils/skill-discovery.js";

const SkillLockEntry = Schema.Struct({
  source: Schema.String,
  sourceType: Schema.String,
  sourceUrl: Schema.optional(Schema.String),
  skillPath: Schema.optional(Schema.String),
  skillFolderHash: Schema.optional(Schema.String),
  computedHash: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
});

const SkillLock = Schema.Struct({
  version: Schema.Number,
  skills: Schema.Record(Schema.String, SkillLockEntry),
});

const RegistryInstallation = Schema.Struct({
  entryId: Schema.String,
  name: Schema.String,
  versionHash: Schema.String,
  installPath: Schema.String,
});

const RegistryState = Schema.Array(RegistryInstallation);

const GitHubTreeEntry = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
  sha: Schema.String,
});

const GitHubTree = Schema.Struct({
  sha: Schema.String,
  tree: Schema.Array(GitHubTreeEntry),
});

const SkillUpdateCacheEntry = Schema.Struct({
  checkedAt: Schema.Number,
  latestHash: Schema.NullOr(Schema.String),
});

const SkillUpdateCache = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String, SkillUpdateCacheEntry),
});

type SkillLock = typeof SkillLock.Type;
export type SkillLockEntry = typeof SkillLockEntry.Type;
export type GitHubTree = typeof GitHubTree.Type;

export interface TrackedSkillSource {
  lockPath: string;
  lockKey: string;
  entry: SkillLockEntry;
}

export interface InstalledSkillMetadata {
  origin: LibraryOrigin;
  updateStatus: SkillUpdateStatus;
}

export interface SkillSourceMetadataOptions {
  homeDir?: string;
  xdgStateHome?: string;
  githubTreeLoader?: (source: string, ref: string | null) => Promise<GitHubTree | null>;
  githubToken?: string | null;
  githubTokenLoader?: () => string | null;
  updateCachePath?: string;
  updateCacheTtlMs?: number;
  now?: number;
  updateMode?: "blocking" | "cache-first";
}

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

export function normalizeGitHubRepository(source: string): string | null {
  const trimmed = source.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh?.[1]) return ssh[1];
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https?.[1]) return https[1];
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : null;
}

export function sourceFolderPath(skillPath: string): string {
  const normalized = skillPath.replaceAll("\\", "/");
  if (normalized.toLowerCase().endsWith("/skill.md")) return normalized.slice(0, -9);
  if (normalized.toLowerCase() === "skill.md") return "";
  return normalized.replace(/\/$/, "");
}

export function sourceSubtreeHash(tree: GitHubTree, skillPath: string): string | null {
  const folder = sourceFolderPath(skillPath);
  if (!folder) return tree.sha;
  return tree.tree.find((entry) => entry.type === "tree" && entry.path === folder)?.sha ?? null;
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

function updateCacheKey(source: string, ref: string | null, skillPath: string): string {
  return JSON.stringify([source, ref, sourceFolderPath(skillPath)]);
}

function originForLock(entry: SkillLockEntry): LibraryOrigin {
  const repository = normalizeGitHubRepository(entry.source);
  const kind =
    entry.sourceType === "github"
      ? "github"
      : entry.sourceType === "well-known"
        ? "well_known"
        : entry.sourceType === "local"
          ? "local"
          : "unknown";
  return {
    kind,
    label: repository ?? entry.source,
    url: entry.sourceUrl ?? (repository ? `https://github.com/${repository}` : null),
  };
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

export async function resolveInstalledSkillMetadata(
  installedSkills: ReadonlyArray<InstalledSkillPackage>,
  options: SkillSourceMetadataOptions = {},
): Promise<ReadonlyMap<string, InstalledSkillMetadata>> {
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
  let updateCacheChanged = false;
  const metadata = new Map<string, InstalledSkillMetadata>();

  await Effect.runPromise(
    Effect.forEach(
      installedSkills,
      (installed) =>
        Effect.promise(async () => {
          const lockEntry = trackedSources.get(installed.skill_path)?.entry;
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
              const cachedUpdate = updateCache.entries[cacheKey];
              const cacheIsFresh =
                cachedUpdate !== undefined && cachedUpdate.checkedAt + updateCacheTtlMs > now;
              let latestHash = cachedUpdate?.latestHash ?? null;
              if (!cacheIsFresh && !cacheFirst) {
                const tree = await cachedGitHubTree(
                  lockEntry.source,
                  lockEntry.ref ?? null,
                  githubToken,
                  options,
                );
                latestHash = tree ? sourceSubtreeHash(tree, lockEntry.skillPath) : null;
                if (!latestHash && cachedUpdate?.latestHash) {
                  latestHash = cachedUpdate.latestHash;
                }
                updateCache.entries[cacheKey] = { checkedAt: now, latestHash };
                updateCacheChanged = true;
              }
              updateStatus = latestHash
                ? latestHash === lockEntry.skillFolderHash
                  ? "current"
                  : "available"
                : "unknown";
            }
            metadata.set(installed.skill_path, {
              origin: originForLock(lockEntry),
              updateStatus,
            });
            return;
          }

          const registry = registryState.find(
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
        }),
      { concurrency: 4, discard: true },
    ),
  );

  if (updateCacheChanged) writeUpdateCache(updateCachePath, updateCache);

  return metadata;
}
