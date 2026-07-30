import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { LibraryError as CLIError } from "./errors.js";
import { computeSkillVersionHash } from "./hash.js";
import { targetRegistryPath } from "./paths.js";
import { decodeStoredSkillSetManifest } from "./schemas.js";
import {
  atomicWriteJson,
  cacheSkillPackage,
  canonicalRevisionHash,
  manifestPath,
  persistManifestRevision,
  resolveManifest,
  revisionsDir,
  skillSetsDir,
  slugifySetId,
  toStoredManifest,
} from "./storage.js";
import type {
  CreateSkillSetInput,
  SkillSetHarnessId,
  SkillSetManifest,
  SkillSetServiceOptions,
  SkillSetSkillInput,
  SkillSetSkillReference,
} from "./types.js";

type UnvalidatedCreateSkillSetInput = Omit<CreateSkillSetInput, "harnesses"> & {
  readonly harnesses: ReadonlyArray<string>;
};

const SUPPORTED_SKILL_SET_HARNESSES: ReadonlyArray<SkillSetHarnessId> = [
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
];

export interface ProjectSkillSetInspection {
  readonly project_root: string;
  readonly default_name: string;
  readonly harnesses: SkillSetHarnessId[];
  readonly skills: SkillSetSkillInput[];
}

function decodeSkillSetHarness(value: string): SkillSetHarnessId {
  switch (value) {
    case "codex":
    case "claude_code":
    case "opencode":
    case "openclaw":
    case "pi":
      return value;
    default:
      throw new CLIError(`Unsupported Skill Set harness: ${value}`, "INVALID_FLAG");
  }
}

function decodeSkillSetHarnesses(values: ReadonlyArray<string>): SkillSetHarnessId[] {
  return [...new Set(values)].map(decodeSkillSetHarness);
}

export function createSkillSet(
  input: UnvalidatedCreateSkillSetInput,
  options: SkillSetServiceOptions = {},
): SkillSetManifest {
  if (!input || typeof input.name !== "string") {
    throw new CLIError("Skill Set name is required.", "MISSING_FLAG");
  }
  if (!Array.isArray(input.harnesses)) {
    throw new CLIError("Skill Set harnesses must be an array.", "INVALID_FLAG");
  }
  if (!Array.isArray(input.skills)) {
    throw new CLIError("Skill Set skills must be an array.", "INVALID_FLAG");
  }
  const name = input.name.trim();
  if (!name) throw new CLIError("Skill Set name is required.", "MISSING_FLAG");
  if (input.harnesses.length === 0) {
    throw new CLIError("Select at least one target harness.", "MISSING_FLAG");
  }
  if (input.skills.length === 0) {
    throw new CLIError("Select at least one skill.", "MISSING_FLAG");
  }

  const setId = slugifySetId(name);
  const path = manifestPath(setId, options);
  if (existsSync(path)) {
    throw new CLIError(
      `Skill Set "${name}" already exists.`,
      "GUARD_BLOCKED",
      `Choose another name or update ${setId}.`,
    );
  }

  const harnesses = decodeSkillSetHarnesses(input.harnesses);

  const skills = input.skills.map((skill) => cacheSkillPackage(skill, options));
  const duplicateNames = skills.filter(
    (skill, index) => skills.findIndex((candidate) => candidate.name === skill.name) !== index,
  );
  if (duplicateNames.length > 0) {
    throw new CLIError(
      `Skill Set contains duplicate skill name "${duplicateNames[0]!.name}".`,
      "INVALID_FLAG",
    );
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const manifest: SkillSetManifest = {
    schema_version: 1,
    set_id: setId,
    name,
    description: input.description?.trim() ?? "",
    harnesses,
    skills,
    revision: 1,
    revision_hash: "",
    parent_revision_hash: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  manifest.revision_hash = canonicalRevisionHash(manifest);
  persistManifestRevision(manifest, options);
  return manifest;
}

export function updateSkillSet(
  setId: string,
  input: Omit<UnvalidatedCreateSkillSetInput, "name"> & {
    name?: string;
    parent_revision_hash?: string;
  },
  options: SkillSetServiceOptions = {},
): SkillSetManifest {
  const current = getSkillSet(setId, options);
  if (
    input.parent_revision_hash !== undefined &&
    input.parent_revision_hash !== current.revision_hash
  ) {
    throw new CLIError(
      `Skill Set ${setId} changed after this edit started.`,
      "GUARD_BLOCKED",
      "Reload the current revision before applying your changes.",
    );
  }
  if (input.harnesses.length === 0) {
    throw new CLIError("Select at least one target harness.", "MISSING_FLAG");
  }
  if (input.skills.length === 0) {
    throw new CLIError("Select at least one skill.", "MISSING_FLAG");
  }
  const harnesses = decodeSkillSetHarnesses(input.harnesses);
  const skills = input.skills.map((skill) => cacheSkillPackage(skill, options));
  const duplicateNames = skills.filter(
    (skill, index) => skills.findIndex((candidate) => candidate.name === skill.name) !== index,
  );
  if (duplicateNames.length > 0) {
    throw new CLIError(
      `Skill Set contains duplicate skill name "${duplicateNames[0]!.name}".`,
      "INVALID_FLAG",
    );
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  const next: SkillSetManifest = {
    ...current,
    name: input.name?.trim() || current.name,
    description: input.description?.trim() ?? current.description,
    harnesses,
    skills,
    revision: current.revision + 1,
    revision_hash: "",
    parent_revision_hash: current.revision_hash,
    updated_at: timestamp,
  };
  next.revision_hash = canonicalRevisionHash(next);
  if (next.revision_hash === current.revision_hash) return current;
  persistManifestRevision(next, options);
  return next;
}

export function listSkillSetRevisions(
  setId: string,
  options: SkillSetServiceOptions = {},
): SkillSetManifest[] {
  const directory = revisionsDir(setId, options);
  if (!existsSync(directory)) return [getSkillSet(setId, options)];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const stored = decodeStoredSkillSetManifest(
        JSON.parse(readFileSync(join(directory, entry), "utf8")),
      );
      return resolveManifest(stored, options);
    })
    .toSorted((left, right) => right.revision - left.revision);
}

export function deriveSkillSetFromProject(
  input: {
    name: string;
    description?: string;
    project_root: string;
    harnesses: ReadonlyArray<string>;
  },
  options: SkillSetServiceOptions = {},
): SkillSetManifest {
  const inspection = inspectProjectSkillSet(input.project_root, input.harnesses);
  return createSkillSet(
    {
      name: input.name,
      description: input.description,
      harnesses: inspection.harnesses,
      skills: inspection.skills,
    },
    options,
  );
}

function humanizeProjectName(projectRoot: string): string {
  const words = basename(projectRoot)
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(" ");
}

export function inspectProjectSkillSet(
  projectRootInput: string,
  requestedHarnesses: ReadonlyArray<string> = [],
): ProjectSkillSetInspection {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(resolve(projectRootInput));
  } catch {
    throw new CLIError(
      `Project folder was not found: ${resolve(projectRootInput)}`,
      "FILE_NOT_FOUND",
      "Choose an existing project folder and try again.",
    );
  }
  const candidates =
    requestedHarnesses.length > 0
      ? decodeSkillSetHarnesses(requestedHarnesses)
      : [...SUPPORTED_SKILL_SET_HARNESSES];
  const byName = new Map<string, SkillSetSkillInput & { hash: string }>();
  const detectedHarnesses: SkillSetHarnessId[] = [];
  for (const harness of candidates) {
    const registry = targetRegistryPath(projectRoot, harness);
    if (!existsSync(registry)) continue;
    let detected = false;
    for (const entry of readdirSync(registry, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const packagePath = join(registry, entry.name);
      const hash = computeSkillVersionHash(join(packagePath, "SKILL.md"));
      if (!hash) continue;
      detected = true;
      const existing = byName.get(entry.name);
      if (existing && existing.hash !== hash) {
        throw new CLIError(
          `Project harnesses contain conflicting revisions of "${entry.name}".`,
          "GUARD_BLOCKED",
          "Choose one revision before deriving the Skill Set.",
        );
      }
      byName.set(entry.name, { name: entry.name, package_path: packagePath, hash });
    }
    if (detected) detectedHarnesses.push(harness);
  }
  if (byName.size === 0) {
    throw new CLIError("No project-scoped skills were found.", "FILE_NOT_FOUND");
  }
  return {
    project_root: projectRoot,
    default_name: humanizeProjectName(projectRoot),
    harnesses: detectedHarnesses,
    skills: [...byName.values()]
      .map(({ name, package_path }) => ({ name, package_path }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

export function captureSkillSetFromProject(
  input: {
    readonly project_root: string;
    readonly name?: string;
    readonly description?: string;
    readonly harnesses?: ReadonlyArray<string>;
  },
  options: SkillSetServiceOptions = {},
): SkillSetManifest {
  const inspection = inspectProjectSkillSet(input.project_root, input.harnesses);
  const name = input.name?.trim() || inspection.default_name;
  const description = input.description?.trim() ?? "";
  const setId = slugifySetId(name);
  const existingPath = manifestPath(setId, options);
  if (existsSync(existingPath)) {
    const existing = getSkillSet(setId, options);
    const requestedSkills = inspection.skills
      .map((skill) => ({
        name: skill.name,
        content_hash: computeSkillVersionHash(join(skill.package_path, "SKILL.md")),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const existingSkills = existing.skills
      .map((skill) => ({ name: skill.name, content_hash: skill.content_hash }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const sameHarnesses =
      existing.harnesses.toSorted().join("\0") === inspection.harnesses.toSorted().join("\0");
    if (
      existing.name === name &&
      existing.description === description &&
      sameHarnesses &&
      JSON.stringify(existingSkills) === JSON.stringify(requestedSkills)
    ) {
      return existing;
    }
    throw new CLIError(
      `Skill Set "${name}" already exists with different contents.`,
      "GUARD_BLOCKED",
      "Choose a different name with --name, or update the existing Skill Set explicitly.",
    );
  }
  return createSkillSet(
    {
      name,
      description,
      harnesses: inspection.harnesses,
      skills: inspection.skills,
    },
    options,
  );
}

export function exportPortableSkillSet(
  setId: string,
  projectRoot: string,
  options: SkillSetServiceOptions & { outputPath?: string } = {},
): string {
  const manifest = getSkillSet(setId, options);
  const outputPath = resolve(
    options.outputPath ?? join(resolve(projectRoot), ".selftune", "skill-set.json"),
  );
  atomicWriteJson(outputPath, toStoredManifest(manifest));
  return outputPath;
}

export function importPortableSkillSet(
  portablePath: string,
  options: SkillSetServiceOptions & {
    allowMissingDependencies?: boolean;
    preserveExisting?: boolean;
  } = {},
): SkillSetManifest {
  const stored = decodeStoredSkillSetManifest(
    JSON.parse(readFileSync(resolve(portablePath), "utf8")),
  );
  const manifest = resolveManifest(stored, options);
  if (canonicalRevisionHash(manifest) !== manifest.revision_hash) {
    throw new CLIError("Portable Skill Set revision hash is invalid.", "GUARD_BLOCKED");
  }
  if (!options.allowMissingDependencies) {
    for (const skill of manifest.skills) {
      if (
        !existsSync(skill.library_package_path) ||
        computeSkillVersionHash(join(skill.library_package_path, "SKILL.md")) !== skill.content_hash
      ) {
        throw new CLIError(
          `Pinned revision for "${skill.name}" is not available locally.`,
          "FILE_NOT_FOUND",
          "Run Sync & Backup, then import the manifest again.",
        );
      }
    }
  }
  const existingPath = manifestPath(manifest.set_id, options);
  if (existsSync(existingPath)) {
    const existing = getSkillSet(manifest.set_id, options);
    if (existing.revision_hash === manifest.revision_hash) return existing;
    if (options.preserveExisting) return existing;
  }
  persistManifestRevision(manifest, options);
  return manifest;
}

export function getSkillSet(setId: string, options: SkillSetServiceOptions = {}): SkillSetManifest {
  const path = manifestPath(setId, options);
  if (!existsSync(path)) {
    throw new CLIError(`Skill Set "${setId}" was not found.`, "FILE_NOT_FOUND");
  }
  try {
    const stored = decodeStoredSkillSetManifest(JSON.parse(readFileSync(path, "utf8")));
    if (stored.set_id !== setId) {
      throw new Error("invalid manifest");
    }
    return resolveManifest(stored, options);
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError(`Skill Set "${setId}" has an invalid manifest.`, "OPERATION_FAILED");
  }
}

export function listMissingSkillSetDependencies(
  setId: string,
  options: SkillSetServiceOptions = {},
): SkillSetSkillReference[] {
  const manifest = getSkillSet(setId, options);
  return manifest.skills.filter((skill) => {
    const skillPath = join(skill.library_package_path, "SKILL.md");
    if (!existsSync(skillPath)) return true;
    if (computeSkillVersionHash(skillPath) !== skill.content_hash) {
      throw new CLIError(
        `The cached Library revision for "${skill.name}" failed verification.`,
        "GUARD_BLOCKED",
        `Remove the corrupted cache entry at ${skill.library_package_path}, then apply the Skill Set again.`,
        2,
      );
    }
    return false;
  });
}

export function listSkillSets(options: SkillSetServiceOptions = {}): SkillSetManifest[] {
  const directory = skillSetsDir(options);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => getSkillSet(basename(entry, ".json"), options))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
