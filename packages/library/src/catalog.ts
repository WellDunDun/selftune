import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  LibraryObservation,
  type HarnessId,
  type LibraryOrigin,
  type SkillUpdateStatus,
} from "@selftune/control-plane";

import { listSkillSets } from "./manifests.js";

export interface CatalogSkillPackage {
  name: string;
  skill_path: string;
  package_path: string;
  registry_dir: string;
  modified_at: string;
  skill_scope: "project" | "global" | "admin" | "system" | "unknown";
  skill_project_root?: string;
  linked_package_path?: string;
}

export interface CatalogUsageObservation {
  skill_name: string;
  skill_path: string | null;
  occurred_at: string | null;
  triggered: number;
}

export interface CatalogSkillMetadata {
  origin: LibraryOrigin;
  updateStatus: SkillUpdateStatus;
}

export interface CatalogQuarantinedSkill {
  skill_name: string;
  skill_scope: CatalogSkillPackage["skill_scope"];
  original_skill_path: string;
  quarantined_package_path: string;
  package_version_hash: string | null;
  quarantined_at: string;
}

export interface LibraryCatalogInput {
  configRoot: string;
  installedPackages: ReadonlyArray<CatalogSkillPackage>;
  installedMetadata: ReadonlyMap<string, CatalogSkillMetadata>;
  usageRows: ReadonlyArray<CatalogUsageObservation>;
  quarantinedSkills: ReadonlyArray<CatalogQuarantinedSkill>;
  findPackages: (searchDirs: string[]) => CatalogSkillPackage[];
  inferHarness: (path: string) => HarnessId | null;
  versionHashLoader: (skillPath: string) => string | undefined;
}

interface LastUsedIndex {
  byName: ReadonlyMap<string, string>;
  byPath: ReadonlyMap<string, string>;
}

function modifiedAt(path: string, fallback: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return fallback;
  }
}

function realPackagePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function latest(left: string | undefined, right: string): string {
  return left && left > right ? left : right;
}

function buildLastUsedIndex(rows: ReadonlyArray<CatalogUsageObservation>): LastUsedIndex {
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

export function collectCatalogObservations(input: LibraryCatalogInput): LibraryObservation[] {
  const versionHashes = new Map<string, string | null>();
  const versionHash = (skillPath: string): string | null => {
    const packagePath = dirname(skillPath);
    let cacheKey = resolve(packagePath);
    try {
      cacheKey = realpathSync(packagePath);
    } catch {
      // Unreadable and synthetic paths are handled by the injected hash loader.
    }
    if (versionHashes.has(cacheKey)) return versionHashes.get(cacheKey) ?? null;
    const hash = input.versionHashLoader(skillPath) ?? null;
    versionHashes.set(cacheKey, hash);
    return hash;
  };
  const usage = buildLastUsedIndex(input.usageRows);
  const installed = input.installedPackages.map((skill) => {
    const metadata = input.installedMetadata.get(skill.skill_path) ?? {
      origin: { kind: "local" as const, label: "Local package", url: null },
      updateStatus: "untracked" as const,
    };
    return LibraryObservation.make({
      skillName: skill.name,
      sourceKind: "installed",
      contentHash: versionHash(skill.skill_path),
      packagePath: skill.package_path,
      skillPath: skill.skill_path,
      harness: input.inferHarness(`${skill.registry_dir}${sep}`),
      scope: skill.skill_scope,
      projectRoot: skill.skill_project_root ?? null,
      linkedPackagePath: skill.linked_package_path ?? null,
      active: true,
      modifiedAt: modifiedAt(skill.skill_path, skill.modified_at),
      lastUsedAt: lastUsedAt(usage, skill.name, skill.skill_path),
      origin: metadata.origin,
      updateStatus: metadata.updateStatus,
    });
  });

  const draftRoot = join(input.configRoot, "library", "drafts");
  const drafts = existsSync(draftRoot)
    ? input.findPackages([draftRoot]).map((skill) =>
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

  const cachedByHash = new Map<string, LibraryObservation>();
  const packageRoot = join(input.configRoot, "library", "packages");
  if (existsSync(packageRoot)) {
    for (const skill of input.findPackages([packageRoot])) {
      const contentHash = versionHash(skill.skill_path);
      if (!contentHash) continue;
      const cachedPackagePath = realPackagePath(skill.package_path);
      cachedByHash.set(
        `${skill.name}\u0000${contentHash}`,
        LibraryObservation.make({
          skillName: skill.name,
          sourceKind: "cached",
          contentHash,
          packagePath: cachedPackagePath,
          skillPath: join(cachedPackagePath, "SKILL.md"),
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
  for (const set of listSkillSets({ configRoot: input.configRoot })) {
    for (const skill of set.skills) {
      if (!existsSync(skill.library_package_path)) continue;
      const cachedPackagePath = realPackagePath(skill.library_package_path);
      cachedByHash.set(
        `${skill.name}\u0000${skill.content_hash}`,
        LibraryObservation.make({
          skillName: skill.name,
          sourceKind: "cached",
          contentHash: skill.content_hash,
          packagePath: cachedPackagePath,
          skillPath: join(cachedPackagePath, "SKILL.md"),
          harness: null,
          scope: "library",
          projectRoot: null,
          active: false,
          modifiedAt: modifiedAt(cachedPackagePath, set.updated_at),
          lastUsedAt: lastUsedAt(usage, skill.name, join(cachedPackagePath, "SKILL.md")),
          origin: { kind: "generated", label: "SelfTune Library", url: null },
          updateStatus: "untracked",
        }),
      );
    }
  }

  const archived = input.quarantinedSkills.map((skill) =>
    LibraryObservation.make({
      skillName: skill.skill_name,
      sourceKind: "archived",
      contentHash: skill.package_version_hash,
      packagePath: skill.quarantined_package_path,
      skillPath: `${skill.quarantined_package_path}${sep}SKILL.md`,
      harness: input.inferHarness(skill.original_skill_path),
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
