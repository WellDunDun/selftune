import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { Effect } from "effect";
import * as Schema from "effect/Schema";

import {
  loadGitHubArchive,
  loadGitHubTree,
  resolveTrackedSkillSources,
  sourceFolderPath,
  sourceSubtreeHash,
  type GitHubTree,
  type SkillSourceMetadataOptions,
  type TrackedSkillSource,
} from "./skill-source-metadata.js";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "./utils/skill-discovery.js";

const WritableSkillLock = Schema.Struct({
  version: Schema.Number,
  skills: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});

export type SkillSourceUpdateLocalState = "clean" | "modified" | "unverifiable";
export type SkillSourceUpdateStrategy = "abort" | "take_upstream";

export interface SkillSourceUpdateLocation {
  package_path: string;
  skill_path: string;
  scope: InstalledSkillPackage["skill_scope"];
  project_root: string | null;
  canonical_target: string;
  local_state: SkillSourceUpdateLocalState;
  reason: string;
}

export interface SkillSourceUpdatePreview {
  skill_name: string;
  source: string;
  source_url: string | null;
  installed_hash: string;
  latest_hash: string;
  status: "available" | "current";
  locations: SkillSourceUpdateLocation[];
  conflicts: number;
  can_apply: boolean;
}

export interface SkillSourceUpdateReceiptOperation {
  target_path: string;
  observed_paths: string[];
  backup_path: string;
}

export interface SkillSourceUpdateReceipt {
  schema_version: 1;
  receipt_id: string;
  skill_name: string;
  source: string;
  previous_hash: string;
  installed_hash: string;
  status: "applying" | "applied" | "failed";
  strategy: SkillSourceUpdateStrategy;
  operations: SkillSourceUpdateReceiptOperation[];
  applied_at: string;
}

export interface SkillSourceUpdateOptions extends SkillSourceMetadataOptions {
  searchDirs?: string[];
  configRoot?: string;
  archiveLoader?: (source: string, ref: string | null) => Promise<Buffer | null>;
}

export class SkillSourceUpdateFailure extends Schema.TaggedErrorClass<SkillSourceUpdateFailure>()(
  "SkillSourceUpdateFailure",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

interface CandidateInstall {
  installed: InstalledSkillPackage;
  tracked: TrackedSkillSource;
}

interface FileTreeComparison {
  state: SkillSourceUpdateLocalState;
  reason: string;
}

function failure(code: string, message: string): SkillSourceUpdateFailure {
  return SkillSourceUpdateFailure.make({ code, message });
}

function toFailure(error: unknown): SkillSourceUpdateFailure {
  return error instanceof SkillSourceUpdateFailure
    ? error
    : failure("UPDATE_FAILED", error instanceof Error ? error.message : "Skill update failed.");
}

function configRoot(options: SkillSourceUpdateOptions): string {
  const homeDir = resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir());
  return resolve(options.configRoot ?? join(homeDir, ".selftune"));
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
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

function comparePackageToTree(
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

function sourceIdentity(candidate: CandidateInstall): string {
  const entry = candidate.tracked.entry;
  return JSON.stringify([
    entry.source,
    entry.ref ?? null,
    entry.skillPath ? sourceFolderPath(entry.skillPath) : null,
    entry.skillFolderHash ?? null,
  ]);
}

function findCandidates(skillName: string, options: SkillSourceUpdateOptions): CandidateInstall[] {
  const homeDir = options.homeDir ?? process.env.SELFTUNE_HOME ?? process.env.HOME ?? "";
  const installed = findInstalledSkillPackages(
    options.searchDirs ?? getDefaultSkillSearchDirs(process.cwd(), homeDir),
    homeDir,
  ).filter((skill) => skill.name.toLowerCase() === skillName.trim().toLowerCase());
  if (installed.length === 0) {
    throw failure("SKILL_NOT_FOUND", `No installed skill named ${skillName} was found.`);
  }
  const tracked = resolveTrackedSkillSources(installed, options);
  const candidates = installed.flatMap((skill) => {
    const source = tracked.get(skill.skill_path);
    return source ? [{ installed: skill, tracked: source }] : [];
  });
  if (candidates.length === 0) {
    throw failure("SOURCE_UNTRACKED", `${skillName} is not backed by a skills lockfile.`);
  }
  if (
    candidates.some(
      ({ tracked: { entry } }) =>
        entry.sourceType !== "github" || !entry.skillPath || !entry.skillFolderHash,
    )
  ) {
    throw failure(
      "SOURCE_UNSUPPORTED",
      "Only GitHub skills with a recorded folder revision can be updated.",
    );
  }
  if (new Set(candidates.map(sourceIdentity)).size !== 1) {
    throw failure(
      "SOURCE_AMBIGUOUS",
      "Installed locations point at different sources or revisions. Update them separately.",
    );
  }
  return candidates;
}

function canonicalTarget(packagePath: string): string {
  return lstatSync(packagePath).isSymbolicLink() ? realpathSync(packagePath) : resolve(packagePath);
}

async function previewUnsafe(
  skillName: string,
  options: SkillSourceUpdateOptions,
): Promise<SkillSourceUpdatePreview> {
  const candidates = findCandidates(skillName, options);
  const first = candidates[0];
  if (!first) throw failure("SKILL_NOT_FOUND", `No installed skill named ${skillName} was found.`);
  const entry = first.tracked.entry;
  const installedHash = entry.skillFolderHash;
  const skillPath = entry.skillPath;
  if (!installedHash || !skillPath) {
    throw failure("SOURCE_UNSUPPORTED", "The source lock does not contain a folder revision.");
  }
  const [latestTree, installedTree] = await Promise.all([
    loadGitHubTree(entry.source, entry.ref ?? null, options),
    loadGitHubTree(entry.source, installedHash, options),
  ]);
  const latestHash = latestTree ? sourceSubtreeHash(latestTree, skillPath) : null;
  if (!latestHash) {
    throw failure("SOURCE_UNAVAILABLE", "The latest upstream revision could not be loaded.");
  }

  const comparisons = new Map<string, FileTreeComparison>();
  const locations = candidates.map(({ installed }) => {
    const target = canonicalTarget(installed.package_path);
    let comparison = comparisons.get(target);
    if (!comparison) {
      comparison = comparePackageToTree(target, installedTree);
      comparisons.set(target, comparison);
    }
    return {
      package_path: installed.package_path,
      skill_path: installed.skill_path,
      scope: installed.skill_scope,
      project_root: installed.skill_project_root ?? null,
      canonical_target: target,
      local_state: comparison.state,
      reason: comparison.reason,
    };
  });
  const conflicts = locations.filter((location) => location.local_state !== "clean").length;
  const status = installedHash === latestHash ? "current" : "available";
  return {
    skill_name: first.installed.name,
    source: entry.source,
    source_url: entry.sourceUrl ?? null,
    installed_hash: installedHash,
    latest_hash: latestHash,
    status,
    locations,
    conflicts,
    can_apply: status === "available" && conflicts === 0,
  };
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

function extractSkillPackage(archive: Buffer, skillPath: string, root: string): string {
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

function replaceFromStage(source: string, target: string): void {
  const stage = join(dirname(target), `.${basename(target)}.selftune-stage-${randomUUID()}`);
  const rollback = join(dirname(target), `.${basename(target)}.selftune-rollback-${randomUUID()}`);
  cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
  try {
    renameSync(target, rollback);
    try {
      renameSync(stage, target);
      rmSync(rollback, { recursive: true, force: true });
    } catch (error) {
      renameSync(rollback, target);
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function updateLockFiles(
  candidates: CandidateInstall[],
  latestHash: string,
  updatedAt: string,
): void {
  const lockKeys = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const keys = lockKeys.get(candidate.tracked.lockPath) ?? new Set<string>();
    keys.add(candidate.tracked.lockKey);
    lockKeys.set(candidate.tracked.lockPath, keys);
  }
  for (const [lockPath, keys] of lockKeys) {
    let lock: typeof WritableSkillLock.Type;
    try {
      lock = Schema.decodeUnknownSync(WritableSkillLock)(
        JSON.parse(readFileSync(lockPath, "utf8")),
      );
    } catch {
      throw failure("LOCK_INVALID", `The source lock could not be read: ${lockPath}`);
    }
    const skills: Record<string, Record<string, unknown>> = { ...lock.skills };
    for (const key of keys) {
      const entry = skills[key];
      if (!entry) throw failure("LOCK_INVALID", `The source lock no longer contains ${key}.`);
      skills[key] = {
        ...entry,
        skillFolderHash: latestHash,
        updatedAt,
      };
    }
    atomicWriteJson(lockPath, { ...lock, skills });
  }
}

async function applyUnsafe(
  skillName: string,
  strategy: SkillSourceUpdateStrategy,
  options: SkillSourceUpdateOptions,
): Promise<SkillSourceUpdateReceipt> {
  const preview = await previewUnsafe(skillName, options);
  if (preview.status === "current") {
    throw failure("ALREADY_CURRENT", `${preview.skill_name} is already up to date.`);
  }
  if (preview.conflicts > 0 && strategy === "abort") {
    throw failure(
      "LOCAL_CHANGES",
      "Local changes were detected. Keep the local version or explicitly replace it with upstream.",
    );
  }
  const candidates = findCandidates(skillName, options);
  const first = candidates[0];
  const skillPath = first?.tracked.entry.skillPath;
  if (!first || !skillPath)
    throw failure("SOURCE_UNSUPPORTED", "The source package is incomplete.");
  const archive = await (
    options.archiveLoader ?? ((source, ref) => loadGitHubArchive(source, ref, options))
  )(first.tracked.entry.source, first.tracked.entry.ref ?? null);
  if (!archive)
    throw failure("SOURCE_UNAVAILABLE", "The upstream archive could not be downloaded.");

  mkdirSync(configRoot(options), { recursive: true });
  const temporaryRoot = mkdtempSync(join(configRoot(options), "skill-update-stage-"));
  const receiptId = randomUUID();
  const receiptRoot = join(configRoot(options), "skill-update-receipts", receiptId);
  const receiptPath = join(receiptRoot, "receipt.json");
  const originalLocks = new Map<string, string>();
  const targets = new Map<string, string[]>();
  for (const location of preview.locations) {
    const paths = targets.get(location.canonical_target) ?? [];
    paths.push(location.package_path);
    targets.set(location.canonical_target, paths);
  }
  const operations = [...targets.entries()].map(([target, observedPaths], index) => ({
    target_path: target,
    observed_paths: observedPaths,
    backup_path: join(receiptRoot, "backups", `${index}-${basename(target)}`),
  }));
  const receipt: SkillSourceUpdateReceipt = {
    schema_version: 1,
    receipt_id: receiptId,
    skill_name: preview.skill_name,
    source: preview.source,
    previous_hash: preview.installed_hash,
    installed_hash: preview.latest_hash,
    status: "applying",
    strategy,
    operations,
    applied_at: new Date(options.now ?? Date.now()).toISOString(),
  };

  try {
    mkdirSync(receiptRoot, { recursive: true });
    const upstreamPackage = extractSkillPackage(archive, skillPath, temporaryRoot);
    const latestTree = await loadGitHubTree(
      first.tracked.entry.source,
      preview.latest_hash,
      options,
    );
    const stagedComparison = comparePackageToTree(upstreamPackage, latestTree);
    if (stagedComparison.state !== "clean") {
      throw failure(
        "SOURCE_CHANGED",
        "The downloaded package did not match the previewed upstream revision. Preview again.",
      );
    }
    for (const candidate of candidates) {
      const lockPath = candidate.tracked.lockPath;
      if (!originalLocks.has(lockPath)) originalLocks.set(lockPath, readFileSync(lockPath, "utf8"));
    }
    for (const operation of operations) {
      mkdirSync(dirname(operation.backup_path), { recursive: true });
      cpSync(operation.target_path, operation.backup_path, { recursive: true });
    }
    atomicWriteJson(receiptPath, receipt);
    for (const operation of operations) {
      replaceFromStage(upstreamPackage, operation.target_path);
    }
    updateLockFiles(candidates, preview.latest_hash, receipt.applied_at);
    rmSync(options.updateCachePath ?? join(configRoot(options), "cache", "skill-updates-v1.json"), {
      force: true,
    });
    const appliedReceipt = { ...receipt, status: "applied" as const };
    atomicWriteJson(receiptPath, appliedReceipt);
    return appliedReceipt;
  } catch (error) {
    for (const operation of operations) {
      if (!existsSync(operation.backup_path)) continue;
      rmSync(operation.target_path, { recursive: true, force: true });
      cpSync(operation.backup_path, operation.target_path, { recursive: true });
    }
    for (const [lockPath, contents] of originalLocks) writeFileSync(lockPath, contents);
    if (existsSync(receiptPath)) atomicWriteJson(receiptPath, { ...receipt, status: "failed" });
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export const previewSkillSourceUpdateEffect = Effect.fn("SkillSourceUpdate.preview")(function* (
  skillName: string,
  options: SkillSourceUpdateOptions = {},
) {
  return yield* Effect.tryPromise({
    try: () => previewUnsafe(skillName, options),
    catch: toFailure,
  });
});

export const applySkillSourceUpdateEffect = Effect.fn("SkillSourceUpdate.apply")(function* (
  skillName: string,
  strategy: SkillSourceUpdateStrategy,
  options: SkillSourceUpdateOptions = {},
) {
  return yield* Effect.tryPromise({
    try: () => applyUnsafe(skillName, strategy, options),
    catch: toFailure,
  });
});

export function previewSkillSourceUpdate(
  skillName: string,
  options: SkillSourceUpdateOptions = {},
): Promise<SkillSourceUpdatePreview> {
  return Effect.runPromise(previewSkillSourceUpdateEffect(skillName, options));
}

export function applySkillSourceUpdate(
  skillName: string,
  strategy: SkillSourceUpdateStrategy,
  options: SkillSourceUpdateOptions = {},
): Promise<SkillSourceUpdateReceipt> {
  return Effect.runPromise(applySkillSourceUpdateEffect(skillName, strategy, options));
}
