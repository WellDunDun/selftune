import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import { CLIError } from "./utils/cli-error.js";
import { computeSkillVersionHash } from "./utils/skill-discovery.js";

export type SkillSetHarnessId = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export interface SkillSetSkillInput {
  name: string;
  package_path: string;
}

export interface CreateSkillSetInput {
  name: string;
  description?: string;
  harnesses: SkillSetHarnessId[];
  skills: SkillSetSkillInput[];
}

export interface UpdateSkillSetInput extends CreateSkillSetInput {
  set_id: string;
  parent_revision_hash: string;
}

export interface SkillSetSkillReference {
  name: string;
  content_hash: string;
  library_package_path: string;
}

export interface SkillSetManifest {
  schema_version: 1;
  set_id: string;
  name: string;
  description: string;
  harnesses: SkillSetHarnessId[];
  skills: SkillSetSkillReference[];
  revision: number;
  revision_hash: string;
  parent_revision_hash: string | null;
  created_at: string;
  updated_at: string;
}

export type SkillSetPlanAction = "create" | "unchanged" | "conflict";

export interface SkillSetPlanOperation {
  harness: SkillSetHarnessId;
  skill_name: string;
  content_hash: string;
  source_path: string;
  target_path: string;
  action: SkillSetPlanAction;
  reason: string;
}

export interface SkillSetPlan {
  set_id: string;
  set_name: string;
  set_revision_hash: string;
  project_root: string;
  operations: SkillSetPlanOperation[];
  creates: number;
  unchanged: number;
  conflicts: number;
}

export type SkillSetMaterializationStrategy = "symlink" | "copy";

export interface SkillSetReceiptOperation {
  harness: SkillSetHarnessId;
  skill_name: string;
  content_hash: string;
  source_path: string;
  target_path: string;
  strategy: SkillSetMaterializationStrategy | null;
  state?: "pending" | "materialized";
  target_device?: string;
  target_inode?: string;
  target_ctime_ns?: string;
}

export interface SkillSetReceipt {
  schema_version: 1;
  receipt_id: string;
  set_id: string;
  set_name: string;
  set_revision_hash: string;
  project_root: string;
  status: "applying" | "applied" | "unchanged" | "rolled_back";
  operations: SkillSetReceiptOperation[];
  applied_at: string;
  rolled_back_at: string | null;
}

export interface SkillSetServiceOptions {
  configRoot?: string;
  now?: Date;
}

interface StoredSkillSetManifest extends Omit<SkillSetManifest, "skills"> {
  skills: Array<Omit<SkillSetSkillReference, "library_package_path">>;
}

function configRoot(options: SkillSetServiceOptions): string {
  return resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
}

function skillSetsDir(options: SkillSetServiceOptions): string {
  return join(configRoot(options), "skill-sets");
}

function libraryPackagesDir(options: SkillSetServiceOptions): string {
  return join(configRoot(options), "library", "packages");
}

function receiptsDir(options: SkillSetServiceOptions): string {
  return join(configRoot(options), "skill-set-receipts");
}

function revisionsDir(setId: string, options: SkillSetServiceOptions): string {
  return join(configRoot(options), "skill-set-history", assertSafeSegment(setId, "Skill Set ID"));
}

function assertSafeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new CLIError(
      `${label} must contain only letters, numbers, dots, underscores, and hyphens.`,
      "INVALID_FLAG",
    );
  }
  return trimmed;
}

function slugifySetId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return assertSafeSegment(slug, "Skill Set name");
}

function manifestPath(setId: string, options: SkillSetServiceOptions): string {
  return join(skillSetsDir(options), `${assertSafeSegment(setId, "Skill Set ID")}.json`);
}

function libraryPackagePath(
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

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function canonicalRevisionHash(
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

function persistManifestRevision(
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
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertImmutablePackageTree(rootPath: string, label: string): void {
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

function cacheSkillPackage(
  input: SkillSetSkillInput,
  options: SkillSetServiceOptions,
): SkillSetSkillReference {
  if (!input || typeof input.name !== "string" || typeof input.package_path !== "string") {
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

function toStoredManifest(manifest: SkillSetManifest): StoredSkillSetManifest {
  return {
    ...manifest,
    skills: manifest.skills.map(({ library_package_path: _path, ...skill }) => skill),
  };
}

function resolveManifest(
  stored: StoredSkillSetManifest,
  options: SkillSetServiceOptions,
): SkillSetManifest {
  const base = {
    ...stored,
    skills: stored.skills.map((skill) => ({
      ...skill,
      library_package_path: libraryPackagePath(skill.content_hash, skill.name, options),
    })),
  } as SkillSetManifest;
  const revisionHash = stored.revision_hash || canonicalRevisionHash(base);
  return {
    ...base,
    revision: stored.revision ?? 1,
    revision_hash: revisionHash,
    parent_revision_hash: stored.parent_revision_hash ?? null,
  };
}

export function createSkillSet(
  input: CreateSkillSetInput,
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

  const harnesses = [...new Set(input.harnesses)];
  const supportedHarnesses = new Set<SkillSetHarnessId>([
    "codex",
    "claude_code",
    "opencode",
    "openclaw",
    "pi",
  ]);
  for (const harness of harnesses) {
    if (!supportedHarnesses.has(harness)) {
      throw new CLIError(`Unsupported Skill Set harness: ${harness}`, "INVALID_FLAG");
    }
  }

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
  input: Omit<CreateSkillSetInput, "name"> & {
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
  const supportedHarnesses = new Set<SkillSetHarnessId>([
    "codex",
    "claude_code",
    "opencode",
    "openclaw",
    "pi",
  ]);
  for (const harness of input.harnesses) {
    if (!supportedHarnesses.has(harness)) {
      throw new CLIError(`Unsupported Skill Set harness: ${harness}`, "INVALID_FLAG");
    }
  }
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
    harnesses: [...new Set(input.harnesses)],
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
      const stored = JSON.parse(
        readFileSync(join(directory, entry), "utf8"),
      ) as StoredSkillSetManifest;
      return resolveManifest(stored, options);
    })
    .toSorted((left, right) => right.revision - left.revision);
}

export function deriveSkillSetFromProject(
  input: {
    name: string;
    description?: string;
    project_root: string;
    harnesses: SkillSetHarnessId[];
  },
  options: SkillSetServiceOptions = {},
): SkillSetManifest {
  const projectRoot = realpathSync(resolve(input.project_root));
  const byName = new Map<string, SkillSetSkillInput & { hash: string }>();
  for (const harness of input.harnesses) {
    const registry = targetRegistryPath(projectRoot, harness);
    if (!existsSync(registry)) continue;
    for (const entry of readdirSync(registry, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const packagePath = join(registry, entry.name);
      const hash = computeSkillVersionHash(join(packagePath, "SKILL.md"));
      if (!hash) continue;
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
  }
  if (byName.size === 0) {
    throw new CLIError("No project-scoped skills were found.", "FILE_NOT_FOUND");
  }
  return createSkillSet(
    {
      name: input.name,
      description: input.description,
      harnesses: input.harnesses,
      skills: [...byName.values()].map(({ name, package_path }) => ({ name, package_path })),
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
  options: SkillSetServiceOptions = {},
): SkillSetManifest {
  const stored = JSON.parse(readFileSync(resolve(portablePath), "utf8")) as StoredSkillSetManifest;
  const manifest = resolveManifest(stored, options);
  if (canonicalRevisionHash(manifest) !== manifest.revision_hash) {
    throw new CLIError("Portable Skill Set revision hash is invalid.", "GUARD_BLOCKED");
  }
  for (const skill of manifest.skills) {
    if (
      !existsSync(skill.library_package_path) ||
      computeSkillVersionHash(join(skill.library_package_path, "SKILL.md")) !== skill.content_hash
    ) {
      throw new CLIError(
        `Pinned revision for "${skill.name}" is not available locally.`,
        "FILE_NOT_FOUND",
        "Restore or sync the Remote Library, then import the manifest again.",
      );
    }
  }
  const existingPath = manifestPath(manifest.set_id, options);
  if (existsSync(existingPath)) {
    const existing = getSkillSet(manifest.set_id, options);
    if (existing.revision_hash === manifest.revision_hash) return existing;
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
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredSkillSetManifest;
    if (stored.schema_version !== 1 || stored.set_id !== setId || !Array.isArray(stored.skills)) {
      throw new Error("invalid manifest");
    }
    return resolveManifest(stored, options);
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError(`Skill Set "${setId}" has an invalid manifest.`, "OPERATION_FAILED");
  }
}

function targetRegistryPath(projectRoot: string, harness: SkillSetHarnessId): string {
  const relativeRegistry: Record<SkillSetHarnessId, string[]> = {
    codex: [".agents", "skills"],
    claude_code: [".claude", "skills"],
    opencode: [".opencode", "skills"],
    openclaw: [".openclaw", "skills"],
    pi: [".pi", "agent", "skills"],
  };
  return join(projectRoot, ...relativeRegistry[harness]);
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function assertProjectTargetContained(projectRoot: string, targetPath: string): void {
  if (!isContainedPath(projectRoot, targetPath)) {
    throw new CLIError(`Skill Set target escapes the project root: ${targetPath}`, "GUARD_BLOCKED");
  }

  let existingAncestor = dirname(targetPath);
  while (!entryExists(existingAncestor) && existingAncestor !== projectRoot) {
    existingAncestor = dirname(existingAncestor);
  }
  let resolvedAncestor: string;
  try {
    resolvedAncestor = realpathSync(existingAncestor);
  } catch {
    throw new CLIError(
      `Skill Set target has an unreadable or broken ancestor: ${existingAncestor}`,
      "GUARD_BLOCKED",
    );
  }
  if (!isContainedPath(projectRoot, resolvedAncestor)) {
    throw new CLIError(
      `Skill Set target is redirected outside the project: ${existingAncestor}`,
      "GUARD_BLOCKED",
      "Replace the external registry link or choose a different project.",
    );
  }
}

export function planSkillSet(
  input: { set_id: string; project_root: string },
  options: SkillSetServiceOptions = {},
): SkillSetPlan {
  if (!input || typeof input.set_id !== "string" || !input.set_id.trim()) {
    throw new CLIError("Skill Set ID is required.", "MISSING_FLAG");
  }
  if (typeof input.project_root !== "string" || !input.project_root.trim()) {
    throw new CLIError("Project root is required.", "MISSING_FLAG");
  }
  const manifest = getSkillSet(input.set_id.trim(), options);
  const requestedProjectRoot = resolve(input.project_root.trim());
  if (!existsSync(requestedProjectRoot) || !statSync(requestedProjectRoot).isDirectory()) {
    throw new CLIError(
      `Project directory was not found: ${requestedProjectRoot}`,
      "FILE_NOT_FOUND",
    );
  }
  const projectRoot = realpathSync(requestedProjectRoot);
  const operations: SkillSetPlanOperation[] = [];

  for (const harness of manifest.harnesses) {
    const registryPath = targetRegistryPath(projectRoot, harness);
    for (const skill of manifest.skills) {
      const targetPath = join(registryPath, skill.name);
      assertProjectTargetContained(projectRoot, targetPath);
      let action: SkillSetPlanAction = "create";
      let reason = "The pinned Library revision will be linked into this project.";
      if (entryExists(targetPath)) {
        const existingHash = computeSkillVersionHash(join(targetPath, "SKILL.md"));
        if (existingHash === skill.content_hash) {
          action = "unchanged";
          reason = "The project already contains the pinned revision.";
        } else {
          action = "conflict";
          reason = "The destination contains a different package revision.";
        }
      }
      operations.push({
        harness,
        skill_name: skill.name,
        content_hash: skill.content_hash,
        source_path: skill.library_package_path,
        target_path: targetPath,
        action,
        reason,
      });
    }
  }

  return {
    set_id: manifest.set_id,
    set_name: manifest.name,
    set_revision_hash: manifest.revision_hash,
    project_root: projectRoot,
    operations,
    creates: operations.filter((operation) => operation.action === "create").length,
    unchanged: operations.filter((operation) => operation.action === "unchanged").length,
    conflicts: operations.filter((operation) => operation.action === "conflict").length,
  };
}

export function listSkillSets(options: SkillSetServiceOptions = {}): SkillSetManifest[] {
  const directory = skillSetsDir(options);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => getSkillSet(basename(entry, ".json"), options))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function receiptPath(receiptId: string, options: SkillSetServiceOptions): string {
  return join(receiptsDir(options), `${assertSafeSegment(receiptId, "Skill Set receipt ID")}.json`);
}

function readReceipt(receiptId: string, options: SkillSetServiceOptions): SkillSetReceipt {
  const path = receiptPath(receiptId, options);
  if (!existsSync(path)) {
    throw new CLIError(`Skill Set receipt "${receiptId}" was not found.`, "FILE_NOT_FOUND");
  }
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as SkillSetReceipt;
    if (
      receipt.schema_version !== 1 ||
      receipt.receipt_id !== receiptId ||
      !Array.isArray(receipt.operations)
    ) {
      throw new Error("invalid receipt");
    }
    return receipt;
  } catch {
    throw new CLIError(`Skill Set receipt "${receiptId}" is invalid.`, "OPERATION_FAILED");
  }
}

function pendingReceiptOperation(operation: SkillSetPlanOperation): SkillSetReceiptOperation {
  return {
    harness: operation.harness,
    skill_name: operation.skill_name,
    content_hash: operation.content_hash,
    source_path: operation.source_path,
    target_path: operation.target_path,
    strategy: null,
    state: "pending",
  };
}

function materializeOperation(
  operation: SkillSetPlanOperation,
  projectRoot: string,
): SkillSetReceiptOperation {
  const receiptOperation = {
    harness: operation.harness,
    skill_name: operation.skill_name,
    content_hash: operation.content_hash,
    source_path: operation.source_path,
    target_path: operation.target_path,
  };
  assertProjectTargetContained(projectRoot, operation.target_path);
  mkdirSync(dirname(operation.target_path), { recursive: true });
  assertProjectTargetContained(projectRoot, operation.target_path);
  if (entryExists(operation.target_path)) {
    throw new Error(`Materialization target appeared after preview: ${operation.target_path}`);
  }
  try {
    symlinkSync(operation.source_path, operation.target_path, "dir");
    return {
      ...receiptOperation,
      strategy: "symlink",
      state: "materialized",
      ...materializationIdentity(operation.target_path),
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (!new Set(["EPERM", "EACCES", "ENOTSUP", "EINVAL"]).has(String(code))) {
      throw error;
    }
  }

  cpSync(operation.source_path, operation.target_path, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  const copiedHash = computeSkillVersionHash(join(operation.target_path, "SKILL.md"));
  if (copiedHash !== operation.content_hash) {
    rmSync(operation.target_path, { recursive: true, force: true });
    throw new Error(`Materialized copy hash mismatch for "${operation.skill_name}".`);
  }
  return {
    ...receiptOperation,
    strategy: "copy",
    state: "materialized",
    ...materializationIdentity(operation.target_path),
  };
}

function materializationIdentity(targetPath: string): {
  target_device: string;
  target_inode: string;
  target_ctime_ns: string;
} {
  const stats = lstatSync(targetPath, { bigint: true });
  return {
    target_device: stats.dev.toString(),
    target_inode: stats.ino.toString(),
    target_ctime_ns: stats.ctimeNs.toString(),
  };
}

export function applySkillSet(
  input: { set_id: string; project_root: string },
  options: SkillSetServiceOptions = {},
): SkillSetReceipt {
  const plan = planSkillSet(input, options);
  if (plan.conflicts > 0) {
    const firstConflict = plan.operations.find((operation) => operation.action === "conflict")!;
    throw new CLIError(
      `Skill Set apply is blocked by ${plan.conflicts} destination conflict${plan.conflicts === 1 ? "" : "s"}.`,
      "GUARD_BLOCKED",
      `Resolve or archive the package at ${firstConflict.target_path}, then preview again.`,
      2,
    );
  }

  const createOperations = plan.operations.filter((operation) => operation.action === "create");
  for (const operation of createOperations) {
    const currentHash = computeSkillVersionHash(join(operation.source_path, "SKILL.md"));
    if (currentHash !== operation.content_hash) {
      throw new CLIError(
        `The cached Library revision for "${operation.skill_name}" failed verification.`,
        "GUARD_BLOCKED",
        "Re-import the skill package before applying this Skill Set.",
        2,
      );
    }
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const receipt: SkillSetReceipt = {
    schema_version: 1,
    receipt_id: randomUUID(),
    set_id: plan.set_id,
    set_name: plan.set_name,
    set_revision_hash: getSkillSet(plan.set_id, options).revision_hash,
    project_root: plan.project_root,
    status: createOperations.length > 0 ? "applying" : "unchanged",
    operations: [],
    applied_at: timestamp,
    rolled_back_at: null,
  };
  atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);

  try {
    for (const operation of createOperations) {
      const operationIndex = receipt.operations.push(pendingReceiptOperation(operation)) - 1;
      atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
      receipt.operations[operationIndex] = materializeOperation(operation, plan.project_root);
      atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
    }
  } catch (error) {
    let cleanupComplete = true;
    for (const operation of receipt.operations.toReversed()) {
      try {
        const ownedPath = receiptOwnedPath(operation);
        if (ownedPath) rmSync(ownedPath, { recursive: true, force: true });
      } catch {
        cleanupComplete = false;
      }
    }
    if (cleanupComplete) {
      receipt.status = "rolled_back";
      receipt.rolled_back_at = (options.now ?? new Date()).toISOString();
    }
    atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
    throw new CLIError(
      `Skill Set apply failed: ${error instanceof Error ? error.message : String(error)}`,
      "OPERATION_FAILED",
      `Run selftune sets plan --set ${plan.set_id} --project ${plan.project_root} before retrying.`,
    );
  }

  receipt.status = createOperations.length > 0 ? "applied" : "unchanged";
  atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
  return receipt;
}

function resolvesToSource(targetPath: string, sourcePath: string): boolean {
  try {
    const link = readlinkSync(targetPath);
    return resolve(dirname(targetPath), link) === resolve(sourcePath);
  } catch {
    return false;
  }
}

function receiptOwnedPath(operation: SkillSetReceiptOperation): string | null {
  if (!entryExists(operation.target_path)) {
    if (operation.state === "pending") return null;
    throw new CLIError(
      `Rollback target is already missing: ${operation.target_path}`,
      "GUARD_BLOCKED",
      "Inspect the project before changing this receipt.",
      2,
    );
  }
  if (operation.target_device && operation.target_inode) {
    const identity = materializationIdentity(operation.target_path);
    if (
      identity.target_device !== operation.target_device ||
      identity.target_inode !== operation.target_inode ||
      (operation.target_ctime_ns !== undefined &&
        identity.target_ctime_ns !== operation.target_ctime_ns)
    ) {
      throw new CLIError(
        `Rollback target was replaced after SelfTune created it: ${operation.target_path}`,
        "GUARD_BLOCKED",
        "Keep the replacement package and resolve the receipt manually.",
        2,
      );
    }
  }
  if (operation.strategy === "symlink") {
    if (!lstatSync(operation.target_path).isSymbolicLink()) {
      throw new CLIError(
        `Rollback target is no longer the link created by SelfTune: ${operation.target_path}`,
        "GUARD_BLOCKED",
        "Keep the replacement package and resolve the receipt manually.",
        2,
      );
    }
    if (!resolvesToSource(operation.target_path, operation.source_path)) {
      throw new CLIError(
        `Rollback target now points to a different package: ${operation.target_path}`,
        "GUARD_BLOCKED",
        "Keep the replacement link and resolve the receipt manually.",
        2,
      );
    }
    return operation.target_path;
  }

  const currentHash = computeSkillVersionHash(join(operation.target_path, "SKILL.md"));
  if (currentHash !== operation.content_hash) {
    throw new CLIError(
      `Rollback target has changed since SelfTune copied it: ${operation.target_path}`,
      "GUARD_BLOCKED",
      "Keep the edited package and resolve the receipt manually.",
      2,
    );
  }
  return operation.target_path;
}

export function rollbackSkillSet(
  receiptId: string,
  options: SkillSetServiceOptions = {},
): SkillSetReceipt {
  const receipt = readReceipt(receiptId, options);
  if (receipt.status === "rolled_back") return receipt;

  const ownedPaths = receipt.operations.map(receiptOwnedPath);
  for (const ownedPath of ownedPaths.toReversed()) {
    if (ownedPath) rmSync(ownedPath, { recursive: true, force: false });
  }

  const rolledBack: SkillSetReceipt = {
    ...receipt,
    status: "rolled_back",
    rolled_back_at: (options.now ?? new Date()).toISOString(),
  };
  atomicWriteJson(receiptPath(receiptId, options), rolledBack);
  return rolledBack;
}

export function listSkillSetReceipts(options: SkillSetServiceOptions = {}): SkillSetReceipt[] {
  const directory = receiptsDir(options);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readReceipt(basename(entry, ".json"), options))
    .toSorted((left, right) => right.applied_at.localeCompare(left.applied_at));
}
