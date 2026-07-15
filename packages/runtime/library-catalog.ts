import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { type HarnessId, LibraryObservation, type LibrarySnapshot } from "@selftune/control-plane";

import { createControlPlaneRuntime, type ControlPlaneRuntime } from "./control-plane-runtime.js";
import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import { getDb } from "./localdb/db.js";
import {
  queryTrustedSkillObservationRows,
  type TrustedSkillObservationRow,
} from "./localdb/queries.js";
import { listQuarantinedSkills, QUARANTINE_DIR } from "./skill-portfolio.js";
import {
  resolveInstalledSkillMetadata,
  type InstalledSkillMetadata,
  type SkillSourceMetadataOptions,
} from "./skill-source-metadata.js";
import { listSkillSets, type SkillSetServiceOptions } from "./skill-sets.js";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "./utils/skill-discovery.js";

export interface LibraryCatalogOptions {
  searchDirs?: string[];
  skillSetConfigRoot?: string;
  quarantineRoot?: string;
  usageRows?: ReadonlyArray<TrustedSkillObservationRow>;
  sourceMetadata?: SkillSourceMetadataOptions;
  versionHashLoader?: (skillPath: string) => string | undefined;
}

interface LastUsedIndex {
  byName: ReadonlyMap<string, string>;
  byPath: ReadonlyMap<string, string>;
}

function normalizedPath(path: string): string {
  return path.split("\\").join("/");
}

function harnessForPath(path: string): HarnessId | null {
  const normalized = normalizedPath(path);
  if (normalized.includes("/.claude/skills/")) return "claude_code";
  if (
    normalized.includes("/.opencode/skills/") ||
    normalized.includes("/.config/opencode/skills/")
  ) {
    return "opencode";
  }
  if (normalized.includes("/.openclaw/skills/")) return "openclaw";
  if (normalized.includes("/.pi/agent/skills/")) return "pi";
  if (
    normalized.includes("/.agents/skills/") ||
    normalized.includes("/.codex/skills/") ||
    normalized.includes("/etc/codex/skills/")
  ) {
    return "codex";
  }
  return null;
}

function modifiedAt(path: string, fallback: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return fallback;
  }
}

function latest(left: string | undefined, right: string): string {
  return left && left > right ? left : right;
}

function buildLastUsedIndex(rows: ReadonlyArray<TrustedSkillObservationRow>): LastUsedIndex {
  const byName = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const row of rows) {
    if (row.triggered !== 1 || !row.occurred_at) continue;
    const normalizedName = row.skill_name.trim().toLowerCase();
    byName.set(normalizedName, latest(byName.get(normalizedName), row.occurred_at));
    if (row.skill_path) {
      const path = resolve(row.skill_path);
      byPath.set(path, latest(byPath.get(path), row.occurred_at));
    }
  }
  return { byName, byPath };
}

function lastUsedAt(index: LastUsedIndex, skillName: string, skillPath: string): string | null {
  return index.byPath.get(resolve(skillPath)) ?? index.byName.get(skillName.toLowerCase()) ?? null;
}

function loadTrustedUsageRows(): TrustedSkillObservationRow[] {
  try {
    return queryTrustedSkillObservationRows(getDb());
  } catch {
    return [];
  }
}

export async function collectLibraryObservations(
  options: LibraryCatalogOptions = {},
): Promise<LibraryObservation[]> {
  const loadVersionHash = options.versionHashLoader ?? computeSkillVersionHash;
  const versionHashes = new Map<string, string | null>();
  const versionHash = (skillPath: string): string | null => {
    const packagePath = dirname(skillPath);
    let cacheKey = resolve(packagePath);
    try {
      cacheKey = realpathSync(packagePath);
    } catch {
      // Unreadable and synthetic paths are handled by the hash loader.
    }
    if (versionHashes.has(cacheKey)) return versionHashes.get(cacheKey) ?? null;
    const hash = loadVersionHash(skillPath) ?? null;
    versionHashes.set(cacheKey, hash);
    return hash;
  };
  const installedPackages = findInstalledSkillPackages(
    options.searchDirs ?? getDefaultSkillSearchDirs(),
  );
  const installedMetadata = await resolveInstalledSkillMetadata(
    installedPackages,
    options.sourceMetadata,
  );
  const usage = buildLastUsedIndex(options.usageRows ?? loadTrustedUsageRows());
  const installed = installedPackages.map((skill) => {
    const metadata: InstalledSkillMetadata = installedMetadata.get(skill.skill_path) ?? {
      origin: { kind: "local", label: "Local package", url: null },
      updateStatus: "untracked",
    };
    return LibraryObservation.make({
      skillName: skill.name,
      sourceKind: "installed",
      contentHash: versionHash(skill.skill_path),
      packagePath: skill.package_path,
      skillPath: skill.skill_path,
      harness: harnessForPath(`${skill.registry_dir}${sep}`),
      scope: skill.skill_scope,
      projectRoot: skill.skill_project_root ?? null,
      active: true,
      modifiedAt: modifiedAt(skill.skill_path, skill.modified_at),
      lastUsedAt: lastUsedAt(usage, skill.name, skill.skill_path),
      origin: metadata.origin,
      updateStatus: metadata.updateStatus,
    });
  });

  const draftRoot = join(
    resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR),
    "library",
    "drafts",
  );
  const drafts = existsSync(draftRoot)
    ? findInstalledSkillPackages([draftRoot]).map((skill) =>
        LibraryObservation.make({
          skillName: skill.name,
          sourceKind: "draft",
          contentHash: versionHash(skill.skill_path),
          packagePath: skill.package_path,
          skillPath: skill.skill_path,
          harness: null,
          scope: "library",
          projectRoot: null,
          active: false,
          modifiedAt: modifiedAt(skill.skill_path, skill.modified_at),
          lastUsedAt: lastUsedAt(usage, skill.name, skill.skill_path),
          origin: { kind: "generated", label: "Local draft", url: null },
          updateStatus: "untracked",
        }),
      )
    : [];

  const setOptions: SkillSetServiceOptions = options.skillSetConfigRoot
    ? { configRoot: options.skillSetConfigRoot }
    : {};
  const cachedByHash = new Map<string, LibraryObservation>();
  const packageRoot = join(
    resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR),
    "library",
    "packages",
  );
  if (existsSync(packageRoot)) {
    for (const skill of findInstalledSkillPackages([packageRoot])) {
      const contentHash = versionHash(skill.skill_path);
      if (!contentHash) continue;
      cachedByHash.set(
        `${skill.name}\u0000${contentHash}`,
        LibraryObservation.make({
          skillName: skill.name,
          sourceKind: "cached",
          contentHash,
          packagePath: skill.package_path,
          skillPath: skill.skill_path,
          harness: null,
          scope: "library",
          projectRoot: null,
          active: false,
          modifiedAt: modifiedAt(skill.skill_path, skill.modified_at),
          lastUsedAt: lastUsedAt(usage, skill.name, skill.skill_path),
          origin: { kind: "generated", label: "SelfTune Library", url: null },
          updateStatus: "untracked",
        }),
      );
    }
  }
  for (const set of listSkillSets(setOptions)) {
    for (const skill of set.skills) {
      if (!existsSync(skill.library_package_path)) continue;
      const cacheKey = `${skill.name}\u0000${skill.content_hash}`;
      cachedByHash.set(
        cacheKey,
        LibraryObservation.make({
          skillName: skill.name,
          sourceKind: "cached",
          contentHash: skill.content_hash,
          packagePath: skill.library_package_path,
          skillPath: `${skill.library_package_path}${sep}SKILL.md`,
          harness: null,
          scope: "library",
          projectRoot: null,
          active: false,
          modifiedAt: modifiedAt(skill.library_package_path, set.updated_at),
          lastUsedAt: lastUsedAt(usage, skill.name, `${skill.library_package_path}${sep}SKILL.md`),
          origin: { kind: "generated", label: "SelfTune Library", url: null },
          updateStatus: "untracked",
        }),
      );
    }
  }

  const archived = listQuarantinedSkills(options.quarantineRoot ?? QUARANTINE_DIR).map((skill) =>
    LibraryObservation.make({
      skillName: skill.skill_name,
      sourceKind: "archived",
      contentHash: skill.package_version_hash,
      packagePath: skill.quarantined_package_path,
      skillPath: `${skill.quarantined_package_path}${sep}SKILL.md`,
      harness: harnessForPath(skill.original_skill_path),
      scope: skill.skill_scope,
      projectRoot: null,
      active: false,
      modifiedAt: modifiedAt(skill.quarantined_package_path, skill.quarantined_at),
      lastUsedAt: usage.byName.get(skill.skill_name.toLowerCase()) ?? null,
      origin: { kind: "generated", label: "SelfTune Archive", url: null },
      updateStatus: "untracked",
    }),
  );

  return [...installed, ...cachedByHash.values(), ...drafts, ...archived];
}

export async function loadLibraryCatalog(
  options: LibraryCatalogOptions = {},
  runtime?: ControlPlaneRuntime,
): Promise<LibrarySnapshot> {
  const ownedRuntime = runtime ?? createControlPlaneRuntime();
  try {
    return await ownedRuntime.reconcile(await collectLibraryObservations(options));
  } finally {
    if (!runtime) await ownedRuntime.dispose();
  }
}

export async function cliMain(): Promise<void> {
  const snapshot = await loadLibraryCatalog();
  console.log(JSON.stringify(snapshot, null, 2));
}
