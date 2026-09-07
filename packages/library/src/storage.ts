import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "@selftune/local-store";
import * as Schema from "effect/Schema";

import { LibraryError as CLIError } from "./errors.js";
import { computeSkillVersionHash } from "./hash.js";
import type {
  SkillSetManifest,
  SkillSetReceipt,
  SkillSetServiceOptions,
  SkillSetSkillInput,
  SkillSetSkillReference,
  StoredSkillSetManifest,
} from "./types.js";

export function configRoot(options: SkillSetServiceOptions): string {
  return resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
}

export function skillSetsDir(options: SkillSetServiceOptions): string {
  return join(configRoot(options), "skill-sets");
}

export function libraryPackagesDir(options: SkillSetServiceOptions): string {
  return join(configRoot(options), "library", "packages");
}

export function receiptsDir(options: SkillSetServiceOptions): string {
  return join(configRoot(options), "skill-set-receipts");
}

export function revisionsDir(setId: string, options: SkillSetServiceOptions): string {
  return join(configRoot(options), "skill-set-history", assertSafeSegment(setId, "Skill Set ID"));
}

export function skillSetTombstonePath(setId: string, options: SkillSetServiceOptions): string {
  return join(
    configRoot(options),
    "skill-set-tombstones",
    `${assertSafeSegment(setId, "Skill Set ID")}.json`,
  );
}

export function assertSafeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  const safe =
    trimmed.length > 0 &&
    /[A-Za-z0-9]/.test(trimmed[0] ?? "") &&
    [...trimmed].every((character) => /[A-Za-z0-9._-]/.test(character));
  if (!safe) {
    throw new CLIError(
      `${label} must contain only letters, numbers, dots, underscores, and hyphens.`,
      "INVALID_FLAG",
    );
  }
  return trimmed;
}

export function slugifySetId(name: string): string {
  let slug = "";
  let separatorPending = false;
  for (const character of name.trim().toLowerCase()) {
    if ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")) {
      if (separatorPending && slug.length > 0) slug += "-";
      slug += character;
      separatorPending = false;
    } else if (slug.length > 0) {
      separatorPending = true;
    }
  }
  return assertSafeSegment(slug, "Skill Set name");
}

export function manifestPath(setId: string, options: SkillSetServiceOptions): string {
  return join(skillSetsDir(options), `${assertSafeSegment(setId, "Skill Set ID")}.json`);
}

export function libraryPackagePath(
  contentHash: string,
  skillName: string,
  options: SkillSetServiceOptions,
): string {
  return join(
    libraryPackagesDir(options),
    assertSafeSegment(contentHash, "Content hash"),
    assertSafeSegment(skillName, "Skill name"),
  );
}

interface SkillSetTombstone {
  readonly schema_version: 1;
  readonly set_id: string;
  readonly deleted_revision_hash: string;
  readonly deleted_at: string;
}

export function atomicWriteJson(
  path: string,
  value: StoredSkillSetManifest | SkillSetReceipt | SkillSetTombstone,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function canonicalRevisionHash(
  manifest: Pick<SkillSetManifest, "set_id" | "name" | "description" | "harnesses" | "skills">,
): string {
  const canonical = JSON.stringify({
    set_id: manifest.set_id,
    name: manifest.name,
    description: manifest.description,
    harnesses: [...manifest.harnesses].sort(),
    skills: manifest.skills
      .map(({ name, content_hash }) => ({ name, content_hash }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function persistManifestRevision(
  manifest: SkillSetManifest,
  options: SkillSetServiceOptions,
): void {
  const stored = toStoredManifest(manifest);
  const revisionPath = join(
    revisionsDir(manifest.set_id, options),
    `${manifest.revision_hash}.json`,
  );
  if (!existsSync(revisionPath)) atomicWriteJson(revisionPath, stored);
  atomicWriteJson(manifestPath(manifest.set_id, options), stored);
  rmSync(skillSetTombstonePath(manifest.set_id, options), { force: true });
}

export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function assertImmutablePackageTree(rootPath: string, label: string): void {
  if (lstatSync(rootPath).isSymbolicLink()) {
    throw new CLIError(`${label} cannot be a symbolic link.`, "GUARD_BLOCKED");
  }
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CLIError(
        `${label} contains a symbolic link and cannot be cached immutably: ${entryPath}`,
        "GUARD_BLOCKED",
        "Replace package-internal links with files contained in the skill package.",
      );
    }
    if (entry.isDirectory()) {
      assertImmutablePackageTree(entryPath, label);
      continue;
    }
    if (!entry.isFile()) {
      throw new CLIError(
        `${label} contains an unsupported filesystem entry: ${entryPath}`,
        "GUARD_BLOCKED",
      );
    }
  }
}

const SkillPackageInput = Schema.Struct({ name: Schema.String, package_path: Schema.String });

export function cacheSkillPackage(
  input: SkillSetSkillInput,
  options: SkillSetServiceOptions,
): SkillSetSkillReference {
  if (!Schema.is(SkillPackageInput)(input)) {
    throw new CLIError("Each Skill Set entry requires a name and package_path.", "INVALID_FLAG");
  }
  const name = assertSafeSegment(input.name, "Skill name");
  let sourcePath: string;
  try {
    sourcePath = realpathSync(resolve(input.package_path));
  } catch {
    throw new CLIError(`Skill package "${name}" was not found.`, "FILE_NOT_FOUND");
  }
  if (!statSync(sourcePath).isDirectory()) {
    throw new CLIError(`Skill package "${name}" is not a directory.`, "INVALID_FLAG");
  }
  assertImmutablePackageTree(sourcePath, `Skill package "${name}"`);
  const skillPath = join(sourcePath, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new CLIError(
      `Skill package "${name}" does not contain SKILL.md: ${sourcePath}`,
      "FILE_NOT_FOUND",
    );
  }
  const contentHash = computeSkillVersionHash(skillPath);
  if (!contentHash) {
    throw new CLIError(`Could not hash skill package "${name}".`, "OPERATION_FAILED");
  }

  const targetPath = libraryPackagePath(contentHash, name, options);
  if (!existsSync(targetPath)) {
    const parentPath = resolve(targetPath, "..");
    const stagedPath = join(parentPath, `.stage-${randomUUID()}`);
    mkdirSync(parentPath, { recursive: true });
    try {
      cpSync(sourcePath, stagedPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      assertImmutablePackageTree(stagedPath, `Cached package "${name}"`);
      const copiedHash = computeSkillVersionHash(join(stagedPath, "SKILL.md"));
      if (copiedHash !== contentHash) {
        throw new Error(`Cached package hash mismatch for "${name}".`);
      }
      renameSync(stagedPath, targetPath);
    } catch (error) {
      rmSync(stagedPath, { recursive: true, force: true });
      throw new CLIError(
        `Could not cache skill package "${name}": ${error instanceof Error ? error.message : String(error)}`,
        "OPERATION_FAILED",
      );
    }
  } else {
    assertImmutablePackageTree(targetPath, `Cached package "${name}"`);
    const cachedHash = computeSkillVersionHash(join(targetPath, "SKILL.md"));
    if (cachedHash !== contentHash) {
      throw new CLIError(
        `Cached package "${name}" failed content verification.`,
        "GUARD_BLOCKED",
        `Remove the corrupted cache entry at ${targetPath}, then import the package again.`,
      );
    }
  }

  return {
    name,
    content_hash: contentHash,
    library_package_path: targetPath,
  };
}

export function toStoredManifest(manifest: SkillSetManifest): StoredSkillSetManifest {
  return {
    ...manifest,
    skills: manifest.skills.map(({ library_package_path: _path, ...skill }) => skill),
  };
}

export function resolveManifest(
  stored: StoredSkillSetManifest,
  options: SkillSetServiceOptions,
): SkillSetManifest {
  const base: SkillSetManifest = {
    schema_version: 1,
    set_id: stored.set_id,
    name: stored.name,
    description: stored.description,
    harnesses: [...stored.harnesses],
    skills: stored.skills.map((skill) => ({
      ...skill,
      library_package_path: libraryPackagePath(skill.content_hash, skill.name, options),
    })),
    revision: stored.revision,
    revision_hash: stored.revision_hash,
    parent_revision_hash: stored.parent_revision_hash,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
  const revisionHash = stored.revision_hash || canonicalRevisionHash(base);
  return {
    ...base,
    revision: stored.revision ?? 1,
    revision_hash: revisionHash,
    parent_revision_hash: stored.parent_revision_hash ?? null,
  };
}
